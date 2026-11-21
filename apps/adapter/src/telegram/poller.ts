import type { Bot, Intake, Lane, TelegramInbox, Update } from './inbox.ts';

export const workDeadline = 120_000;
export const maxWorkAttempts = 20;
const retryInterval = 6000;
const pollSeconds = 25;

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
      const data = await response.json();
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
      if (!response.ok || !response.body) throw new Error('File unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return Buffer.concat(chunks);
          size += value.length;
          if (size > limit) throw new Error('File exceeds limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch { throw new Error('Telegram file unavailable'); }
  }
}

export class TelegramPoller {
  private pollDue = 0;
  private failures = 0;
  private polling = false;
  private sending = false;
  private readonly lanes = new Set<Lane>();

  readonly bot: Bot;
  private readonly owner: string;
  private readonly api: TelegramApi;
  private readonly inbox: TelegramInbox;
  private readonly handle: (row: Intake, signal: AbortSignal) => Promise<string | undefined>;

  constructor(bot: Bot, owner: string, api: TelegramApi, inbox: TelegramInbox, handle: TelegramPoller['handle']) {
    this.bot = bot;
    this.owner = owner;
    this.api = api;
    this.inbox = inbox;
    this.handle = handle;
  }

  async poll(signal: AbortSignal, clock = Date.now) {
    if (this.polling || signal.aborted || clock() < this.pollDue) return;
    this.polling = true;
    try {
      const updates = await this.api.call<Update[]>('getUpdates', {
        offset: this.inbox.offset(this.bot), timeout: pollSeconds, allowed_updates: ['message'],
      }, signal);
      this.inbox.admit(this.bot, this.owner, updates, clock());
      this.failures = 0;
    } catch (error) {
      this.pollDue = clock() + delay(error, ++this.failures);
    } finally {
      this.polling = false;
    }
  }

  async process(lane: Lane, signal: AbortSignal, clock = Date.now) {
    if (this.lanes.has(lane) || signal.aborted) return;
    const now = clock();
    const row = this.inbox.next(this.bot, lane, now);
    if (!row) return;
    const deadline = (row.started ?? now) + workDeadline;
    const fail = () => this.inbox.complete(row, `更新 ${row.id} 未能在期限內處理。已保留原始收件，請在工作台核對後再試。`, true);
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
      try { result = await Promise.race([this.handle(row, attemptSignal), interrupted]); }
      catch { /* The persisted attempt and retry time cover handler failures and restarts. */ }
      finally { attemptSignal.removeEventListener('abort', release); }
      if (signal.aborted) return;
      if (budget.aborted || clock() >= deadline) fail();
      else if (result !== undefined) this.inbox.complete(row, result);
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
    const db = this.inbox.db;
    const row = db.prepare(`UPDATE outbox SET state='sending', attempts=attempts+1 WHERE bot=? AND id=(
      SELECT id FROM outbox WHERE bot=? AND state='pending' ORDER BY rowid LIMIT 1)
      AND due<=? RETURNING id, topic, text, attempts`).get(this.bot, this.bot, clock());
    if (!row) return;
    let state = 'sent';
    let due = 0;
    try {
      await this.api.call('sendMessage', {
        chat_id: this.owner, text: row.text, ...(row.topic ? { message_thread_id: row.topic } : {}),
      }, signal);
    } catch (error) {
      // An uncertain response can follow successful delivery. Keep it visible for reconciliation.
      if (!(error instanceof TelegramError) || error.status === 0 || error.status >= 500) state = 'indeterminate';
      else if (error.status === 429) {
        state = 'pending';
        due = clock() + delay(error, Number(row.attempts));
      } else state = 'failed';
    }
    db.prepare("UPDATE outbox SET state=?,due=? WHERE bot=? AND id=? AND state='sending'")
      .run(state, due, this.bot, row.id);
  }
}

function delay(error: unknown, attempts: number) {
  return Math.max(1000 * 2 ** Math.min(8, attempts - 1), error instanceof TelegramError ? 1000 * error.retryAfter : 0);
}
