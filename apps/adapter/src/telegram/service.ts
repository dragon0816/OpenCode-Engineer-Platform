import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { BiScheduler } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import { ChatService } from '../http/chat.ts';
import { WebStore } from '../runs/web-store.ts';
import { TelegramInbox } from './inbox.ts';
import { TelegramApi, TelegramPoller } from './poller.ts';
import { TelegramRouter } from './router.ts';

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

export function startTelegram(root: string, runtime: Runtime, enabledForLaunch: boolean) {
  const [main, bi, owner] = enabledForLaunch ? settings() : [];
  const validToken = (value: string | undefined): value is string => Boolean(value && /^\d+:[\w-]+$/.test(value));
  const enabled = Boolean(owner && /^[1-9]\d+$/.test(owner) && !(main && bi && main.split(':')[0] === bi.split(':')[0]));
  const redact = (value: string) => [main, bi, owner].reduce((text, secret) => secret ? text.replaceAll(secret, '[已遮蔽]') : text, value);
  const inbox = new TelegramInbox(join(root, 'telegram.sqlite'));
  inbox.db.exec('CREATE TABLE IF NOT EXISTS telegram_binding(bot TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)');
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
  const chat = new ChatService(sessions, runtime, root, join(runtime.root, 'telegram-turns.jsonl'), () => {});
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

  function tick() {
    try {
      scheduler?.reconcile();
      const ready = inbox.db.prepare("SELECT id FROM bi_sources WHERE state='ready'").all();
      for (const row of ready) router.stage(Number(row.id));
      knowledge?.reconcileBi();
      if (biApi) inbox.notifyReviews(knowledge?.reconciliation().intents ?? []);
    } catch { /* Persisted work remains available to the next cycle. */ }
    for (const poller of pollers) {
      if (!active.has(poller.bot)) {
        const run = poller.step(stop.signal).catch(() => {}).finally(() => active.delete(poller.bot));
        active.set(poller.bot, run);
      }
    }
  }

  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    status() {
      return {
        main: Boolean(mainApi), bi: Boolean(biApi),
        domain: router.config('domain'), origins: JSON.parse(router.config('origins') || '[]'),
        sources: inbox.db.prepare('SELECT id,ref,state,reason,domain,bytes IS NOT NULL AS hasFile FROM bi_sources ORDER BY id DESC LIMIT 200').all(),
        delivery: inbox.db.prepare('SELECT bot,state,COUNT(*) AS count FROM outbox GROUP BY bot,state').all(),
        unresolvedDelivery: inbox.db.prepare(`SELECT bot,id,state,attempts FROM outbox
          WHERE state IN ('indeterminate','failed') ORDER BY rowid DESC LIMIT 200`).all(),
        jobs: knowledge?.biStatus() ?? [],
        ...scheduler?.list(),
      };
    },
    source(id: number) {
      return inbox.db.prepare('SELECT bytes FROM bi_sources WHERE id=?').get(id)?.bytes as Uint8Array | undefined;
    },
    action(input: Record<string, unknown>) {
      switch (input.action) {
        case 'configure': router.configure(input.domain, input.origins); break;
        case 'supplement': router.supplement(Number(input.id), input.text); break;
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
