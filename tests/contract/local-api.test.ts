import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { benchmarkJson, benchmarkNames } from '../fixtures/benchmark-upload.ts';

test('local API restricts routing, pairing, mutations, file intake and session ownership', async () => {
  mkdirSync('.phase0', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.phase0', 'local-api-'));
  const secret = randomUUID();
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-api', gatewayCursor: () => 0, gatewaySince: () => [],
    aliases: ['synthetic-api'],
    builtInAliases: ['synthetic-api'],
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
    const helpersPath = '/api/settings/external-helpers';
    assert.equal((await fetch(origin + helpersPath)).status, 401);
    assert.equal((await post(helpersPath + '/recheck', { provider: 'codex_cli' }, { 'x-oep-csrf': 'bad' })).status, 403);
    const helpers = await (await fetch(origin + helpersPath, { headers: { cookie } })).json();
    assert.equal(helpers.length, 2);
    for (const { provider, enabled, confirmEachRun, termsConfirmed, revision, status } of helpers) {
      assert.equal(enabled, false);
      assert.equal(confirmEachRun, false);
      assert.deepEqual(status, { isolation: 'unavailable', installation: 'unknown', login: 'unknown' });
      const probe = await post(helpersPath + '/recheck', { provider });
      assert.equal(probe.status, 200);
      assert.deepEqual(await probe.json(), status);
      const blocked = await post(helpersPath, { provider, enabled: true, confirmEachRun, termsConfirmed, revision, warningAccepted: true });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).errorDetail.code, 'external-isolation-unavailable');
    }
    assert.equal((await fetch(origin + helpersPath + '/policy')).status, 401);
    const policy = await (await fetch(origin + helpersPath + '/policy', { headers: { cookie } })).json();
    assert.deepEqual(policy, { strictMode: false, revision: 0 });
    assert.equal((await fetch(origin + '/api/settings/model')).status, 401);
    assert.equal((await post('/api/settings/model', { alias: 'synthetic-api' }, { 'x-oep-csrf': 'bad' })).status, 403);
    assert.equal((await post('/api/settings/model', { alias: 'unapproved-alias' })).status, 400);
    const model = await (await fetch(origin + '/api/settings/model', { headers: { cookie } })).json();
    assert.deepEqual(model, { defaultAlias: 'synthetic-api', aliases: [{ alias: 'synthetic-api', healthy: true }], credentialsConfigured: true,
      selected: ['synthetic-api'], configuredDefaultAlias: 'synthetic-api', choices: ['synthetic-api'], discoveredAt: null,
      maxSelected: 8, restartRequired: false, canRestart: false });
    assert.equal((await post('/api/settings/model', { alias: 'synthetic-api', selected: ['synthetic-api', 'unknown-model'] })).status, 400);
    const noteEdit = { notes: { 'synthetic-api': 'Owner alias note' } };
    assert.equal((await post('/api/settings/model', noteEdit, { 'x-oep-csrf': 'bad' })).status, 403);
    for (const notes of [{ 'synthetic-api': 'x'.repeat(161) }, { 'unknown-model': 'Unknown model' }, { 'synthetic-api': null }]) {
      const rejected = await post('/api/settings/model', { notes });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).errorDetail.code, 'invalid-model-note');
    }
    const savedNote = await post('/api/settings/model', noteEdit);
    assert.equal(savedNote.status, 200);
    assert.deepEqual(await savedNote.json(), { ...model, modelNotes: { 'synthetic-api': { mappedModel: null, note: 'Owner alias note' } } });
    assert.equal((await post('/api/settings/model/test', { alias: 'unknown-model' })).status, 400);
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
    const benchmarkUpload = (path: string, name: string, type: string) =>
      fetch(origin + path + '/attachments', { method: 'POST',
        headers: { ...headers, 'content-type': type, 'x-oep-filename': encodeURIComponent(name) }, body: benchmarkJson });
    const expectBenchmark = async (path: string, name: string, type: string) => {
      const response = await benchmarkUpload(path, name, type);
      const result = await response.json();
      assert.equal(response.status, 201, `${name} (${type}): ${result.errorDetail?.code ?? 'upload'}`);
      assert.equal(result.name, name);
      assert.equal(result.mime, 'text/plain');
      assert.equal(result.bytes, Buffer.byteLength(benchmarkJson));
      assert.equal(result.converted, false);
      assert.ok(!('path' in result));
      const preview = await fetch(origin + path + '/attachments/' + result.id + '/preview', { headers: { cookie } });
      assert.equal(preview.status, 200);
      assert.equal(await preview.text(), benchmarkJson);
    };
    for (const name of benchmarkNames) {
      for (const type of ['application/octet-stream', 'application/json']) await expectBenchmark(a, name, type);
    }
    // A file-only snapshot preserves the session row but omits its empty attachment directories.
    const restoredWorkspace = join(root, 'sessions', second.id);
    rmdirSync(join(restoredWorkspace, 'attachments'));
    rmdirSync(restoredWorkspace);
    await expectBenchmark(b, benchmarkNames[0], 'application/octet-stream');

    const { id: blockedSession } = await (await post('/api/sessions', { agent: 'inspector' })).json();
    const scoped = '/api/agents/main/workspaces/legacy-default/sessions/' + blockedSession;
    const blockedFolder = join(root, 'sessions', blockedSession, 'attachments');
    rmdirSync(blockedFolder);
    writeFileSync(blockedFolder, 'synthetic storage blocker');
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await benchmarkUpload(scoped, benchmarkNames[1], 'application/json');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).errorDetail.code, 'upload-storage-unavailable');
    }
    assert.equal(readFileSync(blockedFolder, 'utf8'), 'synthetic storage blocker');
    unlinkSync(blockedFolder);
    await expectBenchmark(scoped, benchmarkNames[1], 'application/json');

    // Fail source registration after the original is staged and the attachment insert has run.
    const savedFiles = readdirSync(blockedFolder);
    using fault = new DatabaseSync(join(root, 'web.sqlite'));
    fault.exec("CREATE TRIGGER synthetic_upload_fault BEFORE INSERT ON external_sources BEGIN SELECT RAISE(ABORT, 'synthetic private storage detail'); END");
    try {
      const response = await benchmarkUpload(scoped, benchmarkNames[0], 'application/json');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).errorDetail.code, 'unavailable');
      assert.deepEqual(readdirSync(blockedFolder), savedFiles);
      const state = await (await fetch(origin + scoped + '/state', { headers: { cookie } })).json();
      assert.equal(state.attachments.length, 1);
      assert.ok(state.attachments[0].sourceId);
    } finally { fault.exec('DROP TRIGGER synthetic_upload_fault'); }
    await expectBenchmark(scoped, benchmarkNames[0], 'application/json');

    const diagnostics = scoped + '/attachment-diagnostics';
    assert.equal((await post(diagnostics, { code: 'upload-client-file-read' }, { 'x-oep-csrf': 'bad' })).status, 403);
    assert.equal((await post(diagnostics, { code: root })).status, 400);
    assert.equal((await post(diagnostics, { code: 'upload-client-file-read', filename: benchmarkNames[0] })).status, 400);
    assert.equal((await post(diagnostics, { code: 'upload-client-file-read' })).status, 200);
    const audit = readFileSync(join(root, 'web-uploads.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(audit.map(({ code }) => code),
      [...Array(4).fill('upload-storage-unavailable'), 'upload-unexpected', 'upload-client-file-read']);
    for (const entry of audit) assert.deepEqual(entry,
      { event: 'attachment-upload-failed', code: entry.code, at: new Date(entry.at).toISOString() });

    writeFileSync(join(root, 'sessions', first.id, 'attachments', 'staging-00000000-0000-0000-0000-000000000000.tmp'), 'orphan');
    assert.equal((await post('/api/stop', {})).status, 202);
    assert.equal(stops, 1);
    assert.match(readFileSync(join(root, 'web.sqlite')).subarray(0, 16).toString(), /SQLite/);
  } finally { await server.close(); }
});
