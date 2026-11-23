import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.ts';
import type { TelegramApi } from './poller.ts';
import type { Update } from './inbox.ts';

const setupDuration = 5 * 60_000;
export const validOwner = (owner: string | undefined): owner is string =>
  Boolean(owner && /^[1-9]\d*$/.test(owner) && Number.isSafeInteger(Number(owner)));
export const validToken = (value: string) => value.length <= 256 && /^\d+:[\w-]+$/.test(value);

type Candidate = { id: string; name: string };
export type VerifiedBot = { client: TelegramApi; value: string; identity: string; fingerprint: string; botName?: string };
type Setup = VerifiedBot & { id: string; browser: string; accountId?: string; revision?: number; replacing: boolean; expires: number;
  started: number; owner?: string; candidate?: Candidate; offset: number; checking?: Promise<void> };

export class TelegramSetup {
  private readonly pending = new Map<string, Setup>();

  expire(now = Date.now()) {
    for (const [id, setup] of this.pending) if (setup.expires <= now) this.pending.delete(id);
  }

  start(bot: VerifiedBot, browser: string, owner: string | undefined, started: number, replacing: boolean, accountId?: string, revision?: number) {
    this.expire();
    for (const [id, setup] of this.pending) {
      if (setup.identity === bot.identity) this.pending.delete(id);
    }
    if (this.pending.size >= 16) this.pending.delete(this.pending.keys().next().value!);
    const setup: Setup = { ...bot, id: randomUUID(), browser, owner, accountId, revision, started, replacing,
      expires: Date.now() + setupDuration, offset: 0 };
    this.pending.set(setup.id, setup);
    return this.view(setup);
  }

  get(id: unknown, browser: string) {
    this.expire();
    const setup = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!setup || setup.browser !== browser) throw new HttpError(409, 'channel-setup-expired');
    return setup;
  }

  cancel(id: unknown, browser: string) {
    this.pending.delete(this.get(id, browser).id);
  }

  private view(setup: Setup) {
    return { setupId: setup.id, botName: setup.botName, ownerRequired: !setup.owner, ownerName: setup.candidate?.name };
  }

  async check(id: unknown, browser: string, signal: AbortSignal) {
    const setup = this.get(id, browser);
    if (!setup.owner && !setup.candidate) {
      setup.checking ??= this.capture(setup, signal).finally(() => { setup.checking = undefined; });
      await setup.checking;
    }
    return this.view(this.get(id, browser));
  }

  private async capture(setup: Setup, signal: AbortSignal) {
    try {
      const updates = await setup.client.call<Update[]>('getUpdates', {
        offset: setup.offset, timeout: 0, allowed_updates: ['message'],
      }, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
      for (const { update_id: id, message } of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (!Number.isSafeInteger(id) || id < setup.offset || id >= Number.MAX_SAFE_INTEGER) continue;
        setup.offset = id + 1;
        const sender = message?.from;
        if (!message || message.chat?.type !== 'private' || !sender || sender.is_bot !== false ||
            sender.id !== message.chat.id || !validOwner(String(sender.id)) || !Number.isSafeInteger(message.date) ||
            message.date! <= setup.started || message.date! > Math.floor(Date.now() / 1000) + 5 || message.text?.trim() !== '/start') continue;
        const username = typeof sender.username === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(sender.username) ? '@' + sender.username : '';
        const name = [sender.first_name, sender.last_name].filter((part) => typeof part === 'string').join(' ')
          .replaceAll(setup.value, '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 128);
        if (!username && !name) continue;
        setup.candidate = { id: String(sender.id), name: username || name };
        return;
      }
    } catch { throw new HttpError(422, 'channel-verification-failed'); }
  }
}
