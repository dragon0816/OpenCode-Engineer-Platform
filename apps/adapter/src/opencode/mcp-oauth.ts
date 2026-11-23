import { createHash, randomBytes } from 'node:crypto';
import { WebMessageError } from '../http/errors.ts';
import { oauthBinding, oauthSettings } from '../runs/custom-mcp.ts';
import type { CustomMcp, CustomRemoteMcp } from '../runs/custom-mcp.ts';
import { mcpOAuthCredentialName, readCustomMcpCredentials, saveCustomMcpCredential } from '../runs/custom-mcp-credentials.ts';
import type { CredentialEnvironment } from '../runs/custom-mcp-credentials.ts';
import { sendRemoteMcp } from '../../../../scripts/windows/custom-mcp-remote.mjs';
import { listenForMcpOAuth } from './mcp-oauth-callback.ts';
import { bearerChallenge, discoverMcpOAuth, oauthEndpoint, oauthHttp } from './mcp-oauth-discovery.ts';
import { mcpOAuthStorage } from './mcp-oauth-storage.ts';
import { objectRecord } from './tool-transport.ts';

type Client = { id: string; secret?: string; issuer?: string };
type Method = 'none' | 'client_secret_basic' | 'client_secret_post';
type Tokens = {
  issuer: string; resource: string; token: string; revoke?: string; method: Method; dynamicClient?: Client;
  access: string; refresh?: string; expires?: number;
};
type Saved = { binding: string; tokens?: Tokens };
type Entry = {
  saved?: Saved; client?: Client; lifetime: AbortController; login?: AbortController; refresh?: Promise<Tokens>;
  error?: WebMessageError['detail']['code'];
};

const oauthCredential = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value);
const bearerToken = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
const clientEncode = (value: string) => new URLSearchParams({ value }).toString().slice(6);

function clientAuth(form: URLSearchParams, client: Client, method: Method) {
  if (method === 'client_secret_basic') {
    return `Basic ${Buffer.from(`${clientEncode(client.id)}:${clientEncode(client.secret!)}`).toString('base64')}`;
  }
  form.set('client_id', client.id);
  if (method === 'client_secret_post') form.set('client_secret', client.secret!);
}

async function exchangeToken(server: CustomRemoteMcp, context: Omit<Tokens, 'access' | 'refresh' | 'expires'>,
  client: Client, form: URLSearchParams, signal: AbortSignal, previous?: Tokens) {
  form.set('resource', context.resource);
  const authorization = clientAuth(form, client, context.method);
  let response: Awaited<ReturnType<typeof oauthHttp>>;
  try { response = await oauthHttp(oauthEndpoint(context.token), server.localService, signal, form, authorization); }
  catch { throw new WebMessageError('mcp-oauth-token'); }
  const { data, status } = response;
  if (status === 401 || (status === 400 && ['invalid_grant', 'invalid_client', 'invalid_scope'].includes(String(data?.error)))) {
    throw new WebMessageError(previous ? 'mcp-oauth-login-required' : 'mcp-oauth-login');
  }
  if (status < 200 || status >= 300 || !bearerToken(data?.access_token) ||
      typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !/^[\x21-\x7e]{1,32768}$/.test(data.refresh_token))) ||
      (data.expires_in !== undefined && (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in < 0))) {
    throw new WebMessageError('mcp-oauth-token');
  }
  return { ...context, access: data.access_token, refresh: data.refresh_token as string | undefined ?? previous?.refresh,
    expires: typeof data.expires_in === 'number' ? Date.now() + Math.min(data.expires_in, 2 ** 31) * 1000 : undefined };
}

export class McpOAuth {
  readonly #entries = new Map<string, Entry>();
  readonly #storage: ReturnType<typeof mcpOAuthStorage>;
  readonly #browser: (url: string) => Promise<void>;
  readonly #credentials?: CredentialEnvironment;

  constructor(root: string, browser: (url: string) => Promise<void>, credentials?: CredentialEnvironment) {
    this.#storage = mcpOAuthStorage(root);
    this.#browser = browser;
    this.#credentials = credentials;
  }

  #entry(id: string) {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = { lifetime: new AbortController() };
      try { entry.saved = this.#storage.read(id) as Saved | undefined; }
      catch { entry.error = 'credential-access'; }
      this.#entries.set(id, entry);
    }
    return entry;
  }

  #readClient(server: CustomRemoteMcp, entry: Entry) {
    if (entry.client) return entry.client;
    const name = mcpOAuthCredentialName(server.id);
    const read = this.#credentials?.readCredentials ?? readCustomMcpCredentials;
    try {
      const client = objectRecord(JSON.parse(read([name])[name] ?? 'null'));
      if (oauthCredential(client?.id) && (client.secret === undefined || oauthCredential(client.secret)) &&
          (client.issuer === undefined || typeof client.issuer === 'string')) {
        return entry.client = { id: client.id, secret: client.secret, issuer: client.issuer };
      }
    } catch { /* An unreadable credential is handled as missing. */ }
    throw new WebMessageError('mcp-oauth-client');
  }

  #saveClient(id: string, entry: Entry, client: Client) {
    saveCustomMcpCredential(mcpOAuthCredentialName(id), JSON.stringify(client), this.#credentials?.writeCredential);
    entry.client = client;
  }

  #write(id: string, entry: Entry, saved?: Saved) {
    this.#storage.write(id, saved);
    entry.saved = saved;
  }

  #reset(entry: Entry) {
    entry.login?.abort();
    entry.lifetime.abort();
    entry.lifetime = new AbortController();
    entry.refresh = undefined;
    entry.login = undefined;
    entry.error = undefined;
  }

  configure(previous: CustomMcp | undefined, next: CustomMcp, id: unknown, secret: unknown) {
    const settings = oauthSettings(next);
    const before = previous && oauthBinding(previous);
    const after = oauthBinding(next);
    if (!before && !after) return;
    const supplied = id !== undefined || secret !== undefined;
    if (supplied && (settings?.client !== 'static' || !oauthCredential(id) || (secret !== undefined && !oauthCredential(secret)))) {
      throw new WebMessageError('mcp-oauth-client');
    }
    if (settings?.client === 'static' && !supplied && (!previous || oauthSettings(previous)?.client !== 'static')) {
      throw new WebMessageError('mcp-oauth-client');
    }
    if (!supplied && before === after) return;
    const entry = this.#entry(next.id);
    this.#reset(entry);
    if (entry.saved) this.#write(next.id, entry, after ? { binding: after } : undefined);
    if (supplied && typeof id === 'string') this.#saveClient(next.id, entry, { id, secret: secret as string | undefined });
  }

  status(server: CustomMcp) {
    const binding = oauthBinding(server);
    if (!binding) return;
    const entry = this.#entry(server.id);
    const tokens = entry.saved?.binding === binding && entry.saved.tokens;
    const state = entry.login ? 'pending' : !entry.saved ? 'signed-out' :
      tokens && (tokens.refresh || tokens.expires === undefined || tokens.expires > Date.now()) ? 'signed-in' : 'reauth';
    return { state, error: entry.error };
  }

  async start(server: CustomRemoteMcp) {
    const binding = oauthBinding(server);
    if (!binding || !server.oauth) throw new WebMessageError('mcp-oauth-settings');
    const entry = this.#entry(server.id);
    if (entry.login) throw new WebMessageError('mcp-oauth-pending');
    if (this.status(server)?.state === 'signed-in') throw new WebMessageError('mcp-oauth-sign-out-first');
    this.#reset(entry);
    const login = entry.login = new AbortController();
    const deadline = setTimeout(() => finish('mcp-oauth-login', true), 180_000);
    deadline.unref();
    const finish = (error?: Entry['error'], abort = false) => {
      clearTimeout(deadline);
      if (entry.login !== login) return;
      entry.error = error;
      entry.login = undefined;
      if (abort) login.abort();
    };
    login.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
    try {
      let client = server.oauth.client === 'static' ? this.#readClient(server, entry) : undefined;
      const signal = AbortSignal.any([login.signal, AbortSignal.timeout(30_000)]);
      const discovery = await discoverMcpOAuth(server, client?.issuer, signal)
        .catch(() => { throw new WebMessageError('mcp-oauth-discovery'); });
      signal.throwIfAborted();
      if (client && !client.issuer) this.#saveClient(server.id, entry, client = { ...client, issuer: discovery.issuer });
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const methods = discovery.methods;
      const google = discovery.issuer === 'https://accounts.google.com';
      const method: Method = client?.secret ? (methods?.includes('client_secret_post') &&
        (google || !methods.includes('client_secret_basic')) ? 'client_secret_post' : 'client_secret_basic') : 'none';
      if (method !== 'none' && methods && !methods.includes(method)) throw new WebMessageError('mcp-oauth-client');
      let context: Omit<Tokens, 'access' | 'refresh' | 'expires'>;
      const redirect = await listenForMcpOAuth(state, discovery.issuer, discovery.enforceIssuer, login.signal,
        async (code, redirectUri) => {
          const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
          const tokens = await exchangeToken(server, context, client!, form, login.signal);
          login.signal.throwIfAborted();
          this.#write(server.id, entry, { binding, tokens });
          finish();
        }, () => finish('mcp-oauth-login'));
      if (!client) {
        if (!discovery.register) throw new WebMessageError('mcp-oauth-registration');
        const registration = await oauthHttp(discovery.register, server.localService, signal, {
          client_name: 'OpenCode Engineer Platform', application_type: 'native', redirect_uris: [redirect],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
        }).catch(() => { throw new WebMessageError('mcp-oauth-registration'); });
        const { status, data } = registration;
        if (status < 200 || status >= 300 || !oauthCredential(data?.client_id) ||
          (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none')) {
          throw new WebMessageError('mcp-oauth-registration');
        }
        client = { id: data.client_id, issuer: discovery.issuer };
      }
      const { issuer, resource, token, revoke } = discovery;
      context = { issuer, resource, token, revoke, method, ...(server.oauth.client === 'dynamic' && { dynamicClient: client }) };
      const authorization = discovery.authorization;
      const scopes = [...new Set([...discovery.scopes, ...discovery.offline ? ['offline_access'] : []])];
      for (const [key, value] of Object.entries({ client_id: client.id, response_type: 'code', redirect_uri: redirect,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, resource,
        ...(google && { access_type: 'offline', prompt: 'consent' }) })) authorization.searchParams.set(key, value);
      authorization.searchParams.delete('scope');
      if (scopes.length) authorization.searchParams.set('scope', scopes.join(' '));
      signal.throwIfAborted();
      await this.#browser(authorization.href).catch(() => { throw new WebMessageError('mcp-oauth-browser'); });
    } catch (error) {
      const safe = error instanceof WebMessageError ? error : new WebMessageError('mcp-oauth-login');
      finish(safe.detail.code, true);
      throw safe;
    }
  }

  #clientForTokens(server: CustomRemoteMcp, entry: Entry, tokens: Tokens) {
    const client = tokens.dynamicClient ?? this.#readClient(server, entry);
    if (client.issuer !== tokens.issuer || (tokens.method !== 'none' && !client.secret)) {
      throw new WebMessageError('mcp-oauth-login-required');
    }
    return client;
  }

  async #refresh(server: CustomRemoteMcp, entry: Entry, tokens: Tokens) {
    const binding = oauthBinding(server)!;
    const signal = entry.lifetime.signal;
    try {
      if (!tokens.refresh) throw new WebMessageError('mcp-oauth-login-required');
      const client = this.#clientForTokens(server, entry, tokens);
      const { issuer, resource, token, revoke, method, dynamicClient } = tokens;
      const next = await exchangeToken(server, { issuer, resource, token, revoke, method, dynamicClient }, client,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh }), signal, tokens);
      signal.throwIfAborted();
      this.#write(server.id, entry, { binding, tokens: next });
      entry.error = undefined;
      return next;
    } catch (error) {
      if (!signal.aborted && error instanceof WebMessageError) {
        if (error.detail.code === 'mcp-oauth-login-required' || error.detail.code === 'mcp-oauth-client') {
          this.#write(server.id, entry, { binding });
        }
        entry.error = error.detail.code;
      }
      throw error;
    }
  }

  async send(server: CustomRemoteMcp, message: Parameters<typeof sendRemoteMcp>[1], session: Parameters<typeof sendRemoteMcp>[2],
    stop: AbortSignal, secrets: Set<string>, transport = sendRemoteMcp) {
    const binding = oauthBinding(server)!;
    const entry = this.#entry(server.id);
    const signal = AbortSignal.any([stop, entry.lifetime.signal]);
    const token = () => {
      signal.throwIfAborted();
      if (entry.saved?.binding === binding && entry.saved.tokens) return entry.saved.tokens;
      throw new WebMessageError('mcp-oauth-login-required');
    };
    const refresh = async (current: Tokens) => {
      const latest = token();
      if (latest !== current) return latest;
      if (!entry.refresh) {
        const pending = this.#refresh(server, entry, current);
        entry.refresh = pending;
        const clear = () => { if (entry.refresh === pending) entry.refresh = undefined; };
        void pending.then(clear, clear);
      }
      return await entry.refresh;
    };
    const send = async (tokens: Tokens) => {
      const client = this.#clientForTokens(server, entry, tokens);
      for (const value of [client.id, client.secret, tokens.access, tokens.refresh]) if (value) secrets.add(value);
      signal.throwIfAborted();
      const reply = await transport(server, message, session, { Authorization: `Bearer ${tokens.access}` }, signal);
      signal.throwIfAborted();
      return reply;
    };
    let current = token();
    if (current.expires !== undefined && current.expires <= Date.now()) current = await refresh(current);
    for (let attempt = 0; ; attempt++) {
      try { return await send(current); }
      catch (error) {
        signal.throwIfAborted();
        const failure = objectRecord(error);
        if (failure?.status === 403 && bearerChallenge(failure.challenge).get('error') === 'insufficient_scope') {
          entry.error = 'mcp-oauth-scope';
          throw new WebMessageError(entry.error);
        }
        if (failure?.status !== 401) throw error;
        if (attempt === 0) { current = await refresh(current); continue; }
        if (token() === current) this.#write(server.id, entry, { binding });
        entry.error = 'mcp-oauth-login-required';
        throw new WebMessageError(entry.error);
      }
    }
  }

  async signOut(server: CustomRemoteMcp) {
    const entry = this.#entry(server.id);
    const tokens = entry.saved?.tokens;
    this.#reset(entry);
    this.#write(server.id, entry);
    if (!tokens) return;
    if (!tokens.revoke) { entry.error = 'mcp-oauth-revoke'; return; }
    const generation = entry.lifetime;
    try {
      const client = this.#clientForTokens(server, entry, tokens);
      const form = new URLSearchParams({ token: tokens.refresh ?? tokens.access,
        token_type_hint: tokens.refresh ? 'refresh_token' : 'access_token' });
      const authorization = clientAuth(form, client, tokens.method);
      const { status } = await oauthHttp(oauthEndpoint(tokens.revoke), server.localService, AbortSignal.timeout(8_000), form, authorization);
      if (status < 200 || status >= 300) throw new Error('Revocation failed');
    } catch { if (entry.lifetime === generation) entry.error = 'mcp-oauth-revoke'; }
  }

  remove(server: CustomMcp) {
    if (!oauthBinding(server)) return;
    const entry = this.#entry(server.id);
    this.#reset(entry);
    this.#write(server.id, entry);
    this.#entries.delete(server.id);
  }

  close() {
    for (const entry of this.#entries.values()) this.#reset(entry);
  }
}
