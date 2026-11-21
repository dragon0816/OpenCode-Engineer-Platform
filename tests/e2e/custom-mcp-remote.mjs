import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setDefaultCACertificates, getCACertificates } from 'node:tls';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { testCustomMcp } from '../../apps/launcher/src/custom-mcp-probe.ts';
import { validateCustomRemoteMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { sendRemoteMcp } from '../../scripts/windows/custom-mcp-remote.mjs';

const root = dataDirectory();
const openssl = [join(process.env.ProgramFiles ?? '', 'Git/usr/bin/openssl.exe'), 'openssl'].find((path) => existsSync(path) || path === 'openssl');
const key = join(root, 'test.key');
const cert = join(root, 'test.pem');
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
  '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const pem = readFileSync(cert, 'utf8');
const received = [];
const stub = createServer({ key: readFileSync(key), cert: pem }, (request, response) => {
  received.push(request.url ?? '');
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: 'https://example.invalid/redirection' }).end();
  } else if (request.url === '/auth') {
    response.writeHead(401).end();
  } else {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'synthetic-session' });
    response.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n');
  }
  request.resume();
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
try {
  const port = stub.address().port;
  const server = validateCustomRemoteMcp('a'.repeat(32), { name: 'Synthetic HTTPS', transport: 'remote',
    url: `https://127.0.0.1:${port}/mcp`, localService: true, enabled: true, headers: [],
    timeouts: { startup: 3000, catalog: 3000, execution: 3000 }, appliesToProjects: [], dataScope: '' }, []);
  assert.deepEqual(await testCustomMcp(server), { ok: false, reason: '無法驗證 TLS 憑證或建立安全連線。' });
  assert.deepEqual(await testCustomMcp({ ...server, localService: false }), { ok: false, reason: '網址遭拒絕。請檢查位址與重新導向設定。' });
  setDefaultCACertificates([...getCACertificates('default'), pem]);
  const session = {};
  const call = (path) => sendRemoteMcp({ ...server, url: new URL(path, server.url).href },
    { jsonrpc: '2.0', id: 1, method: 'initialize' }, session, {}, AbortSignal.timeout(3000));
  assert.deepEqual(await call('/mcp'), { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
  assert.deepEqual(session, { id: 'synthetic-session', version: '2025-06-18' });
  await assert.rejects(call('/auth'), /^Error: auth$/);
  await assert.rejects(call('/redirect'), /^Error: url$/);
  assert.deepEqual(received, ['/mcp', '/auth', '/redirect']);
  console.log('Pinned HTTPS MCP transport verified for TLS rejection, URL rejection, SSE, auth and redirect refusal.');
} finally {
  await new Promise((resolve) => stub.close(() => resolve()));
}

