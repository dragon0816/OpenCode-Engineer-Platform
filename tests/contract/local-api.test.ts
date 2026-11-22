import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';

test('local API restricts routing, pairing, mutations, file intake and session ownership', async () => {
  mkdirSync('.phase0', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.phase0', 'local-api-'));
  const secret = randomUUID();
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-api', gatewayCursor: () => 0, gatewaySince: () => [],
    aliases: ['synthetic-api'],
    aliasHealth: () => [{ alias: 'synthetic-api', healthy: true }],
    checkAliases: async () => true,
    setTurnBoundary: () => undefined,
    redact: (value: string) => value.replaceAll(secret, '[redacted]'),
    endpoint: { hidden: secret, request: async () => new Response(null, { status: 503 }) },
    client: {
      session: { create: async (input: { agent: string; location: object; model: object }) => ({ ...input, id: randomUUID() }) },
      message: { list: async () => ({ data: [] }) },
    },
  } as unknown as Runtime;
  let stops = 0;
  const server = await startAdapter(root, runtime, () => { stops++; });
  try {
    const url = new URL(server.pairURL());
    const origin = url.origin;
    const ticket = new URLSearchParams(url.hash.slice(1)).get('pair');
    const pair = () => fetch(`${origin}/api/pair`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }) });
    const html = await fetch(origin);
    assert.match(await html.text(), /<title data-i18n="ui\.oep-workbench"><\/title>/);
    for (const [locale, title] of [['zh-TW', 'OEP 工程工作台'], ['en', 'OEP Workbench']]) {
      const catalog = await fetch(origin + '/i18n/' + locale + '.js');
      assert.equal(catalog.status, 200);
      assert.match(catalog.headers.get('content-type')!, /^text\/javascript/);
      assert.ok((await catalog.text()).includes(title));
    }
    assert.match(html.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    for (const path of ['/', '/app.js', '/api.js', '/style.css', '/i18n.js', '/i18n/en.js', '/i18n/zh-TW.js']) {
      assert.ok(!(await (await fetch(origin + path)).text()).includes(secret));
    }
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(origin, { headers: { host: 'example.invalid' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject).end();
    });
    assert.equal(wrongHost, 403);
    const unpaired = await fetch(`${origin}/api/bootstrap`);
    assert.equal(unpaired.status, 401);
    assert.deepEqual(await unpaired.json(), {
      error: '請雙擊 Windows 啟動器開啟 OEP。',
      errorDetail: { code: 'launch-required', text: '請雙擊 Windows 啟動器開啟 OEP。' },
    });
    assert.equal((await fetch(origin, { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(origin, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/pair`, { method: 'OPTIONS' })).status, 405);
    const paired = await pair();
    assert.equal(paired.status, 200);
    assert.equal((await pair()).status, 403);
    const setCookie = paired.headers.get('set-cookie')!;
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(';')[0];
    const { csrf } = await paired.json();
    const headers = { cookie, origin, 'x-oep-csrf': csrf, 'content-type': 'application/json' };
    const post = (path: string, data: object, overrides: Record<string, string> = {}) => fetch(origin + path, {
      method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(data),
    });
    assert.equal((await post('/api/sessions', { agent: 'inspector' }, { origin: '' })).status, 403);
    assert.equal((await post('/api/sessions', { agent: 'inspector' }, { origin: 'null' })).status, 403);
    assert.equal((await post('/api/sessions', { agent: 'inspector' }, { 'x-oep-csrf': 'bad' })).status, 403);
    assert.equal((await post('/api/sessions', { agent: 'inspector' }, { cookie: '' })).status, 401);
    assert.equal((await post('/api/sessions', { agent: 'shell' })).status, 400);
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`, { headers: { cookie } })).json();
    assert.equal(bootstrap.csrf, csrf);
    assert.equal((await fetch(origin + '/api/settings/model')).status, 401);
    assert.equal((await post('/api/settings/model', { alias: 'synthetic-api' }, { 'x-oep-csrf': 'bad' })).status, 403);
    assert.equal((await post('/api/settings/model', { alias: 'unapproved-alias' })).status, 400);
    const model = await (await fetch(origin + '/api/settings/model', { headers: { cookie } })).json();
    assert.deepEqual(model, { defaultAlias: 'synthetic-api', aliases: [{ alias: 'synthetic-api', healthy: true }], credentialsConfigured: true });
    assert.equal(bootstrap.job.state, 'awaiting_review');
    const first = await (await post('/api/sessions', { agent: 'inspector' })).json();
    const second = await (await post('/api/sessions', { agent: 'workbook' })).json();
    const a = `/api/sessions/${first.id}`;
    const b = `/api/sessions/${second.id}`;
    for (const path of ['/api/info', '/api/event', '/api/anything', `${a}/artifacts/${randomUUID()}`]) {
      assert.equal((await fetch(origin + path, { headers: { cookie } })).status, 404);
    }
    assert.equal((await fetch(`${origin}${a}/events`)).status, 401);
    assert.equal((await fetch(`${origin}${a}/artifacts/${randomUUID()}`)).status, 401);
    assert.equal((await fetch(`${origin}${a}/artifacts/%2e%2e%2fworkbook`, { headers: { cookie } })).status, 400);
    const attachment = (name: string, bytes: BodyInit, type = 'application/octet-stream') =>
      fetch(`${origin}${a}/attachments`, { method: 'POST',
        headers: { ...headers, 'content-type': type, 'x-oep-filename': encodeURIComponent(name) }, body: bytes });
    for (const name of ['../fixture.txt', 'file:///C:/fixture.txt', '\\\\test.invalid\\fixture.txt', 'fixture.txt:stream', 'C:\\fixture.txt']) {
      assert.equal((await attachment(name, 'synthetic text')).status, 400, name);
    }
    assert.equal((await attachment('script.exe', 'text')).status, 415);
    assert.equal((await attachment('invalid.png', 'plain text', 'image/png')).status, 415);
    const oversize = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(origin + a + '/attachments', { method: 'POST',
        headers: { ...headers, 'content-length': 20 * 1024 * 1024 + 1, 'x-oep-filename': 'large.txt' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
      request.flushHeaders();
    });
    assert.equal(oversize, 413);
    assert.equal((await attachment('bad.txt', Buffer.from([255]))).status, 422);
    const original = await attachment('合成資料.txt', 'synthetic text');
    assert.equal(original.status, 201);
    const source = await original.json();
    assert.equal(source.name, '合成資料.txt');
    assert.ok(!('path' in source));
    assert.equal((await post(`${b}/turns`, { id: randomUUID(), text: 'Open attachment', attachments: [source.id], workbook: false })).status, 404);
    for (const bad of ['../fixture.txt', 'file:///C:/fixture.txt', 'data:text/plain,abc', 'https://example.invalid/doc.pdf']) {
      assert.equal((await post(`${a}/turns`, { id: randomUUID(), text: 'Open attachment', attachments: [bad], workbook: false })).status, 400);
    }
    const state = await (await fetch(origin + a + '/state', { headers: { cookie } })).json();
    assert.equal(state.attachments.length, 1);
    assert.equal(state.messages.length, 0);
    assert.ok(!JSON.stringify(state).includes(root));
    writeFileSync(join(root, 'sessions', first.id, 'attachments', 'staging-00000000-0000-0000-0000-000000000000.tmp'), 'orphan');
    assert.equal((await post('/api/stop', {})).status, 202);
    assert.equal(stops, 1);
    assert.match(readFileSync(join(root, 'web.sqlite')).subarray(0, 16).toString(), /SQLite/);
  } finally { await server.close(); }
});
