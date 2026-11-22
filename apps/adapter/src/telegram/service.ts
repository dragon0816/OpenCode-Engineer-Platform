import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { BiScheduler } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import { ChatService } from '../http/chat.ts';
import { WebStore } from '../runs/web-store.ts';
import type { Dispatcher } from '../runs/dispatcher.ts';
import type { DelegationService } from '../runs/delegation.ts';
import { TelegramInbox } from './inbox.ts';
import { TelegramAccounts } from './accounts.ts';
import type { TelegramEnvironment } from './accounts.ts';
import { TelegramRouter } from './router.ts';
import { verifyChannelConversations } from './channel-migration.ts';
import { openBiReviewStore, verifyBiSourceReceipts } from '../bi/source-ownership.ts';
import { dispatchBi } from '../bi/dispatch.ts';
import { dispatchTelegram } from './dispatch.ts';

export function startTelegram(root: string, runtime: Runtime, enabledForLaunch: boolean, ledger: WebStore, dispatcher: Dispatcher,
  environment?: TelegramEnvironment, delegations?: DelegationService) {
  const inbox = new TelegramInbox(join(root, 'telegram.sqlite'));
  let sessions: WebStore | undefined;
  try {
    sessions = new WebStore(join(root, 'telegram-chat.sqlite'));
    using sessionDb = new DatabaseSync(join(root, 'telegram-chat.sqlite'), { readOnly: true });
    using reviewDb = openBiReviewStore(root);
    verifyChannelConversations(inbox.db, sessionDb);
    verifyBiSourceReceipts(inbox.db, reviewDb);
  } catch (error) {
    sessions?.close();
    inbox.db.close();
    throw error;
  }
  const chat = new ChatService(sessions, runtime, root, join(runtime.root, 'telegram-turns.jsonl'), () => {}, ledger, dispatcher, delegations);
  const stop = new AbortController();
  const accounts: TelegramAccounts = new TelegramAccounts(ledger, inbox, sessions, enabledForLaunch, stop.signal,
    (row, now, deadline) => inbound.handoff(row, now, deadline), environment);
  const router: TelegramRouter = new TelegramRouter(inbox, runtime, chat, sessions, undefined, (id) => ledger.channelLocale(id),
    (id) => accounts.connections.get(id)?.client, () => {
      const model = ledger.executionProfile('bi', 'bi')?.defaultModel;
      return model && runtime.aliases.includes(model) ? model : undefined;
    });
  const inbound = dispatchTelegram(dispatcher, inbox, chat, router, accounts, (id) => ledger.channelLocale(id), runtime.redact);
  const knowledge = runtime.knowledge?.reviewStore;
  const bi = dispatchBi(dispatcher, router.bi, knowledge, runtime.knowledge?.propose);
  const scheduler = knowledge && new BiScheduler(inbox.db, knowledge, bi.occurrence,
    (schedule) => dispatcher.items.scheduleOccupied(schedule));
  const active = new Map<string, Promise<void>>();
  function launch(id: string, work: () => Promise<void>) {
    if (active.has(id)) return;
    const task = work().catch(() => {}).finally(() => active.delete(id));
    active.set(id, task);
  }

  function tick() {
    try {
      inbound.reconcile();
      scheduler?.reconcile();
      const ready = inbox.db.prepare(`SELECT s.id,o.work_id FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
        WHERE s.state='ready' AND (s.supplement IS NOT NULL OR o.work_id IS NOT NULL) ORDER BY s.id`).all();
      for (const row of ready) bi.recoverSource(Number(row.id), row.work_id);
      bi.recoverJobs();
      if (accounts.connections.has('telegram-bi')) inbox.notifyReviews(knowledge?.reconciliation().intents ?? [], ledger.channelLocale('bi'));
    } catch { /* Persisted work remains available to the next cycle. */ }
    accounts.refresh(launch);
    for (const [id, { poller, stop: connection }] of accounts.connections) {
      const signal = AbortSignal.any([stop.signal, connection.signal]);
      launch(id + '-poll', () => poller.poll(signal));
      launch(id + '-work', () => poller.process('work', signal));
      launch(id + '-command', () => poller.process('command', signal));
      launch(id + '-send', () => poller.deliver(signal));
    }
  }

  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    delegationBi: router.bi,
    pauseForRestart() {
      if (chat.busy() || [...active.keys()].some((id) => !id.endsWith('-poll'))) return false;
      clearInterval(timer);
      return true;
    },
    configured: () => accounts.connections.size > 0,
    runBi: (id: string, candidate?: Candidate, signal?: AbortSignal) => bi.run(id, candidate, signal),
    reviewBi: bi.review,
    channels: () => accounts.list(),
    configureChannel: (input: Record<string, unknown>, createAgent?: () => void) => accounts.configure(input, createAgent),
    agentStatus(id: string) {
      const status = sessions.agentStatus(id);
      if (status === 'busy' || inbox.db.prepare("SELECT 1 FROM channel_inbound WHERE agent_id=? AND status='handed_off' LIMIT 1").get(id)) {
        return 'busy';
      }
      return status === 'queued' || inbox.db.prepare("SELECT 1 FROM channel_inbound WHERE agent_id=? AND status='pending' LIMIT 1").get(id)
        ? 'queued' : 'available';
    },
    status() {
      return {
        main: accounts.connections.has('telegram-main'), bi: accounts.connections.has('telegram-bi'),
        pollConflicts: [...accounts.connections].filter(([, { poller }]) => poller.pollConflict).map(([id]) => id.slice(9)),
        domain: router.bi.config('domain'), origins: JSON.parse(router.bi.config('origins') || '[]'), target: router.bi.config('target'),
        sources: inbox.db.prepare('SELECT id,ref,state,reason,domain,target,bytes IS NOT NULL AS hasFile FROM bi_sources ORDER BY id DESC LIMIT 200').all(),
        delivery: inbox.db.prepare(`SELECT substr(account_id,10) AS bot,state,COUNT(*) AS count
          FROM channel_outbound GROUP BY account_id,state`).all(),
        unresolvedDelivery: inbox.db.prepare(`SELECT substr(account_id,10) AS bot,effect_key AS id,state,attempts
          FROM channel_outbound WHERE state IN ('indeterminate','failed') ORDER BY rowid DESC LIMIT 200`).all(),
        failedIntakes: inbox.db.prepare(`SELECT substr(account_id,10) AS bot,CAST(event_key AS INTEGER) AS id,attempts,
          received_at AS firstSeen FROM channel_inbound WHERE status='failed' ORDER BY received_at DESC LIMIT 200`).all(),
        jobs: knowledge?.biStatus() ?? [],
        ...scheduler?.list(),
      };
    },
    source(id: number) {
      return inbox.db.prepare('SELECT bytes FROM bi_sources WHERE id=?').get(id)?.bytes as Uint8Array | undefined;
    },
    action(input: Record<string, unknown>) {
      switch (input.action) {
        case 'configure': router.bi.configure(input.domain, input.origins, input.target); break;
        case 'supplement': return bi.supplement(Number(input.id), input.text, stop.signal);
        case 'resend': inbox.resend(input.bot, input.id); break;
        case 'schedule': scheduler?.save(String(input.id), String(input.zone), String(input.time), input.candidate as Candidate); break;
        case 'state': scheduler?.state(String(input.id), input.state); break;
        case 'runNow': {
          if (!scheduler) break;
          const job = scheduler.runNow(String(input.id));
          return bi.runOccurrence(job, stop.signal).then(() => scheduler.reconcile());
        }
        case 'runJob': return knowledge && bi.run(String(input.id), undefined, stop.signal);
        case 'immediate': return bi.run(String(input.id), input.candidate as Candidate, stop.signal);
        default: throw new Error('Unknown job action');
      }
    },
    async close() {
      clearInterval(timer);
      stop.abort();
      await Promise.all([chat.close(), ...active.values()]);
      sessions.close();
      inbox.db.close();
    },
  };
}
