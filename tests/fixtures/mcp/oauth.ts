import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { syntheticMcpCertificate } from './tls.ts';

export async function syntheticOAuthMcp(root: string) {
  const certificate = syntheticMcpCertificate(root);
  const marker = () => 'oep-fixture-' + randomUUID();
  const client = { id: marker(), secret: marker() };
  const registrations = new Map<string, string>();
  const codes = new Map<string, URLSearchParams>();
  const tokens = new Map<string, { refresh: string; resource: string }>();
  const refresh = new Map<string, string>();
  const secrets = new Set([client.id, client.secret]);
  const paths: string[] = [];
  const requestedScopes: string[] = [];
  const callNames: string[] = [];
  let origin: string;
  let expire = false;
  let rejectAccess = false;
  let rejectRefresh = false;
  let useRedirect = false;
  let insufficientScope = false;
  let omitPkce = false;
  let mismatchIssuer = false;
  let refreshes = 0;
  let exchanges = 0;
  let revocations = 0;
  const issuer = () => origin + '/tenant';
  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  }
  const service = createServer(certificate, (request, response) => {
    void (async () => {
      const url = new URL(request.url!, origin);
      paths.push(url.pathname);
      const json = (value: object, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      const challenge = (resourcePath: string) =>
        `Basic realm="ignored, resource_metadata=spoof", Bearer realm="synthetic, test", resource_metadata="${origin}${resourcePath}", scope="messages.read"`;
      switch (url.pathname) {
        case '/resource': return json({ resource: origin + '/mcp', authorization_servers: [issuer()], scopes_supported: ['messages.more'] });
        case '/.well-known/oauth-protected-resource': return json({ resource: origin, authorization_servers: [issuer()], scopes_supported: ['files.read'] });
        case '/tenant/.well-known/openid-configuration':
          return json({ issuer: mismatchIssuer ? origin + '/different-tenant' : issuer(), authorization_endpoint: origin + '/consent',
            token_endpoint: origin + '/token', registration_endpoint: origin + '/register', revocation_endpoint: origin + '/revoke',
            authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
            ...(!omitPkce && { code_challenge_methods_supported: ['S256'] }) });
        case '/register': {
          const input = JSON.parse(await body(request));
          assert.equal(input.application_type, 'native');
          assert.equal(input.token_endpoint_auth_method, 'none');
          assert.deepEqual(input.grant_types, ['authorization_code', 'refresh_token']);
          assert.equal(input.redirect_uris.length, 1);
          assert.match(input.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
          const id = marker();
          secrets.add(id);
          registrations.set(id, input.redirect_uris[0]);
          return json({ client_id: id, token_endpoint_auth_method: 'none' }, 201);
        }
        case '/consent': {
          const args = url.searchParams;
          const id = args.get('client_id')!;
          const redirect = args.get('redirect_uri')!;
          assert.equal(args.get('response_type'), 'code');
          assert.equal(args.get('code_challenge_method'), 'S256');
          assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
          assert.ok(id === client.id || registrations.get(id) === redirect, 'Consent used the registered client and callback');
          assert.ok([origin + '/mcp', origin + '/fallback'].includes(args.get('resource')!), 'Consent used the specific MCP resource');
          requestedScopes.push(args.get('scope') ?? '');
          const code = marker();
          secrets.add(code);
          codes.set(code, args);
          const callback = new URL(redirect);
          callback.search = new URLSearchParams({ code, state: args.get('state')!, iss: issuer() }).toString();
          return response.writeHead(302, { Location: callback.href }).end();
        }
        case '/token': {
          if (useRedirect) return response.writeHead(302, { Location: origin + '/redirected-token' }).end();
          const args = new URLSearchParams(await body(request));
          const basic = 'Basic ' + Buffer.from(`${client.id}:${client.secret}`).toString('base64');
          if (request.headers.authorization) assert.ok(request.headers.authorization === basic, 'Client secret stayed in token endpoint authentication');
          let resource: string;
          if (args.get('grant_type') === 'authorization_code') {
            exchanges++;
            const code = args.get('code')!;
            const consent = codes.get(code);
            assert.ok(consent, 'The authorization code must be fresh');
            codes.delete(code);
            assert.ok((request.headers.authorization ? client.id : args.get('client_id')) === consent.get('client_id'), 'Exchange client matches consent');
            assert.equal(args.get('redirect_uri'), consent.get('redirect_uri'));
            assert.ok(createHash('sha256').update(args.get('code_verifier') ?? '').digest('base64url') === consent.get('code_challenge'), 'Token exchange verified S256');
            resource = consent.get('resource')!;
          } else {
            assert.equal(args.get('grant_type'), 'refresh_token');
            refreshes++;
            const previous = args.get('refresh_token')!;
            if (rejectRefresh || !refresh.has(previous)) return json({ error: 'invalid_grant', error_description: client.secret }, 400);
            resource = refresh.get(previous)!;
            refresh.delete(previous);
          }
          assert.equal(args.get('resource'), resource);
          const access = marker();
          const replacement = marker();
          secrets.add(access);
          secrets.add(replacement);
          refresh.set(replacement, resource);
          tokens.set(access, { refresh: replacement, resource });
          const expiresIn = expire ? 0 : 3600;
          expire = false;
          return json({ token_type: 'Bearer', access_token: access, refresh_token: replacement, expires_in: expiresIn });
        }
        case '/revoke': {
          const args = new URLSearchParams(await body(request));
          const token = args.get('token')!;
          assert.ok(refresh.delete(token), 'Sign-out revoked the latest refresh token');
          revocations++;
          for (const [value, pair] of tokens) if (pair.refresh === token) tokens.delete(value);
          return response.writeHead(200).end();
        }
        case '/mcp':
        case '/fallback': {
          const stateless = request.headers['mcp-protocol-version'] === '2026-07-28';
          if (stateless !== (url.pathname === '/mcp')) return response.writeHead(400).end();
          const bearer = request.headers.authorization?.slice(7);
          if (!bearer || tokens.get(bearer)?.resource !== url.href) {
            return response.writeHead(401, url.pathname === '/mcp' ? { 'WWW-Authenticate': challenge('/resource') } : {}).end();
          }
          assert.match(request.headers.authorization!, /^Bearer /);
          const input = JSON.parse(await body(request));
          if (stateless) {
            assert.equal(request.headers['mcp-session-id'], undefined);
            assert.equal(request.headers['mcp-method'], input.method);
            assert.equal(request.headers['mcp-name'], input.method === 'tools/call' ? input.params.name : undefined);
            assert.equal(input.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
            assert.deepEqual(input.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
            assert.ok(['tools/list', 'tools/call'].includes(input.method));
          }
          if (input.method === 'initialize') return json({ jsonrpc: '2.0', id: input.id, result: { protocolVersion: '2025-06-18' } });
          if (input.method === 'notifications/initialized') return response.writeHead(202).end();
          if (input.method === 'tools/list') {
            const schema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false };
            return json({ jsonrpc: '2.0', id: input.id, result: { tools: [
              { name: 'messages.read', inputSchema: schema, description: `Read synthetic messages ${bearer}` },
              { name: 'write_message', inputSchema: schema },
              { name: '../unsafe', inputSchema: schema },
            ] } });
          }
          assert.equal(input.method, 'tools/call');
          callNames.push(input.params.name);
          if (rejectAccess) { rejectAccess = false; return response.writeHead(401).end(); }
          if (insufficientScope) return response.writeHead(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="messages.write"' }).end();
          assert.deepEqual(input.params.arguments, { value: 7 });
          return json({ jsonrpc: '2.0', id: input.id, result: { content: [
            { type: 'text', text: `Synthetic message ${bearer} ${client.secret}` },
          ] } });
        }
        default: return response.writeHead(404).end();
      }
    })().catch(() => { response.destroy(); process.exitCode = 1; });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${(service.address() as AddressInfo).port}`;
  return { origin, certificate, client, secrets, paths, requestedScopes, callNames, registrations,
    stats: () => ({ exchanges, refreshes, revocations }),
    expireNext: () => { expire = true; },
    rejectNextAccess: () => { rejectAccess = true; },
    denyRefresh: (enabled: boolean) => { rejectRefresh = enabled; },
    redirectTokens: (enabled: boolean) => { useRedirect = enabled; },
    denyScope: (enabled: boolean) => { insufficientScope = enabled; },
    noPkce: (enabled: boolean) => { omitPkce = enabled; },
    wrongIssuer: (enabled: boolean) => { mismatchIssuer = enabled; },
    close: () => new Promise<void>((resolve) => service.close(() => resolve())),
  };
}
