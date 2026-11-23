import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { biInboxSchedule, BiScheduler } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import { ChatService, publicSession } from '../http/chat.ts';
import { HttpError } from '../http/errors.ts';
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
import type { ScheduledPipeline } from '../bi/service.ts';
import { dispatchTelegram } from './dispatch.ts';
import { delegationNotices } from './delegation-notices.ts';

export function startTelegram(root: string, runtime: Runtime, enabledForLaunch: boolean, ledger: WebStore, dispatcher: Dispatcher,
  environment?: TelegramEnvironment, delegations?: DelegationService, pipeline?: ScheduledPipeline, clock = Date.now) {
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
    }, (id) => ledger.agentModelSource(id) !== 'gateway');
  const inbound = dispatchTelegram(dispatcher, inbox, chat, router, accounts, (id) => ledger.channelLocale(id), runtime.redact);
  const knowledge = runtime.knowledge?.reviewStore;
  const notices = delegationNotices(inbox, ledger, sessions, runtime.redact);
  const bi = dispatchBi(dispatcher, router.bi, knowledge, runtime.knowledge?.propose, pipeline);
  const scheduler = knowledge && new BiScheduler(inbox.db, knowledge, bi.occurrence,
    (schedule) => dispatcher.items.scheduleOccupied(schedule));
  router.bi.scheduledTarget = () => scheduler?.inbox()?.target;
  const active = new Map<string, Promise<void>>();
  function launch(id: string, work: () => Promise<void>) {
    if (active.has(id)) return;
    const task = work().catch(() => {}).finally(() => active.delete(id));
    active.set(id, task);
  }

  function tick() {
    try {
      inbound.reconcile();
      scheduler?.reconcile(clock());
      const ready = inbox.db.prepare(`SELECT s.id,o.work_id FROM bi_sources s JOIN bi_source_ownership o ON o.source_id=s.id
        WHERE s.state='ready' AND (s.supplement IS NOT NULL OR o.work_id IS NOT NULL) ORDER BY s.id`).all();
      for (const row of ready) bi.recoverSource(Number(row.id), row.work_id);
      bi.recoverJobs();
      notices.results();
      const intents = knowledge?.publicationIntents() ?? [];
      if (accounts.connections.has('telegram-bi')) inbox.notifyReviews(intents, ledger.channelLocale('bi'));
      notices.publications(intents);
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
    approvedBiOrigins: (): string[] => JSON.parse(router.bi.config('origins') || '[]'),
    runBi: (id: string, candidate?: Candidate, signal?: AbortSignal) => bi.run(id, candidate, signal),
    reviewBi: bi.review,
    inboxSchedule: {
      status: () => scheduler?.inbox() ?? null,
      save(vault: string, zone: string, time: string) {
        if (!scheduler) throw new Error('BI schedule unavailable');
        const now = clock();
        scheduler.save(biInboxSchedule, zone, time, { kind: 'bi-inbox', target: vault }, now);
        scheduler.state(biInboxSchedule, 'active', now);
        return scheduler.inbox();
      },
      state(value: unknown) {
        if (!scheduler || value !== 'paused' && value !== 'active') throw new Error('BI schedule unavailable');
        scheduler.state(biInboxSchedule, value, clock());
        return scheduler.inbox();
      },
    },
    channels: () => accounts.list(),
    configureChannel: (input: Record<string, unknown>, browser: string, createAgent?: () => void) => accounts.configure(input, browser, createAgent),
    archiveAgent: (id: string, revision: number, status: string) => accounts.archiveAgent(id, revision, status),
    async archivedHistory(agentId: string, sessionId?: string) {
      const owned = sessions.sessions(false, sessionId).filter((session) => {
        const owner = sessions.sessionOwner(session);
        return owner?.origin === 'channel' && owner.agentID === agentId;
      });
      if (!sessionId) return { sessions: owned.map(publicSession) };
      const session = owned[0];
      if (!session) throw new HttpError(404, 'session-not-found');
      const state = await chat.state(session, true);
      if (!state.messages) throw new HttpError(503, 'session-unavailable');
      return { messages: state.messages.map(({ role, text, createdAt }) => ({ role, text, createdAt })) };
    },
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
          const job = scheduler.runNow(String(input.id), clock());
          return bi.runOccurrence(job, stop.signal).then(() => scheduler.reconcile(clock()));
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
