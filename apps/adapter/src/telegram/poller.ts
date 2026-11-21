import type { Bot, Intake, TelegramInbox, Update } from './inbox.ts';

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
        redirect: 'error', signal: AbortSignal.any([stop, AbortSignal.timeout(this.timeout)]),
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
  private busy = false;

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

  async step(signal: AbortSignal, now = Date.now()) {
    if (this.busy || signal.aborted) return;
    this.busy = true;
    try {
      if (now >= this.pollDue) {
        try {
          const updates = await this.api.call<Update[]>('getUpdates', {
            offset: this.inbox.offset(this.bot), timeout: 0, allowed_updates: ['message'],
          }, signal);
          this.inbox.admit(this.bot, this.owner, updates);
          this.failures = 0;
        } catch (error) {
          this.pollDue = now + delay(error, ++this.failures);
        }
      }
      if (signal.aborted) return;
      const row = this.inbox.pending(this.bot);
      try {
        if (row) {
          const result = await this.handle(row, signal);
          if (result !== undefined) this.inbox.complete(row, result);
        }
      } finally {
        if (!signal.aborted && now >= this.pollDue) await this.send(signal, now);
      }
    } finally {
      this.busy = false;
    }
  }

  private async send(signal: AbortSignal, now: number) {
    const db = this.inbox.db;
    const row = db.prepare(`UPDATE outbox SET state='sending', attempts=attempts+1 WHERE bot=? AND id=(
      SELECT id FROM outbox WHERE bot=? AND state='pending' ORDER BY rowid LIMIT 1)
      AND due<=? RETURNING id, topic, text, attempts`).get(this.bot, this.bot, now);
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
        due = now + delay(error, Number(row.attempts));
      } else state = 'failed';
    }
    db.prepare("UPDATE outbox SET state=?,due=? WHERE bot=? AND id=? AND state='sending'")
      .run(state, due, this.bot, row.id);
  }
}

function delay(error: unknown, attempts: number) {
  return Math.max(1000 * 2 ** Math.min(8, attempts - 1), error instanceof TelegramError ? 1000 * error.retryAfter : 0);
}
