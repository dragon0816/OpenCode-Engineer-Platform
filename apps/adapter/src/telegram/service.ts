import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { BiScheduler } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import { legacyAllowlistRef, legacyChannels } from '../channels/accounts.ts';
import { ChatService } from '../http/chat.ts';
import { WebStore } from '../runs/web-store.ts';
import { TelegramInbox } from './inbox.ts';
import { TelegramApi, TelegramPoller, TelegramTransport } from './poller.ts';
import { TelegramRouter } from './router.ts';
import { verifyChannelConversations } from './channel-migration.ts';

const names = [legacyAllowlistRef, ...legacyChannels.map(({ credentialRef }) => credentialRef)];

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
  return Object.fromEntries(names.map((name) => [name, (process.env[name] || user[name])?.trim()]));
}

export function startTelegram(root: string, runtime: Runtime, enabledForLaunch: boolean, ledger: WebStore) {
  const credentials = enabledForLaunch ? settings() : {};
  const owner = credentials[legacyAllowlistRef];
  const validToken = (value: string | undefined): value is string => Boolean(value && /^\d+:[\w-]+$/.test(value));
  const redact = (value: string) => Object.values(credentials).reduce((text, secret) =>
    secret ? text.replaceAll(secret, '[已遮蔽]') : text, value);
  const inbox = new TelegramInbox(join(root, 'telegram.sqlite'));
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
  const api = new Map<string, TelegramApi>();
  const router = new TelegramRouter(inbox, runtime, chat, sessions, undefined, (bot) => ledger.channelLocale(bot),
    (bot) => api.get(bot));
  const knowledge = runtime.knowledge?.reviewStore;
  const scheduler = knowledge && new BiScheduler(inbox.db, knowledge);
  const stop = new AbortController();
  const pollers = new Map<string, TelegramPoller>();
  const candidates = legacyChannels.flatMap((config) => {
    const token = credentials[config.credentialRef];
    if (!owner || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner)) || !validToken(token)) return [];
    const id = token.split(':')[0];
    const legacy = createHash('sha256').update(config.bot + ':' + id + ':' + owner).digest('hex');
    const oldFingerprint = inbox.db.prepare('SELECT fingerprint FROM telegram_binding WHERE bot=?').get(config.bot)?.fingerprint;
    if (oldFingerprint && oldFingerprint !== legacy) return [];
    return [{ config, owner, id, legacy, client: new TelegramApi(token), due: 0 }];
  });
  const active = new Map<string, Promise<void>>();
  function launch(id: string, work: () => Promise<void>) {
    if (active.has(id)) return;
    const task = work().catch(() => {}).finally(() => active.delete(id));
    active.set(id, task);
  }

  async function verify(candidate: typeof candidates[number]) {
    const { config, client, owner, id, legacy } = candidate;
    // Retry transient verification failures without reading updates or sending on an unverified bot.
    candidate.due = Date.now() + 30_000;
    const { identity } = await new TelegramTransport(config.bot, owner, client).verifyAccount(stop.signal);
    stop.signal.throwIfAborted();
    if (identity !== id) return;
    const fingerprint = createHash('sha256').update(identity).digest('hex');
    const enabled = ledger.verifyLegacyChannel(config, fingerprint, () => {
      inbox.db.prepare('INSERT OR IGNORE INTO telegram_binding VALUES (?,?)').run(config.bot, legacy);
      return inbox.db.prepare('SELECT fingerprint FROM telegram_binding WHERE bot=?').get(config.bot)?.fingerprint === legacy;
    });
    if (!enabled) return;
    api.set(config.bot, client);
    pollers.set(config.bot, new TelegramPoller(config.bot, owner, client, inbox, async (row, signal) => {
      const reply = await router.handle(row, signal);
      return reply === undefined ? undefined : redact(reply);
    }, () => ledger.channelLocale(config.bot)));
  }

  function tick() {
    try {
      scheduler?.reconcile();
      const ready = inbox.db.prepare("SELECT id FROM bi_sources WHERE state='ready' AND supplement IS NOT NULL ORDER BY id LIMIT 1").get();
      if (ready) launch('supplement', () => router.stage(Number(ready.id), stop.signal));
      knowledge?.reconcileBi();
      if (pollers.has('bi')) inbox.notifyReviews(knowledge?.reconciliation().intents ?? [], ledger.channelLocale('bi'));
    } catch { /* Persisted work remains available to the next cycle. */ }
    for (const candidate of candidates) {
      if (!pollers.has(candidate.config.bot) && Date.now() >= candidate.due) {
        launch(candidate.config.bot + '-verify-poll', () => verify(candidate));
      }
    }
    for (const poller of pollers.values()) {
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
    configured: () => pollers.size > 0,
    status() {
      return {
        main: pollers.has('main'), bi: pollers.has('bi'),
        pollConflicts: [...pollers.values()].filter((poller) => poller.pollConflict).map((poller) => poller.bot),
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
