import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectStagedFile, maxUploadBytes, uploadPolicy } from './attachment-probe.ts';
import { evaluate, fixture } from './knowledge-baseline.ts';
import { listen, send, sse } from './probe-http.ts';
import { check, reconnectionAudit, verifyAliasRuns, verifySecurity, verifyToolAnswer } from './probe-assertions.ts';
import type { Trace } from './model-probe.ts';
import { onlyExpectedListener, ownerCheckedFetch, parseListeners } from './probe-listeners.ts';

test('socket ownership counts all child listeners and excludes unrelated socket inodes', () => {
  const row = (host: string, inode: number) => `0: ${host}:1234 00000000:0000 0A 0:0 0:0 0 1000 0 ${inode}`;
  const owned = new Set(['44']);
  const ipv4 = parseListeners(`header\n${row('0100007F', 44)}\n${row('00000000', 45)}`, 4, owned);
  const ipv6 = parseListeners(`header\n${row('00000000000000000000000000000000', 44)}`, 6, owned);
  assert.equal(onlyExpectedListener(ipv4, 0x1234), true);
  assert.equal(onlyExpectedListener([...ipv4, ...ipv6], 0x1234), false);
  assert.equal(onlyExpectedListener(ipv4, 0x1235), false);
  assert.equal(onlyExpectedListener([], 0x1234), false);
});

test('guarded client sends no credentials without ownership and follows no redirects', async () => {
  let calls = 0;
  let followed = 0;
  const other = await listen(async (_, reply) => { followed++; send(reply, 200); });
  const first = await listen(async (_, reply) => { calls++; reply.writeHead(302, { location: other.url }).end(); });
  try {
    const headers = { authorization: 'Basic synthetic-fixture' };
    await assert.rejects(ownerCheckedFetch(first.url, () => false)(first.url, { headers }), /ownership/);
    assert.equal(calls, 0);
    await assert.rejects(ownerCheckedFetch(first.url, () => true)(first.url, { headers, redirect: 'follow' }));
    assert.equal(calls, 1);
    assert.equal(followed, 0);
  } finally { first.close(); other.close(); }
});

test('probe assertions reject incomplete contracts, unhealthy aliases and incorrect tool answers', () => {
  for (const field of ['create', 'prompt', 'active', 'interrupt', 'permission', 'cleared', 'first', 'after', 'status', 'outcome']) {
    assert.throws(() => check('contract', { [field]: false }), new RegExp(field));
  }
  const aliases = ['a', 'b'];
  const ten = new Map(aliases.map((alias) => [alias, Array<boolean>(10).fill(true)]));
  assert.doesNotThrow(() => verifyAliasRuns(aliases, new Set(aliases), ten));
  assert.throws(() => verifyAliasRuns(aliases, new Set(['a']), ten), /healthy/);
  assert.throws(() => verifyAliasRuns(aliases, new Set(aliases), new Map([['a', ten.get('a')!]])), /tenTurns/);
  ten.get('b')![0] = false;
  assert.throws(() => verifyAliasRuns(aliases, new Set(aliases), ten), /allPassed/);
  const trace = { calls: [{ name: 'fixture_lookup' }] } as Trace;
  assert.equal(verifyToolAnswer([trace], 'TOKEN', ['TOKEN']), true);
  assert.equal(verifyToolAnswer([trace], 'wrong', ['TOKEN']), false);
  trace.calls[0].name = 'unexpected';
  assert.equal(verifyToolAnswer([trace], 'TOKEN', ['TOKEN']), false);
});

test('every security observable can fail the S5 probe', () => {
  const expected = { bind: true, noAuth: 401, authenticated: 200, upstreamLocalhostCors: true, proxy: 200,
    badHost: 403, badOrigin: 403, missingCsrf: 403, noSession: 401, passwordVisible: false };
  assert.doesNotThrow(() => verifySecurity(expected));
  for (const [key, value] of Object.entries(expected)) {
    assert.throws(() => verifySecurity({ ...expected, [key]: typeof value === 'boolean' ? !value : 418 }), /S5/);
  }
});

test('the receiver detects foreign delivery and the sender detects duplicate submissions under a shared deadline', async () => {
  const audit = reconnectionAudit('a');
  await audit.send('operation', async () => {});
  audit.receive('{"sessionID":"a"}');
  assert.doesNotThrow(() => audit.verify(['operation'], [3, 5, 8]));
  assert.throws(() => audit.verify(['operation'], [3, 5, 5001]), /reconnectDeadline/);
  await audit.send('operation', async () => {});
  assert.throws(() => audit.verify(['operation'], [3, 5, 8]), /sender/);
  audit.receive('{"sessionID":"b"}');
  assert.throws(() => audit.verify(['operation'], [3, 5, 8]), /receiver/);
});

test('secret scan detects private IPv4 with or without a scheme or port using no runtime values', async () => {
  const moduleUrl = pathToFileURL(resolve('scripts/phase0/secret-scan.mjs')).href;
  const { detect }: { detect: (text: string) => string[] } = await import(moduleUrl);
  // Build synthetic addresses at runtime so a repository scan still rejects literal addresses in source files.
  const ip = (...octets: number[]) => octets.join('.');
  for (const sample of [
    `bind=${ip(10, 0, 0, 0)}`, `[${ip(10, 255, 255, 255)}:4000]`, `${ip(172, 16, 0, 0)}:443`,
    `"${ip(172, 31, 255, 255)}"`, `host ${ip(192, 168, 0, 1)}.`, `http://${ip(192, 168, 255, 255)}:8080/path`,
  ]) assert.deepEqual(detect(sample), ['private IPv4']);

  for (const sample of [
    ip(172, 15, 255, 255), ip(172, 32, 0, 0), ip(192, 169, 0, 1), ip(127, 0, 0, 1),
    ip(203, 0, 113, 5), ip(110, 1, 2, 3), ip(10, 256, 0, 1), `${ip(10, 1, 2, 3)}.example`,
    ip(1, 10, 1, 2, 3), `address-${ip(10, 1, 2, 3).replaceAll('.', '-')}`,
  ]) assert.deepEqual(detect(sample), []);
});

test('secret scan catches escaped, encoded and split markers, ULA and bare internal hosts', async () => {
  const { detect }: { detect: (text: string) => string[] } = await import(pathToFileURL(resolve('scripts/phase0/secret-scan.mjs')).href);
  const privateHost = ['synthetic-fixture', 'internal'].join('.');
  const ula = ['fd12', '', 'abcd'].join(':');
  assert.deepEqual(detect(privateHost), ['internal hostname']);
  assert.deepEqual(detect(Buffer.from(privateHost).toString('base64url')), ['internal hostname']);
  assert.deepEqual(detect(privateHost.replace('.', '%252e')), ['internal hostname']);
  assert.deepEqual(detect(privateHost.replace('.', '\\u002e')), ['internal hostname']);
  assert.deepEqual(detect(privateHost.replace('.', '." + "')), ['internal hostname']);
  assert.deepEqual(detect(`[${ula}]:443`), ['IPv6 unique local address']);
  for (const negative of ['fixture.example', '::1', ['2001', 'db8', '', '1'].join(':'), `${privateHost}.example`, 'fczz::1']) {
    assert.deepEqual(detect(negative), []);
  }
});

test('installed pre-commit hook blocks a real staged canary and accepts clean content', () => {
  mkdirSync('.phase0', { recursive: true });
  const scratch = mkdtempSync(resolve('.phase0', 'hook-canary-'));
  const run = (command: string, ...args: string[]) => spawnSync(command, args, { cwd: scratch, encoding: 'utf8' });
  const git = (...args: string[]) => run('git', ...args);
  try {
    assert.equal(git('init', '-q').status, 0);
    mkdirSync(join(scratch, 'scripts/phase0'), { recursive: true });
    mkdirSync(join(scratch, '.githooks'));
    for (const file of ['scripts/phase0/install-hooks.mjs', 'scripts/phase0/secret-scan.mjs', '.githooks/pre-commit', '.githooks/pre-merge-commit']) {
      copyFileSync(file, join(scratch, file));
    }
    assert.equal(run(process.execPath, 'scripts/phase0/install-hooks.mjs').status, 0);
    assert.equal(git('config', '--worktree', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
    const path = join(scratch, 'canary.txt');
    const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Verify hook fixture');
    writeFileSync(path, ['fixture', 'internal'].join('.'));
    assert.equal(git('add', 'canary.txt').status, 0);
    const blocked = commit();
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /"hits":1/);
    assert.notEqual(git('rev-parse', '--verify', 'HEAD').status, 0);
    writeFileSync(path, 'safe synthetic fixture');
    assert.equal(git('add', 'canary.txt').status, 0);
    assert.equal(commit().status, 0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('knowledge fixture retains all four annotated classes and deterministic recall', () => {
  const result = evaluate(readFileSync(fixture), 2);
  assert.deepEqual(result.counts, { answerable: 24, 'no-evidence': 20, conflict: 2, injection: 2 });
  assert.equal(result.passages, 30);
  assert.deepEqual(result.misses, []);
  assert.equal(result.recallAt5, 1);
  assert.equal(result.latencyMs.samples, 96);
});

test('attachment ingress rejects client URIs, Windows path syntax and oversized inputs', () => {
  const mime = 'image/png';
  for (const name of ['file:///C:/untrusted.png', 'data:image/png;base64,AAA', 'http://fixture.invalid/icon.png', 'https://fixture.invalid/icon.png']) {
    assert.equal(uploadPolicy(name, mime, 360), 'uri');
  }
  for (const name of ['..\\icon.png', '..', 'a/icon.png', 'AUX.png', '\\\\host\\share\\icon.png', 'icon.png:zone', 'icon.png.']) {
    assert.notEqual(uploadPolicy(name, mime, 360), 'accepted');
  }
  assert.notEqual(uploadPolicy('C:\\icon.png', mime, 360), 'accepted');
  assert.equal(uploadPolicy('image.png', mime, maxUploadBytes + 1), 'size');
  assert.equal(uploadPolicy('image.png', mime, maxUploadBytes), 'accepted');
  assert.equal(uploadPolicy('sample.bin', mime, 10), 'mime');
  assert.equal(uploadPolicy('image.png', 'text/plain', 10), 'mime');
});

test('Windows Unicode/space file inspection accepts a file and rejects a junction', { skip: process.platform !== 'win32' }, () => {
  mkdirSync('.phase0', { recursive: true });
  const scratch = mkdtempSync(join('.phase0', 'attachments-中文 '));
  try {
    const root = join(scratch, 'root');
    const sibling = join(scratch, 'outside');
    mkdirSync(root);
    mkdirSync(sibling);
    writeFileSync(join(root, '合成 圖片.png'), 'synthetic file');
    symlinkSync(sibling, join(root, 'junction.png'), 'junction');
    assert.equal(inspectStagedFile(root, '合成 圖片.png', 'image/png'), 'accepted');
    assert.equal(inspectStagedFile(root, 'junction.png', 'image/png'), 'rejected');
    assert.equal(inspectStagedFile(root, '..\\outside\\file.png', 'image/png'), 'rejected');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('SSE consumes split UTF-8 lines and ignores comments', async () => {
  const bytes = Buffer.from(': heartbeat\r\ndata: {"text":"合成"}\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events: string[] = [];
  for await (const event of sse(stream)) events.push(event);
  assert.deepEqual(events, ['{"text":"合成"}', '[DONE]']);
});
