import { createHash, randomUUID } from 'node:crypto';
import { legacyAllowlistRef, legacyChannels, telegramCredentialRef } from '../channels/accounts.ts';
import type { ChannelAccount, ChannelHandler } from '../channels/accounts.ts';
import { HttpError } from '../http/errors.ts';
import { readUserCredentials, writeUserCredential } from '../runs/custom-mcp-credentials.ts';
import type { CredentialEnvironment } from '../runs/custom-mcp-credentials.ts';
import type { WebStore } from '../runs/web-store.ts';
import type { Intake, TelegramInbox } from './inbox.ts';
import { TelegramApi, TelegramPoller, TelegramTransport } from './poller.ts';
import { TelegramSetup, validOwner, validToken } from './setup.ts';
import type { VerifiedBot } from './setup.ts';

export type TelegramEnvironment = Pick<CredentialEnvironment, 'readCredentials'> & Partial<Pick<CredentialEnvironment, 'writeCredential'>> & {
  createApi(value: string): TelegramApi;
};

const environment: TelegramEnvironment = {
  readCredentials: (names) => process.platform === 'win32' ? readUserCredentials(names) : {},
  writeCredential: writeUserCredential,
  createApi: (value) => new TelegramApi(value),
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const managedReference = (accountId: string) => 'OEP_TELEGRAM_BOT_' + hash(accountId).slice(0, 32).toUpperCase() + '_BOT_TOKEN';
const legacy = (id: string) => legacyChannels.find(({ accountId }) => accountId === id);
const bot = (handler: ChannelHandler) => handler === 'bi_intake' ? 'bi' : 'main';
const conflict = (params: { accountId: string; agentId: string }) => new HttpError(409, 'CHANNEL_ACCOUNT_IN_USE', params);
const invalid = () => new HttpError(400, 'channel-settings-invalid');
const stale = () => new HttpError(409, 'channel-binding-stale');

type Verified = VerifiedBot & { owner: string };
type Connection = {
  poller: TelegramPoller; client: TelegramApi; stop: AbortController; account: ChannelAccount; botName?: string; redact(text: string): string;
};
type PollState = 'credential-unavailable' | 'verification-failed' | 'identity-changed' | 'account-in-use';

export class TelegramAccounts {
  readonly connections = new Map<string, Connection>();
  private readonly due = new Map<string, number>();
  private readonly states = new Map<string, PollState>();
  private readonly setup = new TelegramSetup();
  private admitting = false;
  private readonly ledger: WebStore;
  private readonly inbox: TelegramInbox;
  private readonly sessions: WebStore;
  private readonly enabled: boolean;
  private readonly signal: AbortSignal;
  private readonly handoff: (row: Intake, now: number, deadline: number) => void;
  private readonly credentials: TelegramEnvironment;

  constructor(ledger: WebStore, inbox: TelegramInbox, sessions: WebStore, enabled: boolean, signal: AbortSignal,
    handoff: TelegramAccounts['handoff'], credentials = environment) {
    this.ledger = ledger;
    this.inbox = inbox;
    this.sessions = sessions;
    this.enabled = enabled;
    this.signal = signal;
    this.handoff = handoff;
    this.credentials = credentials;
  }

  private admission<T>(work: () => T): T {
    if (this.admitting) throw new Error('Reentrant Telegram admission');
    this.admitting = true;
    try { return work(); }
    finally { this.admitting = false; }
  }

  list() {
    const settings = this.ledger.telegramAccountSettings();
    return this.ledger.telegramAccounts().filter(({ accountId }) => !settings.get(accountId)?.removed)
      .map(({ fingerprint, credentialRef, allowlistRef: _allowlistRef, ...account }) => {
        const connection = this.connections.get(account.accountId);
        const pollState = account.state === 'disabled' || !this.enabled ? 'disabled' : connection
          ? connection.poller.credentialRejected ? 'credential-unavailable' : connection.poller.pollConflict ? 'poll-conflict' : 'polling'
          : this.states.get(account.accountId) ?? 'verifying';
        return { ...account, botName: connection?.botName ?? settings.get(account.accountId)?.botName, verified: Boolean(fingerprint),
          managedToken: credentialRef === managedReference(account.accountId), replyLocale: this.ledger.channelLocale(account.agentId), pollState };
      });
  }

  private async verify(ref: string): Promise<Verified> {
    this.signal.throwIfAborted();
    if (!this.enabled) throw new HttpError(503, 'channel-verification-failed');
    if (!telegramCredentialRef.test(ref)) throw invalid();
    let values: ReturnType<TelegramEnvironment['readCredentials']>;
    try { values = this.credentials.readCredentials([legacyAllowlistRef, ref]); }
    catch { throw new HttpError(422, 'channel-credential-unavailable'); }
    const owner = values[legacyAllowlistRef]?.trim();
    const value = values[ref]?.trim();
    if (!validOwner(owner) || !value || !validToken(value)) {
      throw new HttpError(422, 'channel-credential-unavailable');
    }
    return { ...await this.verifyToken(value), owner };
  }

  private async verifyToken(value: string): Promise<VerifiedBot> {
    try {
      const client = this.credentials.createApi(value);
      const { identity, botName } = await TelegramTransport.verify(client, this.signal);
      this.signal.throwIfAborted();
      if (identity !== value.split(':', 1)[0]) throw new Error('Unexpected Telegram identity');
      return { client, value, identity, botName: botName?.includes(value) ? undefined : botName, fingerprint: hash(identity) };
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
    const poller = new TelegramPoller(bot(account.handler), owner, client, this.inbox, undefined, () => this.ledger.channelLocale(agentId), {
      binding: { accountId, agentId, bindingRevision: account.bindingRevision }, legacy: Boolean(legacy(accountId)),
      handoff: this.handoff,
      admit: (batch, checkpoint, now) => this.admission(() => {
        if (stop.signal.aborted || this.connections.get(accountId)?.poller !== poller) return;
        this.inbox.admitBatch(account, batch.events, batch.nextCheckpoint, now, checkpoint);
      }),
    });
    this.connections.get(accountId)?.stop.abort();
    this.connections.set(accountId, {
      poller, client, stop, account, botName: verified.botName, redact: (text) => text.replaceAll(value, '[已遮蔽]'),
    });
    this.states.delete(accountId);
  }

  private disconnect(accountId: string) {
    this.connections.get(accountId)?.stop.abort();
    this.connections.delete(accountId);
    this.states.delete(accountId);
  }

  archiveAgent(id: string, revision: number, channelStatus: string) {
    this.admission(() => {
      const bound = this.ledger.telegramAccounts().filter((account) => account.agentId === id && account.state !== 'disabled');
      const waiting = bound.some(({ accountId }) => this.busy(accountId));
      this.ledger.updateAgent(id, revision, null, waiting ? 'busy' : channelStatus, true);
      for (const { accountId } of bound) this.disconnect(accountId);
    });
  }

  refresh(launch: (key: string, work: () => Promise<void>) => void) {
    this.setup.expire();
    if (!this.enabled) return;
    for (const account of this.ledger.telegramAccounts()) {
      const { accountId } = account;
      const connection = this.connections.get(accountId);
      if (account.state === 'disabled' || connection && (!connection.poller.credentialRejected || connection.poller.busy()) ||
          Date.now() < (this.due.get(accountId) ?? 0)) continue;
      this.due.set(accountId, Date.now() + 30_000);
      launch(accountId + '-verify', () => this.restore(account));
    }
  }

  private async restore(account: ChannelAccount, manual = false) {
    try {
      const verified = await this.verify(account.credentialRef);
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
        if (verified.botName) this.ledger.saveTelegramBotName(account.accountId, verified.botName);
        const poller = this.connections.get(account.accountId)?.poller;
        if (!poller || !poller.busy() && (poller.credentialRejected || manual && poller.pollConflict)) {
          this.install({ ...account, fingerprint: verified.fingerprint, state: 'enabled' }, verified);
        }
      });
    } catch (error) {
      const current = this.ledger.telegramAccounts().find(({ accountId }) => accountId === account.accountId);
      if (this.signal.aborted || current?.bindingRevision !== account.bindingRevision) return;
      const code = error instanceof HttpError ? error.detail.code : null;
      this.states.set(account.accountId, code === 'channel-credential-unavailable' ? 'credential-unavailable' :
        code === 'channel-identity-changed' ? 'identity-changed' : code === 'CHANNEL_ACCOUNT_IN_USE' ? 'account-in-use' :
          'verification-failed');
      if (manual) throw error;
    }
  }

  async configure(input: Record<string, unknown>, browser: string, createAgent?: () => void) {
    const { action, accountId, bindingRevision, confirmed } = input;
    if (action === 'setup-start') return this.startSetup(input, browser);
    if (action === 'setup-check' || action === 'setup-cancel') {
      if (Object.keys(input).some((key) => key !== 'action' && key !== 'setupId')) throw invalid();
      if (action === 'setup-check') return this.setup.check(input.setupId, browser, this.signal);
      this.setup.cancel(input.setupId, browser);
      return {};
    }
    if (action === 'setup-save') return this.saveSetup(input, browser, createAgent);
    if (action === 'remove' || action === 'recheck') return this.manageAccount(input);
    if (typeof action !== 'string' || !['verify', 'bind', 'unbind', 'rebind'].includes(action) ||
        Object.keys(input).some((key) => !['action', 'accountId', 'bindingRevision', 'confirmed', 'credentialRef', 'agentId', 'handler'].includes(key))) {
      throw invalid();
    }
    const previous = this.ledger.telegramAccounts().find((account) => account.accountId === accountId);
    if (accountId !== undefined && (!previous || this.ledger.telegramAccountSettings().get(previous.accountId)?.removed)) {
      throw new HttpError(404, 'channel-account-not-found');
    }
    const handler = input.handler ?? previous?.handler ?? 'chat';
    const agentId = input.agentId ?? previous?.agentId;
    const credentialRef = input.credentialRef ?? previous?.credentialRef;
    if (typeof credentialRef !== 'string' || !telegramCredentialRef.test(credentialRef) ||
        handler !== 'chat' && handler !== 'bi_intake') throw invalid();
    if (action === 'verify') {
      const verified = await this.verify(credentialRef);
      const used = this.ledger.telegramAccountConflict(verified.fingerprint, credentialRef, previous?.accountId);
      if (used) throw conflict(used);
      if (previous?.fingerprint && previous.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
      if (previous) this.seal(previous, verified, false);
      return { verified: true, botName: verified.botName };
    }
    if (confirmed !== true) throw new HttpError(409, 'channel-confirmation-required');
    if (!this.enabled) throw new HttpError(503, 'channel-verification-failed');
    if (previous && bindingRevision !== previous.bindingRevision) throw stale();
    if (action === 'bind' ? previous?.state === 'enabled' : previous?.state !== 'enabled') throw stale();
    if (typeof agentId !== 'string' || (!createAgent && !this.ledger.defaultWorkspace(agentId)) ||
        handler === 'bi_intake' && (previous?.accountId !== 'telegram-bi' || agentId !== 'bi')) throw invalid();
    if (action === 'unbind' && (agentId !== previous!.agentId || handler !== previous!.handler || credentialRef !== previous!.credentialRef)) {
      throw invalid();
    }
    const verified = action === 'unbind' ? undefined : await this.verify(credentialRef);
    return this.admission(() => {
      this.signal.throwIfAborted();
      const current = this.ledger.telegramAccounts().find((account) => account.accountId === accountId);
      if (previous && (current?.bindingRevision !== previous.bindingRevision || current.state !== previous.state)) throw stale();
      if (current?.state === 'enabled' && this.busy(current.accountId)) throw new HttpError(409, 'channel-binding-busy');
      if (verified && current?.fingerprint && current.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
      const account: ChannelAccount = { accountId: current?.accountId ?? 'telegram-' + randomUUID(), agentId, credentialRef,
        allowlistRef: legacyAllowlistRef, handler, state: verified ? 'enabled' : 'disabled',
        fingerprint: verified?.fingerprint ?? current!.fingerprint, bindingRevision: (current?.bindingRevision ?? 0) + 1 };
      const used = this.ledger.saveTelegramAccount(account, current, () => { if (verified) this.seal(account, verified); }, createAgent,
        verified?.botName);
      if (used) throw conflict(used);
      if (verified) this.install(account, verified);
      else this.disconnect(account.accountId);
      return { accounts: this.list() };
    });
  }

  private async manageAccount(input: Record<string, unknown>) {
    if (Object.keys(input).some((key) => !['action', 'accountId', 'bindingRevision', 'confirmed'].includes(key))) throw invalid();
    const account = this.ledger.telegramAccounts().find(({ accountId }) => accountId === input.accountId);
    if (!account || this.ledger.telegramAccountSettings().get(account.accountId)?.removed) throw new HttpError(404, 'channel-account-not-found');
    if (account.bindingRevision !== input.bindingRevision) throw stale();
    if (input.action === 'recheck') {
      if (account.state === 'disabled') await this.verify(account.credentialRef).then((verified) => this.seal(account, verified, false));
      else await this.restore(account, true);
    } else this.admission(() => {
      if (input.confirmed !== true) throw new HttpError(409, 'channel-confirmation-required');
      if (this.busy(account.accountId)) throw new HttpError(409, 'channel-binding-busy');
      const write = this.credentials.writeCredential;
      const managed = write && account.credentialRef === managedReference(account.accountId);
      let previous: string | undefined;
      if (managed) {
        try {
          previous = this.credentials.readCredentials([account.credentialRef])[account.credentialRef];
          write(account.credentialRef, null);
        }
        catch { throw new HttpError(422, 'channel-token-save-failed'); }
      }
      try { this.ledger.removeTelegramAccount(account); }
      catch (error) {
        if (managed && previous) {
          try { write(account.credentialRef, previous); } catch { /* The token can be replaced from Manage. */ }
        }
        throw error;
      }
      this.disconnect(account.accountId);
    });
    return { accounts: this.list() };
  }

  private async startSetup(input: Record<string, unknown>, browser: string) {
    if (!this.enabled || !this.credentials.writeCredential) throw new HttpError(503, 'channel-token-save-failed');
    const { token, accountId, bindingRevision } = input;
    if (Object.keys(input).some((key) => !['action', 'token', 'accountId', 'bindingRevision'].includes(key)) ||
        (accountId === undefined ? bindingRevision !== undefined : typeof accountId !== 'string' || !Number.isSafeInteger(bindingRevision))) {
      throw invalid();
    }
    if (typeof token !== 'string' || !validToken(token.trim())) throw new HttpError(422, 'channel-token-invalid');
    const started = Math.floor(Date.now() / 1000);
    const verified = await this.verifyToken(token.trim());
    const accounts = this.ledger.telegramAccounts();
    const settings = this.ledger.telegramAccountSettings();
    const previous = accountId === undefined ? accounts.find((account) => account.fingerprint === verified.fingerprint &&
      settings.get(account.accountId)?.removed) : accounts.find((account) => account.accountId === accountId);
    if (accountId !== undefined && previous?.bindingRevision !== bindingRevision) throw stale();
    const used = this.ledger.telegramAccountConflict(verified.fingerprint, '', previous?.accountId);
    if (used) throw conflict(used);
    if (previous?.fingerprint && previous.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
    let owner: string | undefined;
    try { owner = this.credentials.readCredentials([legacyAllowlistRef])[legacyAllowlistRef]?.trim(); }
    catch { throw new HttpError(422, 'channel-credential-unavailable'); }
    return this.setup.start(verified, browser, validOwner(owner) ? owner : undefined, started, accountId !== undefined,
      previous?.accountId, previous?.bindingRevision);
  }

  private async saveSetup(input: Record<string, unknown>, browser: string, createAgent?: () => void) {
    if (Object.keys(input).some((key) => !['action', 'setupId', 'agentId', 'confirmed', 'ownerConfirmed'].includes(key))) throw invalid();
    if (input.confirmed !== true) throw new HttpError(409, 'channel-confirmation-required');
    const setup = this.setup.get(input.setupId, browser);
    const { candidate } = setup;
    const owner = setup.owner ?? (input.ownerConfirmed === true ? candidate?.id : undefined);
    if (!owner) throw new HttpError(409, 'channel-owner-confirmation');
    const verified = { ...await this.verifyToken(setup.value), owner };
    return this.admission(() => {
      this.setup.get(setup.id, browser);
      if (createAgent && setup.replacing) throw invalid();
      const current = this.ledger.telegramAccounts().find((account) => account.accountId === setup.accountId);
      if (setup.accountId && current?.bindingRevision !== setup.revision) throw stale();
      const agentId = input.agentId ?? current?.agentId;
      const handler = current?.handler ?? 'chat';
      const state = setup.replacing && (input.agentId === null || current?.state === 'disabled' && input.agentId === undefined) ?
        'disabled' : 'enabled';
      if (typeof agentId !== 'string' || (!createAgent && state === 'enabled' && !this.ledger.defaultWorkspace(agentId)) ||
          handler === 'bi_intake' && agentId !== 'bi') throw invalid();
      if (current?.state === 'enabled' && this.busy(current.accountId)) throw new HttpError(409, 'channel-binding-busy');
      if (current?.fingerprint && current.fingerprint !== verified.fingerprint) throw new HttpError(409, 'channel-identity-changed');
      const accountId = current?.accountId ?? 'telegram-' + randomUUID();
      const credentialRef = managedReference(accountId);
      const account: ChannelAccount = { accountId, agentId, credentialRef,
        allowlistRef: legacyAllowlistRef, handler, state, fingerprint: verified.fingerprint, bindingRevision: (current?.bindingRevision ?? 0) + 1 };
      const used = this.ledger.telegramAccountConflict(verified.fingerprint, credentialRef, current?.accountId);
      if (used) throw conflict(used);
      this.seal(account, verified, false);
      this.saveCredentials(account, verified, setup.owner, () => {
        this.ledger.saveTelegramAccount(account, current, () => {
          this.seal(account, verified);
          if (candidate && !current) this.inbox.admitBatch(account, [], String(setup.offset), Date.now(), '');
        }, createAgent, verified.botName);
      });
      this.setup.cancel(setup.id, browser);
      if (state === 'enabled') this.install(account, verified);
      else this.disconnect(account.accountId);
      return { accounts: this.list() };
    });
  }

  private saveCredentials(account: ChannelAccount, verified: Verified, existingOwner: string | undefined, save: () => void) {
    const write = this.credentials.writeCredential;
    if (!write) throw new HttpError(503, 'channel-token-save-failed');
    let previous: ReturnType<TelegramEnvironment['readCredentials']>;
    try { previous = this.credentials.readCredentials([account.allowlistRef, account.credentialRef]); }
    catch { throw new HttpError(422, 'channel-token-save-failed'); }
    const currentOwner = previous[account.allowlistRef]?.trim();
    if (existingOwner ? currentOwner !== existingOwner : validOwner(currentOwner) && currentOwner !== verified.owner) {
      throw new HttpError(409, 'channel-setup-expired');
    }
    const applied: string[] = [];
    const update = (name: string, value: string) => {
      applied.push(name);
      try { write(name, value); }
      catch { throw new HttpError(422, 'channel-token-save-failed'); }
    };
    try {
      update(account.credentialRef, verified.value);
      if (currentOwner !== verified.owner) update(account.allowlistRef, verified.owner);
      save();
    } catch (error) {
      for (const name of applied.reverse()) {
        try { write(name, previous[name] ?? null); } catch { /* Retry in a new setup if Windows is unavailable. */ }
      }
      throw error;
    }
  }

  private busy(accountId: string) {
    return this.connections.get(accountId)?.poller.busy() || this.sessions.openChannelRuns(accountId) ||
      Boolean(this.inbox.db.prepare(`SELECT 1 FROM channel_inbound WHERE account_id=? AND status IN ('pending','handed_off')
        UNION ALL SELECT 1 FROM channel_outbound WHERE account_id=? AND state IN ('pending','sending') LIMIT 1`).get(accountId, accountId));
  }
}
