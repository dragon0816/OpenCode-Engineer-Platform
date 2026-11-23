import { request } from 'node:https';
import { pinIpv4 } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { oauthScopes } from '../runs/custom-mcp.ts';
import type { CustomRemoteMcp } from '../runs/custom-mcp.ts';
import { objectRecord } from './tool-transport.ts';
import { sendRemoteMcp, statelessMcpVersion } from '../../../../scripts/windows/custom-mcp-remote.mjs';

export const oauthEndpoint = (value: unknown) => {
  const url = typeof value === 'string' && value.length <= 2048 && !/[\\\s]/.test(value) && URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || url.hostname.startsWith('[')) {
    throw new Error('Invalid OAuth endpoint');
  }
  return url;
};

export async function oauthHttp(url: URL, localService: boolean, stop: AbortSignal, body?: URLSearchParams | object,
  authorization?: string) {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(8000)]);
  const address = await pinIpv4(url.hostname, localService, signal);
  const form = body instanceof URLSearchParams;
  const payload = form ? body.toString() : JSON.stringify(body);
  return await new Promise<{ status: number; data?: Record<string, unknown> }>((resolve, reject) => {
    const fail = () => reject(new Error('OAuth HTTPS request failed'));
    const upstream = request(url, {
      method: payload === undefined ? 'GET' : 'POST', signal, family: 4, agent: false, rejectUnauthorized: true,
      lookup: (_name, options, done) => options.all ? done(null, [{ address, family: 4 }]) : done(null, address, 4),
      headers: { Accept: 'application/json', ...(authorization && { Authorization: authorization }),
        ...(payload !== undefined && { 'Content-Length': Buffer.byteLength(payload),
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }) },
    }, (response) => {
      const status = response.statusCode ?? 500;
      response.on('error', fail);
      if (status >= 300 && status < 400) { response.destroy(); fail(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024) { response.destroy(); fail(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let data: Record<string, unknown> | undefined;
        try { data = objectRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { /* An empty or non-JSON response has no OAuth fields. */ }
        resolve({ status, data });
      });
    });
    upstream.on('error', fail);
    upstream.end(payload);
  });
}

export function bearerChallenge(value: unknown) {
  const params = new Map<string, string>();
  if (typeof value !== 'string') return params;
  let bearer = false;
  for (const entry of value.match(/(?:[^,"\\]|"(?:[^"\\]|\\.)*")+/g) ?? []) {
    const scheme = /^\s*([\w-]+)\s+(?=[^\s=]+\s*=)/.exec(entry);
    if (scheme) bearer = scheme[1].toLowerCase() === 'bearer';
    if (!bearer) continue;
    const part = entry.slice(scheme?.[0].length ?? 0).trim();
    const field = /^([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))$/.exec(part);
    if (!field) { bearer = false; continue; }
    const name = field[1].toLowerCase();
    if (params.has(name)) throw new Error('Ambiguous OAuth challenge');
    params.set(name, field[2]?.replace(/\\(.)/g, '$1') ?? field[3]);
  }
  return params;
}

function wellKnown(url: URL, name: string) {
  return new URL(`/.well-known/${name}${url.pathname === '/' ? '' : url.pathname}`, url);
}

async function readMetadata(endpoints: URL[], localService: boolean, signal: AbortSignal) {
  for (const endpoint of endpoints) {
    const { status, data } = await oauthHttp(endpoint, localService, signal);
    if (status === 200 && data) return { data, endpoint };
    if (status !== 404 && status !== 410) throw new Error('OAuth metadata unavailable');
  }
  throw new Error('OAuth metadata unavailable');
}

const canonicalResource = (url: URL) => url.pathname === '/' ? url.origin : url.href;

export async function discoverMcpOAuth(server: CustomRemoteMcp, boundIssuer: string | undefined, signal: AbortSignal) {
  const target = new URL(server.url);
  let challenge = new Map<string, string>();
  try {
    try {
      const reply = await sendRemoteMcp(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { version: statelessMcpVersion }, {}, signal);
      if (reply?.error !== undefined) throw Object.assign(new Error('Unsupported catalog request'), { status: 400 });
    } catch (error) {
      if (objectRecord(error)?.status !== 400) throw error;
      await sendRemoteMcp(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OEP', version: '1' },
      } }, {}, {}, signal);
    }
  } catch (error) {
    const failure = objectRecord(error);
    if (failure?.status === 401) challenge = bearerChallenge(failure.challenge);
    else if (typeof failure?.status !== 'number' || failure.status < 400) throw new Error('OAuth resource unavailable');
  }
  const advertised = challenge.get('resource_metadata');
  const rootMetadata = '/.well-known/oauth-protected-resource';
  const { data: metadata, endpoint } = await readMetadata(advertised ? [oauthEndpoint(advertised)] : [
    wellKnown(target, 'oauth-protected-resource'), ...target.pathname === '/' ? [] : [new URL(rootMetadata, target)],
  ], server.localService, signal);
  const rootResource = target.pathname === '/' || (!advertised && endpoint.pathname === rootMetadata);
  if (rootResource ? metadata.resource !== target.origin && metadata.resource !== `${target.origin}/` : metadata.resource !== target.href) {
    throw new Error('OAuth resource mismatch');
  }
  const issuers = metadata.authorization_servers;
  if (!Array.isArray(issuers) || !issuers.length) throw new Error('OAuth issuer unavailable');
  if (boundIssuer && !issuers.includes(boundIssuer)) throw new Error('OAuth issuer changed');
  const issuer: unknown = boundIssuer ?? issuers[0];
  const issuerUrl = oauthEndpoint(issuer);
  if (typeof issuer !== 'string' || issuerUrl.search) throw new Error('Invalid OAuth issuer');
  const endpoints = [wellKnown(issuerUrl, 'oauth-authorization-server'), wellKnown(issuerUrl, 'openid-configuration')];
  if (issuerUrl.pathname !== '/') {
    endpoints.push(new URL(`${issuerUrl.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`, issuerUrl));
  }
  const { data: auth } = await readMetadata(endpoints, server.localService, signal);
  if (auth.issuer !== issuer || !Array.isArray(auth.code_challenge_methods_supported) ||
      !auth.code_challenge_methods_supported.includes('S256')) throw new Error('Invalid OAuth issuer metadata');
  const authorization = oauthEndpoint(auth.authorization_endpoint);
  await pinIpv4(authorization.hostname, server.localService, signal);
  const challenged = oauthScopes(challenge.get('scope')?.split(/ +/));
  const configured = server.oauth?.scopes ?? [];
  const scopes = oauthScopes([...configured, ...(challenged ?? (configured.length ? [] : oauthScopes(metadata.scopes_supported) ?? []))]);
  if (!scopes) throw new Error('Invalid OAuth scopes');
  return { issuer, authorization, resource: canonicalResource(target), token: oauthEndpoint(auth.token_endpoint).href,
    register: auth.registration_endpoint === undefined ? undefined : oauthEndpoint(auth.registration_endpoint),
    revoke: auth.revocation_endpoint === undefined ? undefined : oauthEndpoint(auth.revocation_endpoint).href,
    methods: Array.isArray(auth.token_endpoint_auth_methods_supported) ? auth.token_endpoint_auth_methods_supported : undefined,
    offline: Array.isArray(auth.scopes_supported) && auth.scopes_supported.includes('offline_access'),
    enforceIssuer: auth.authorization_response_iss_parameter_supported === true, scopes };
}
