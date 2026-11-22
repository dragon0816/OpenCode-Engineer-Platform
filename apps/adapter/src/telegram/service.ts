import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { BiScheduler } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import { ChatService } from '../http/chat.ts';
import { WebStore } from '../runs/web-store.ts';
import { TelegramInbox } from './inbox.ts';
import { TelegramApi, TelegramPoller } from './poller.ts';
import { TelegramRouter } from './router.ts';
import { verifyChannelConversations } from './channel-migration.ts';

const names = ['OEP_TELEGRAM_MAIN_BOT_TOKEN', 'OEP_TELEGRAM_BI_BOT_TOKEN', 'OEP_TELEGRAM_ALLOWED_USER_ID'] as const;

function settings() {
  let user: Record<string, string> = {};
  if (process.platform === 'win32' && names.some((name) => !process.env[name])) {
    try {
      const fields = names.map((name) => `'${name}'=[Environment]::GetEnvironmentVariable('${name}','User')`).join(';');
      user = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `@{${fields}} | ConvertTo-Json -Compress`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000,
      }));
    } catch { /* A missing User scope leaves those bots disabled. */ }
  }
  return names.map((name) => (process.env[name] || user[name])?.trim());
}

export function startTelegram(root: string, runtime: Runtime, enabledForLaunch: boolean, ledger: WebStore) {
  const [main, bi, owner] = enabledForLaunch ? settings() : [];
  const validToken = (value: string | undefined): value is string => Boolean(value && /^\d+:[\w-]+$/.test(value));
  const enabled = Boolean(owner && /^[1-9]\d+$/.test(owner) && !(main && bi && main.split(':')[0] === bi.split(':')[0]));
  const redact = (value: string) => [main, bi, owner].reduce((text, secret) => secret ? text.replaceAll(secret, '[已遮蔽]') : text, value);
  const inbox = new TelegramInbox(join(root, 'telegram.sqlite'));
  function bind(bot: string, token: string | undefined) {
    if (!enabled || !validToken(token)) return;
    const fingerprint = createHash('sha256').update(bot + ':' + token.split(':')[0] + ':' + owner).digest('hex');
    inbox.db.prepare('INSERT OR IGNORE INTO telegram_binding VALUES (?,?)').run(bot, fingerprint);
    if (inbox.db.prepare('SELECT fingerprint FROM telegram_binding WHERE bot=?').get(bot)?.fingerprint === fingerprint) {
      return new TelegramApi(token);
    }
  }
  const mainApi = bind('main', main);
  const biApi = bind('bi', bi);
  const sessions = new WebStore(join(root, 'telegram-chat.sqlite'));
  try {
    using sessionDb = new DatabaseSync(join(root, 'telegram-chat.sqlite'), { readOnly: true });
    verifyChannelConversations(inbox.db, sessionDb);
  } catch (error) {
    sessions.close();
    inbox.db.close();
    throw error;
  }
  const chat = new ChatService(sessions, runtime, root, join(runtime.root, 'telegram-turns.jsonl'), () => {}, ledger);
  const router = new TelegramRouter(inbox, runtime, chat, sessions, biApi);
  const knowledge = runtime.knowledge?.reviewStore;
  const scheduler = knowledge && new BiScheduler(inbox.db, knowledge);
  const stop = new AbortController();
  const pollers = [
    ...(mainApi ? [new TelegramPoller('main', owner!, mainApi, inbox, async (row, signal) => {
      const reply = await router.handle(row, signal);
      return reply === undefined ? undefined : redact(reply);
    })] : []),
    ...(biApi ? [new TelegramPoller('bi', owner!, biApi, inbox, async (row, signal) => {
      const reply = await router.handle(row, signal);
      return reply === undefined ? undefined : redact(reply);
    })] : []),
  ];
  const active = new Map<string, Promise<void>>();
  function launch(id: string, work: () => Promise<void>) {
    if (active.has(id)) return;
    const task = work().catch(() => {}).finally(() => active.delete(id));
    active.set(id, task);
  }

  function tick() {
    try {
      scheduler?.reconcile();
      const ready = inbox.db.prepare("SELECT id FROM bi_sources WHERE state='ready' AND supplement IS NOT NULL ORDER BY id LIMIT 1").get();
      if (ready) launch('supplement', () => router.stage(Number(ready.id), stop.signal));
      knowledge?.reconcileBi();
      if (biApi) inbox.notifyReviews(knowledge?.reconciliation().intents ?? []);
    } catch { /* Persisted work remains available to the next cycle. */ }
    for (const poller of pollers) {
      launch(poller.bot + '-poll', () => poller.poll(stop.signal));
      launch(poller.bot + '-work', () => poller.process('work', stop.signal));
      launch(poller.bot + '-command', () => poller.process('command', stop.signal));
      launch(poller.bot + '-send', () => poller.deliver(stop.signal));
    }
  }

  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    pauseForRestart() {
      if (chat.busy() || [...active.keys()].some((id) => !id.endsWith('-poll'))) return false;
      clearInterval(timer);
      return true;
    },
    configured: () => Boolean(mainApi || biApi),
    status() {
      return {
        main: Boolean(mainApi), bi: Boolean(biApi),
        domain: router.config('domain'), origins: JSON.parse(router.config('origins') || '[]'), target: router.config('target'),
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
        case 'configure': router.configure(input.domain, input.origins, input.target); break;
        case 'supplement': return router.supplement(Number(input.id), input.text, stop.signal);
        case 'resend': inbox.resend(input.bot, input.id); break;
        case 'schedule': scheduler?.save(String(input.id), String(input.zone), String(input.time), input.candidate as Candidate); break;
        case 'state': scheduler?.state(String(input.id), input.state); break;
        case 'runNow': scheduler?.runNow(String(input.id)); break;
        case 'runJob': knowledge?.runBi(String(input.id)); break;
        case 'immediate': {
          const id = String(input.id);
          if (!knowledge) throw new Error('Knowledge is unavailable');
          knowledge.enqueueBi(id, input.candidate as Candidate);
          knowledge.runBi(id);
          break;
        }
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
