import { channelText, intakeStatus } from '../channels/catalog.ts';
import type { ChannelLocale, Destination } from '../channels/transport.ts';
import type { ChatService } from '../http/chat.ts';
import type { Dispatcher } from '../runs/dispatcher.ts';
import type { WorkItem } from '../runs/work-items.ts';
import type { TelegramAccounts } from './accounts.ts';
import type { Intake, Message, TelegramInbox } from './inbox.ts';
import { turnId } from './router.ts';
import type { TelegramRouter } from './router.ts';

type IntakeKey = { bot: Intake['bot']; id: number; topic: number; destination: Destination };
const kind = 'telegram-inbound';

export function dispatchTelegram(dispatcher: Dispatcher, inbox: TelegramInbox, chat: ChatService, router: TelegramRouter,
  accounts: TelegramAccounts, locale: (agentId: string) => ChannelLocale, redact: (text: string) => string) {
  const envelope = (item: WorkItem) => item.payload.intake as IntakeKey;
  const receipt = (item: WorkItem) => {
    const { destination, id } = envelope(item);
    return inbox.receipt(destination, id, item.id);
  };
  const connection = (item: WorkItem) => {
    const { accountId, bindingRevision, agentId } = envelope(item).destination;
    const live = accounts.connections.get(accountId);
    if (live?.account.bindingRevision === bindingRevision && live.account.agentId === agentId) return live;
  };
  const rowFor = (item: WorkItem, payload = ''): Intake => ({ ...envelope(item), payload });
  const finish = (item: WorkItem, text: string, failed = false) => {
    // The durable reply can be reconstructed before the account has reverified.
    const safe = redact(connection(item)?.redact(text) ?? text).replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, '[已遮蔽]');
    inbox.complete(rowFor(item), safe, failed, locale(item.agentId), item.id);
  };
  const deadline = (item: WorkItem) => finish(item, channelText(locale(item.agentId)).deadline(envelope(item).id), true);

  dispatcher.register(kind, {
    available: (item) => Boolean(connection(item) && receipt(item)?.status === 'handed_off'),
    async execute(item, start, stop) {
      const saved = receipt(item);
      const live = connection(item);
      if (!saved || !live) return { state: 'failed', reason: 'channel-unavailable' };
      const budget = AbortSignal.timeout(Math.max(0, item.expiresAt! - Date.now()));
      const signal = AbortSignal.any([budget, stop, live.stop.signal]);
      if (!item.runId) start();
      let reply: string | undefined;
      try {
        reply = await router.handle(rowFor(item, String(saved.payload)), signal, { id: item.id, start, signal });
      } catch (error) {
        if (!budget.aborted || !item.runId || !await chat.recoverTurn(item)) throw error;
        deadline(item);
        return { state: 'timed_out', reason: 'channel-deadline' };
      }
      if (budget.aborted && reply !== undefined) {
        deadline(item);
        return { state: 'timed_out', reason: 'channel-deadline' };
      }
      if (reply === undefined) {
        if (item.runId) return { state: 'indeterminate', reason: 'channel-turn-unverified' };
        deadline(item);
        return { state: 'failed', reason: 'channel-handler-incomplete' };
      }
      finish(item, reply);
      return { state: 'succeeded' };
    },
    async recover(item) {
      const saved = receipt(item);
      if (saved?.status === 'handled' || saved?.status === 'failed') {
        return { state: saved.status === 'handled' ? 'succeeded' : 'failed' };
      }
      if (item.runId) {
        const outcome = await chat.recoverTurn(item);
        if (outcome && item.state === 'running') {
          const reply = await router.recoveredReply(rowFor(item), AbortSignal.timeout(10_000));
          if (reply !== undefined) {
            finish(item, reply);
            return outcome;
          }
        }
      } else if (item.state === 'running' && typeof item.payload.sourceId === 'number') {
        const state = router.bi.recover(item.payload.sourceId, item.id);
        if (state) {
          finish(item, intakeStatus(locale(item.agentId), item.payload.sourceId, state));
          return { state: 'succeeded' };
        }
      }
    },
    canResolve: (item, outcome) => item.runId ? chat.canResolveTurn(item, outcome) :
      Promise.resolve(outcome !== 'succeeded' || typeof item.payload.sourceId === 'number' &&
        Boolean(router.bi.recover(item.payload.sourceId, item.id))),
    resolved(item, outcome) {
      if (item.runId) chat.resolveTurn(item, outcome);
      if (typeof item.payload.sourceId === 'number' && outcome !== 'succeeded') router.bi.stopUnverified(item.payload.sourceId, item.id);
      if (outcome === 'succeeded') finish(item, channelText(locale(item.agentId)).completed);
      else deadline(item);
    },
    expired: deadline,
  });

  function handoff(row: Intake, now: number, expiresAt: number) {
    const { bot, id, topic, destination } = row;
    if (!destination) throw new Error('Missing verified Telegram binding');
    const text = (JSON.parse(row.payload) as Message).text ?? '';
    const ask = bot === 'main' && /^\/ask(?:\s|$)/.test(text);
    const status = bot === 'bi' && /^\/status(?:\s|$)/.test(text.trim());
    const supplement = bot === 'bi' && /^\/supplement(?:\s|$)/.test(text.trim());
    const sourceId = bot === 'bi' && !status ? supplement ? Number(text.trim().match(/^\/supplement\s+(\d+)\s+/)?.[1]) : id : undefined;
    const run = bot === 'main' && !ask && text.trim()
      ? { store: 'channel' as const, id: turnId(destination.accountId, id) } : undefined;
    const item = dispatcher.enqueue({
      agentId: destination.agentId, source: 'direct', sourceKey: JSON.stringify(['telegram', destination.accountId, id]),
      effectClass: ask || status ? 'verified_read' : 'write', expiresAt, run,
      payload: { kind, intake: { bot, id, topic, destination }, sourceId: Number.isSafeInteger(sourceId) ? sourceId : undefined,
        serialKey: JSON.stringify(['telegram', destination.accountId, destination.conversationKey, destination.bindingRevision]) },
    });
    inbox.handOff(row, item.id, now);
    if (item.state === 'timed_out') deadline(item);
  }

  function reconcile() {
    for (const { id } of inbox.handedOffWork()) {
      const item = dispatcher.items.get(String(id));
      if (!item || item.payload.kind !== kind) continue;
      if (item.state === 'failed' || item.state === 'timed_out' || item.state === 'cancelled') deadline(item);
      else if (item.state === 'succeeded' && item.reasonCode === 'owner-resolved') {
        finish(item, channelText(locale(item.agentId)).completed);
      }
    }
  }

  return { handoff, reconcile };
}
