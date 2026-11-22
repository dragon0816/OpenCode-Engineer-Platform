import type { Bot, Intake, Lane, TelegramInbox, Update } from './inbox.ts';
import { telegramBatch } from './inbox.ts';
import { legacyBinding } from './channel-migration.ts';
import type { Binding, ChannelLocale, ChannelTransport, Delivery, OutboundMessage } from '../channels/transport.ts';
import { channelText } from '../channels/catalog.ts';

export const workDeadline = 120_000;
export const maxWorkAttempts = 20;
const retryInterval = 6000;
const pollSeconds = 25;
const maxResponseBytes = 8 * 1024 * 1024;

async function boundedBody(response: Response, limit: number) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw new Error('Telegram response exceeds limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.length;
      if (size > limit) throw new Error('Telegram response exceeds limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

class TelegramError extends Error {
  readonly status: number;
  readonly retryAfter: number;

  constructor(status: number, retryAfter = 0) {
    super('Telegram request failed');
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class TelegramApi {
  private readonly token: string;
  private readonly base: string;
  private readonly timeout: number;

  constructor(token: string, base = 'https://api.telegram.org', timeout = 12_000) {
    this.token = token;
    this.base = base;
    this.timeout = timeout;
  }

  async call<T>(method: string, body: object, stop: AbortSignal): Promise<T> {
    try {
      const response = await fetch(this.base + '/bot' + this.token + '/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.any([stop, AbortSignal.timeout(method === 'getUpdates' ? 35_000 : this.timeout)]),
      });
      const data = JSON.parse((await boundedBody(response, maxResponseBytes)).toString('utf8'));
      if (!response.ok || data.ok !== true) {
        const retry = data.parameters?.retry_after;
        throw new TelegramError(response.ok ? Number(data.error_code) : response.status,
          Number.isSafeInteger(retry) && retry > 0 ? retry : 0);
      }
      return data.result as T;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(0);
    }
  }

  async file(id: string, limit: number, stop: AbortSignal) {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: id }, stop);
    if (!file.file_path || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(file.file_path) ||
        file.file_path.endsWith('/..') || Number(file.file_size) > limit) throw new Error('Telegram file unavailable');
    try {
      const response = await fetch(this.base + '/file/bot' + this.token + '/' + file.file_path, {
        redirect: 'error', signal: AbortSignal.any([stop, AbortSignal.timeout(12_000)]),
      });
      if (!response.ok) throw new Error('File unavailable');
      return await boundedBody(response, limit);
    } catch { throw new Error('Telegram file unavailable'); }
  }
}

export class TelegramTransport implements ChannelTransport {
  private readonly bot: Bot;
  private readonly owner: string;
  private readonly api: TelegramApi;
  private readonly legacy: boolean;

  constructor(bot: Bot, owner: string, api: TelegramApi, legacy = true) {
    this.bot = bot;
    this.owner = owner;
    this.api = api;
    this.legacy = legacy;
  }

  async verifyAccount(signal: AbortSignal) {
    const user = await this.api.call<{ id: number; is_bot: boolean; username?: string }>('getMe', {}, signal);
    if (!Number.isSafeInteger(user?.id) || user.id < 1 || user.is_bot !== true) throw new Error('Telegram account is invalid');
    const botName = typeof user.username === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(user.username) ? '@' + user.username : undefined;
    return { identity: String(user.id), botName, capabilities: ['receive', 'text', 'attachment'] as const };
  }

  async receive(checkpoint: string, signal: AbortSignal, clock: () => number) {
    const updates = await this.api.call<Update[]>('getUpdates', {
      offset: Number(checkpoint || 0), timeout: pollSeconds, allowed_updates: ['message'],
    }, signal);
    signal.throwIfAborted();
    return telegramBatch(this.bot, this.owner, updates, checkpoint, clock(), this.legacy);
  }

  fetchAttachment(reference: string, limit: number, signal: AbortSignal) {
    return this.api.file(reference, limit, signal);
  }

  async deliver(message: OutboundMessage, signal: AbortSignal, attempts: number, clock: () => number): Promise<Delivery> {
    const key = this.legacy ? message.conversationKey :
      message.conversationKey.startsWith(`chat:${this.owner}:`) ? message.conversationKey.slice(`chat:${this.owner}:`.length) : '';
    if (!/^topic:(0|[1-9]\d*)$/.test(key)) {
      return { state: 'failed', reasonCode: 'invalid-destination' };
    }
    const topic = Number(key.slice('topic:'.length));
    if (!Number.isSafeInteger(topic)) return { state: 'failed', reasonCode: 'invalid-destination' };
    try {
      const result = await this.api.call<{ message_id?: number }>('sendMessage', {
        chat_id: this.owner, text: message.text.slice(0, 4000), ...(topic ? { message_thread_id: topic } : {}),
      }, signal);
      return { state: 'sent', receipt: Number.isSafeInteger(result?.message_id) ? String(result.message_id) : undefined };
    } catch (error) {
      if (!(error instanceof TelegramError) || error.status === 0 || error.status >= 500) {
        return { state: 'indeterminate', reasonCode: 'unknown-delivery' };
      }
      if (error.status === 429) return { state: 'pending', retryAt: clock() + delay(error, attempts) };
      return { state: 'failed', reasonCode: 'delivery-rejected' };
    }
  }
}

type ReceiveBatch = Awaited<ReturnType<ChannelTransport['receive']>>;
type PollBinding = {
  binding: Binding;
  legacy: boolean;
  admit(batch: ReceiveBatch, checkpoint: string, now: number): void;
};

export class TelegramPoller {
  private pollDue = 0;
  private failures = 0;
  private polling = false;
  private sending = false;
  private readonly lanes = new Set<Lane>();
  private readonly handlers = new Set<Promise<string | undefined>>();
  pollConflict = false;

  readonly bot: Bot;
  private readonly transport: ChannelTransport;
  private readonly inbox: TelegramInbox;
  private readonly handle: (row: Intake, signal: AbortSignal) => Promise<string | undefined>;
  private readonly locale: () => ChannelLocale;
  private readonly account?: PollBinding;

  constructor(bot: Bot, owner: string, api: TelegramApi, inbox: TelegramInbox, handle: TelegramPoller['handle'],
    locale: () => ChannelLocale = () => 'zh-TW', account?: PollBinding) {
    this.bot = bot;
    this.transport = new TelegramTransport(bot, owner, api, account?.legacy);
    this.inbox = inbox;
    this.handle = handle;
    this.locale = locale;
    this.account = account;
  }

  busy() { return this.sending || this.lanes.size > 0 || this.handlers.size > 0; }

  async poll(signal: AbortSignal, clock = Date.now) {
    if (this.polling || this.pollConflict || signal.aborted || clock() < this.pollDue) return;
    this.polling = true;
    try {
      const binding = this.account?.binding ?? legacyBinding(this.bot);
      const checkpoint = this.inbox.checkpoint(binding.accountId);
      const batch = await this.transport.receive(checkpoint, signal, clock);
      if (this.account) this.account.admit(batch, checkpoint, clock());
      else this.inbox.admitBatch(binding, batch.events, batch.nextCheckpoint, clock(), checkpoint);
      this.failures = 0;
    } catch (error) {
      if (error instanceof TelegramError && error.status === 409) this.pollConflict = true;
      else this.pollDue = clock() + delay(error, ++this.failures);
    } finally {
      this.polling = false;
    }
  }

  async process(lane: Lane, signal: AbortSignal, clock = Date.now) {
    if (this.lanes.has(lane) || signal.aborted) return;
    const now = clock();
    const row = this.account
      ? this.inbox.nextBound(this.bot, this.account.binding, lane, now)
      : this.inbox.next(this.bot, lane, now);
    if (!row) return;
    const locale = this.locale();
    const deadline = (row.started ?? now) + workDeadline;
    const fail = () => this.inbox.complete(row, channelText(locale).deadline(row.id), true, locale);
    if (now >= deadline || row.attempts >= maxWorkAttempts) { fail(); return; }
    this.lanes.add(lane);
    try {
      this.inbox.attempt(row, now, Math.min(deadline, now + retryInterval));
      const budget = AbortSignal.timeout(deadline - now);
      const attemptSignal = AbortSignal.any([signal, budget]);
      let result: string | undefined;
      let release!: () => void;
      const interrupted = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
      attemptSignal.addEventListener('abort', release, { once: true });
      try {
        const handling = Promise.resolve(this.handle(row, attemptSignal));
        this.handlers.add(handling);
        void handling.then(() => this.handlers.delete(handling), () => this.handlers.delete(handling));
        result = await Promise.race([handling, interrupted]);
      }
      catch { /* The persisted attempt and retry time cover handler failures and restarts. */ }
      finally { attemptSignal.removeEventListener('abort', release); }
      if (signal.aborted) return;
      if (budget.aborted || clock() >= deadline) fail();
      else if (result !== undefined) this.inbox.complete(row, result, false, locale);
      else if (row.attempts + 1 >= maxWorkAttempts) fail();
    } finally {
      this.lanes.delete(lane);
    }
  }

  async deliver(signal: AbortSignal, clock = Date.now) {
    if (this.sending || signal.aborted || clock() < this.pollDue) return;
    this.sending = true;
    try { await this.send(signal, clock); }
    finally { this.sending = false; }
  }

  private async send(signal: AbortSignal, clock: () => number) {
    const message = this.inbox.claimOutbound(this.account ? { accountId: this.account.binding.accountId } : legacyBinding(this.bot), clock());
    if (message) this.inbox.finishOutbound(message, await this.transport.deliver(message, signal, message.attempts, clock));
  }
}

function delay(error: unknown, attempts: number) {
  return Math.max(1000 * 2 ** Math.min(8, attempts - 1), error instanceof TelegramError ? 1000 * error.retryAfter : 0);
}
