import { createHash, randomUUID } from 'node:crypto';
import { legacyAllowlistRef, legacyChannels, telegramCredentialRef } from '../channels/accounts.ts';
import type { ChannelAccount, ChannelHandler } from '../channels/accounts.ts';
import { HttpError } from '../http/errors.ts';
import { readUserCredentials } from '../runs/custom-mcp-credentials.ts';
import type { WebStore } from '../runs/web-store.ts';
import type { Intake, TelegramInbox } from './inbox.ts';
import { TelegramApi, TelegramPoller, TelegramTransport } from './poller.ts';

export type TelegramEnvironment = {
  readCredentials(names: string[]): Record<string, string | undefined>;
  createApi(value: string): TelegramApi;
};

const environment: TelegramEnvironment = {
  readCredentials: (names) => process.platform === 'win32' ? readUserCredentials(names) : {},
  createApi: (value) => new TelegramApi(value),
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const legacy = (id: string) => legacyChannels.find(({ accountId }) => accountId === id);
const bot = (handler: ChannelHandler) => handler === 'bi_intake' ? 'bi' : 'main';
const conflict = (params: { accountId: string; agentId: string }) => new HttpError(409, 'CHANNEL_ACCOUNT_IN_USE', params);
const invalid = () => new HttpError(400, 'channel-settings-invalid');
const stale = () => new HttpError(409, 'channel-binding-stale');

type Verified = { client: TelegramApi; owner: string; value: string; identity: string; fingerprint: string };
type Connection = { poller: TelegramPoller; client: TelegramApi; stop: AbortController; account: ChannelAccount };
type PollState = 'credential-unavailable' | 'verification-failed' | 'identity-changed' | 'account-in-use';

export class TelegramAccounts {
  readonly connections = new Map<string, Connection>();
  private readonly due = new Map<string, number>();
  private readonly states = new Map<string, PollState>();
  private admitting = false;
  private readonly ledger: WebStore;
  private readonly inbox: TelegramInbox;
  private readonly sessions: WebStore;
  private readonly enabled: boolean;
  private readonly signal: AbortSignal;
  private readonly handle: (row: Intake, signal: AbortSignal) => Promise<string | undefined>;
  private readonly credentials: TelegramEnvironment;

  constructor(ledger: WebStore, inbox: TelegramInbox, sessions: WebStore, enabled: boolean, signal: AbortSignal,
    handle: TelegramAccounts['handle'], credentials = environment) {
    this.ledger = ledger;
    this.inbox = inbox;
    this.sessions = sessions;
    this.enabled = enabled;
    this.signal = signal;
    this.handle = handle;
    this.credentials = credentials;
  }

  private admission<T>(work: () => T): T {
    if (this.admitting) throw new Error('Reentrant Telegram admission');
    this.admitting = true;
    try { return work(); }
    finally { this.admitting = false; }
  }

  list() {
    return this.ledger.telegramAccounts().map(({ fingerprint: _, ...account }) => {
      const connection = this.connections.get(account.accountId);
      const pollState = account.state === 'disabled' || !this.enabled ? 'disabled' : connection
        ? connection.poller.pollConflict ? 'poll-conflict' : 'polling'
        : this.states.get(account.accountId) ?? 'verifying';
      return { ...account, replyLocale: this.ledger.channelLocale(account.agentId), pollState };
    });
  }

  private async verify(ref: string, handler: ChannelHandler): Promise<Verified> {
    this.signal.throwIfAborted();
    if (!this.enabled) throw new HttpError(503, 'channel-verification-failed');
    if (!telegramCredentialRef.test(ref)) throw invalid();
    let values: ReturnType<TelegramEnvironment['readCredentials']>;
    try { values = this.credentials.readCredentials([legacyAllowlistRef, ref]); }
    catch { throw new HttpError(422, 'channel-credential-unavailable'); }
    const owner = values[legacyAllowlistRef]?.trim();
    const value = values[ref]?.trim();
    if (!owner || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner)) || !value || !/^\d+:[\w-]+$/.test(value)) {
      throw new HttpError(422, 'channel-credential-unavailable');
    }
    try {
      const client = this.credentials.createApi(value);
      const { identity } = await new TelegramTransport(bot(handler), owner, client).verifyAccount(this.signal);
      this.signal.throwIfAborted();
      if (identity !== value.split(':', 1)[0]) throw new Error('Unexpected Telegram identity');
      return { client, owner, value, identity, fingerprint: hash(identity) };
    } catch { throw new HttpError(422, 'channel-verification-failed'); }
  }

  private seal(account: ChannelAccount, { identity, owner }: Verified, save = true) {
    const config = legacy(account.accountId);
    const key = config?.bot ?? account.accountId;
    const fingerprint = hash(`${key}:${identity}:${owner}`);
    const db = this.inbox.db;
    const existing = db.prepare('SELECT fingerprint FROM telegram_binding WHERE bot=?').get(key)?.fingerprint;
    if (existing === fingerprint) return;
    if (existing || db.prepare(`SELECT 1 FROM channel_cursors WHERE account_id=?
      UNION ALL SELECT 1 FROM channel_inbound WHERE account_id=?
      UNION ALL SELECT 1 FROM channel_outbound WHERE account_id=?
      UNION ALL SELECT 1 FROM channel_conversations WHERE account_id=? LIMIT 1`)
      .get(account.accountId, account.accountId, account.accountId, account.accountId)) {
      throw new HttpError(409, 'channel-identity-changed');
    }
    if (save) db.prepare('INSERT INTO telegram_binding VALUES (?,?)').run(key, fingerprint);
  }

  private install(account: ChannelAccount, verified: Verified) {
    const { accountId, agentId } = account;
    const { client, owner, value } = verified;
    const stop = new AbortController();
    const poller = new TelegramPoller(bot(account.handler), owner, client, this.inbox, async (row, signal) => {
      const reply = await this.handle(row, signal);
      return reply?.replaceAll(value, '[已遮蔽]');
    }, () => this.ledger.channelLocale(agentId), {
      binding: { accountId, agentId, bindingRevision: account.bindingRevision }, legacy: Boolean(legacy(accountId)),
      admit: (batch, checkpoint, now) => this.admission(() => {
        if (stop.signal.aborted || this.connections.get(accountId)?.poller !== poller) return;
        this.inbox.admitBatch(account, batch.events, batch.nextCheckpoint, now, checkpoint);
      }),
    });
    this.connections.get(accountId)?.stop.abort();
    this.connections.set(accountId, { poller, client, stop, account });
    this.states.delete(accountId);
  }

  refresh(launch: (key: string, work: () => Promise<void>) => void) {
    if (!this.enabled) return;
    for (const account of this.ledger.telegramAccounts()) {
      const { accountId } = account;
      if (account.state === 'disabled' || this.connections.has(accountId) || Date.now() < (this.due.get(accountId) ?? 0)) continue;
      this.due.set(accountId, Date.now() + 30_000);
      launch(accountId + '-verify', () => this.restore(account));
    }
  }

  private async restore(account: ChannelAccount) {
    try {
      const verified = await this.verify(account.credentialRef, account.handler);
      this.admission(() => {
        const current = this.ledger.telegramAccounts().find(({ accountId }) => accountId === account.accountId);
        if (!current || current.bindingRevision !== account.bindingRevision || current.state !== account.state ||
            current.allowlistRef !== legacyAllowlistRef) return;
        const used = this.ledger.telegramAccountConflict(verified.fingerprint, account.credentialRef, account.accountId);
        if (used) throw conflict(used);
        if (account.fingerprint && account.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
        if (!this.ledger.defaultWorkspace(account.agentId)) return;
        const config = legacy(account.accountId);
        if (account.state === 'unverified') {
          if (!config || !this.ledger.verifyLegacyChannel(config, verified.fingerprint, () => {
            this.seal(account, verified);
            return true;
          })) return;
        } else this.seal(account, verified);
        this.install({ ...account, fingerprint: verified.fingerprint, state: 'enabled' }, verified);
      });
    } catch (error) {
      const current = this.ledger.telegramAccounts().find(({ accountId }) => accountId === account.accountId);
      if (this.signal.aborted || current?.bindingRevision !== account.bindingRevision) return;
      const code = error instanceof HttpError ? error.detail.code : null;
      this.states.set(account.accountId, code === 'channel-credential-unavailable' ? 'credential-unavailable' :
        code === 'channel-identity-changed' ? 'identity-changed' : code === 'CHANNEL_ACCOUNT_IN_USE' ? 'account-in-use' :
          'verification-failed');
    }
  }

  async configure(input: Record<string, unknown>) {
    const { action, accountId, bindingRevision, confirmed } = input;
    if (typeof action !== 'string' || !['verify', 'bind', 'unbind', 'rebind'].includes(action) ||
        Object.keys(input).some((key) => !['action', 'accountId', 'bindingRevision', 'confirmed', 'credentialRef', 'agentId', 'handler'].includes(key))) {
      throw invalid();
    }
    const previous = this.ledger.telegramAccounts().find((account) => account.accountId === accountId);
    if (accountId !== undefined && !previous) throw new HttpError(404, 'channel-account-not-found');
    const handler = input.handler ?? previous?.handler ?? 'chat';
    const agentId = input.agentId ?? previous?.agentId;
    const credentialRef = input.credentialRef ?? previous?.credentialRef;
    if (typeof credentialRef !== 'string' || !telegramCredentialRef.test(credentialRef) ||
        handler !== 'chat' && handler !== 'bi_intake') throw invalid();
    if (action === 'verify') {
      const verified = await this.verify(credentialRef, handler);
      const used = this.ledger.telegramAccountConflict(verified.fingerprint, credentialRef, previous?.accountId);
      if (used) throw conflict(used);
      if (previous?.fingerprint && previous.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
      if (previous) this.seal(previous, verified, false);
      return { verified: true };
    }
    if (confirmed !== true) throw new HttpError(409, 'channel-confirmation-required');
    if (!this.enabled) throw new HttpError(503, 'channel-verification-failed');
    if (previous && bindingRevision !== previous.bindingRevision) throw stale();
    if (action === 'bind' ? previous?.state === 'enabled' : previous?.state !== 'enabled') throw stale();
    if (typeof agentId !== 'string' || !this.ledger.defaultWorkspace(agentId) ||
        handler === 'bi_intake' && (previous?.accountId !== 'telegram-bi' || agentId !== 'bi')) throw invalid();
    if (action === 'unbind' && (agentId !== previous!.agentId || handler !== previous!.handler || credentialRef !== previous!.credentialRef)) {
      throw invalid();
    }
    const verified = action === 'unbind' ? undefined : await this.verify(credentialRef, handler);
    return this.admission(() => {
      this.signal.throwIfAborted();
      const current = this.ledger.telegramAccounts().find((account) => account.accountId === accountId);
      if (previous && (current?.bindingRevision !== previous.bindingRevision || current.state !== previous.state)) throw stale();
      if (current?.state === 'enabled' && this.busy(current.accountId)) throw new HttpError(409, 'channel-binding-busy');
      if (verified && current?.fingerprint && current.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
      const account: ChannelAccount = { accountId: current?.accountId ?? 'telegram-' + randomUUID(), agentId, credentialRef,
        allowlistRef: legacyAllowlistRef, handler, state: verified ? 'enabled' : 'disabled',
        fingerprint: verified?.fingerprint ?? current!.fingerprint, bindingRevision: (current?.bindingRevision ?? 0) + 1 };
      const used = this.ledger.saveTelegramAccount(account, current, () => { if (verified) this.seal(account, verified); });
      if (used) throw conflict(used);
      if (verified) this.install(account, verified);
      else {
        this.connections.get(account.accountId)?.stop.abort();
        this.connections.delete(account.accountId);
      }
      return { accounts: this.list() };
    });
  }

  private busy(accountId: string) {
    return this.connections.get(accountId)?.poller.busy() || this.sessions.openChannelRuns(accountId) ||
      Boolean(this.inbox.db.prepare(`SELECT 1 FROM channel_inbound WHERE account_id=? AND status IN ('pending','handed_off')
        UNION ALL SELECT 1 FROM channel_outbound WHERE account_id=? AND state IN ('pending','sending') LIMIT 1`).get(accountId, accountId));
  }
}
