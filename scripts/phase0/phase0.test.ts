import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectStagedFile, maxUploadBytes, uploadPolicy } from './attachment-probe.ts';
import { evaluate, fixture } from './knowledge-baseline.ts';
import { finishFailedTurn, listen, ProbeDeadlineError, ProbeTransportError, send, sse, subscribeEventStream, turnFailure, until, waitForExit } from './probe-http.ts';
import { check, reconnectionAudit, verifyAliasRuns, verifySecurity, verifyToolAnswer } from './probe-assertions.ts';
import type { Trace } from './model-probe.ts';
import { onlyExpectedListener, ownerCheckedFetch, ownsWindowsPeer, parseListeners } from './probe-listeners.ts';

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
  let acceptedPort: number | undefined;
  let checkedPort: number | undefined;
  const other = await listen(async (_, reply) => { followed++; send(reply, 200); });
  const first = await listen(async (request, reply) => { calls++; acceptedPort = request.socket.remotePort; reply.writeHead(302, { location: other.url }).end(); });
  try {
    const headers = { authorization: 'Basic synthetic-fixture' };
    await assert.rejects(ownerCheckedFetch(first.url, () => false, () => true)(first.url, { headers }), /listener ownership/);
    assert.equal(calls, 0);
    await assert.rejects(ownerCheckedFetch(first.url, () => true, () => false)(first.url, { headers }), /peer ownership/);
    assert.equal(calls, 0);
    await assert.rejects(ownerCheckedFetch(first.url, () => true, (peer) => {
      checkedPort = peer.clientPort;
      return true;
    })(first.url, { headers, redirect: 'follow' }), /redirect refused/);
    assert.equal(calls, 1);
    assert.equal(acceptedPort, checkedPort);
    assert.equal(followed, 0);
  } finally { first.close(); other.close(); }
});

test('Windows peer attribution requires established reversed tuple and the expected child PID', () => {
  const tuple = { serverPort: 10101, clientPort: 20202 };
  const line = (local: number, remote: number, state: string, owner: number) => ` TCP 127.0.0.1:${local} 127.0.0.1:${remote} ${state} ${owner}`;
  const correct = line(tuple.serverPort, tuple.clientPort, 'ESTABLISHED', 42);
  assert.equal(ownsWindowsPeer(correct, 42, tuple), true);
  assert.equal(ownsWindowsPeer(correct, 43, tuple), false);
  assert.equal(ownsWindowsPeer(line(tuple.clientPort, tuple.serverPort, 'ESTABLISHED', 42), 42, tuple), false);
  assert.equal(ownsWindowsPeer(line(tuple.serverPort, tuple.clientPort, 'LISTENING', 42), 42, tuple), false);
});

test('a real deadline is distinct from transport failure and an unrelated TypeError escapes the turn', async () => {
  await assert.rejects(until(async () => undefined, 5), (error) => turnFailure(error) === 'deadline');
  const wrapped = (cause: Error) => Object.assign(new Error('wrapper', { cause }), { name: 'ClientError', reason: 'Transport' });
  assert.equal(turnFailure(wrapped(new ProbeDeadlineError())), 'deadline');
  assert.equal(turnFailure(wrapped(new ProbeTransportError())), 'transport-error');
  const bug = new TypeError('unrelated synthetic program failure');
  assert.throws(() => turnFailure(bug), (error) => error === bug);
  assert.throws(() => turnFailure(wrapped(bug)), (error) => error === bug);
});

test('turn cleanup preserves the original deadline and rejects unexpected wrapped or direct failures', async () => {
  const deadline = new ProbeDeadlineError();
  assert.equal(await finishFailedTurn(deadline, async () => undefined), 'deadline');
  const defect = new TypeError('Synthetic interrupt defect');
  for (const failure of [defect, Object.assign(new Error('SDK transport', { cause: defect }), { name: 'ClientError', reason: 'Transport' }),
    new ProbeTransportError(), new ProbeDeadlineError(), new DOMException('unrelated timeout', 'TimeoutError')]) {
    await assert.rejects(finishFailedTurn(deadline, async () => { throw failure; }),
      (error) => error instanceof AggregateError && error.errors[0] === deadline && error.errors[1] === failure);
  }
});

test('supervisor exit cancels its deadline timer and a real timeout returns null', async () => {
  const moduleUrl = pathToFileURL(resolve('scripts/phase0/probe-http.ts')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { waitForExit } from ${JSON.stringify(moduleUrl)}; if (await waitForExit(Promise.resolve(7), 12000) !== 7) process.exitCode = 1;`],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await waitForExit(new Promise(() => undefined), 10), null);
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
  const operations = [{ sessionID: 'a', id: 'one' }, { sessionID: 'b', id: 'two' }];
  let dispatched = 0;
  const receiver = await listen(async (_, reply) => { dispatched++; send(reply, 200, {}); });
  try {
    const transport = ownerCheckedFetch(receiver.url, () => true, () => true, audit.observePrompt);
    const submit = async ({ sessionID, id }: typeof operations[number]) => {
      const response = await transport(`${receiver.url}/api/session/${sessionID}/prompt`, { method: 'POST', body: JSON.stringify({ id }) });
      assert.equal(response.status, 200);
      await response.json();
    };
    await submit(operations[0]);
    await submit(operations[1]);
    assert.equal(dispatched, 2);
    audit.receive('{"sessionID":"a"}');
    assert.doesNotThrow(() => audit.verify(operations, [3, 5, 8]));
    assert.throws(() => audit.verify(operations, [3, 5, 5001]), /reconnectDeadline/);
    assert.throws(() => audit.verify([{ ...operations[0], id: operations[1].id }, operations[1]], [3, 5, 8]), /sender/);
    assert.throws(() => audit.verify([operations[1], operations[1]], [3, 5, 8]), /sender/);
    const duplicateWithinOneSend = async () => {
      await submit(operations[1]);
      const raw = new Request(`${receiver.url}/api/session/b/prompt`, { method: 'POST', body: JSON.stringify({ id: operations[1].id }) });
      assert.equal((await transport(raw)).status, 200);
    };
    await duplicateWithinOneSend();
    assert.equal(dispatched, 4);
    assert.throws(() => audit.verify(operations, [3, 5, 8]), /sender/);
    audit.receive('{"sessionID":"b"}');
    assert.throws(() => audit.verify(operations, [3, 5, 8]), /receiver/);
  } finally { receiver.close(); }
});

test('SSE EOF and abort before connected reject readiness and finish under the same deadline', { timeout: 1000 }, async () => {
  const eof = subscribeEventStream(async () => new Response(''), new AbortController().signal, () => {});
  await assert.rejects(eof.ready, /before server.connected/);
  await assert.rejects(eof.completed, /before server.connected/);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ProbeDeadlineError()), 15);
  try {
    const stalled = subscribeEventStream(() => new Promise(() => {}), deadline.signal, () => {});
    await assert.rejects(stalled.ready, ProbeDeadlineError);
    await assert.rejects(stalled.completed, ProbeDeadlineError);
  } finally { clearTimeout(timer); }
});

test('SSE rejects EOF or read errors after connected and only suppresses probe-initiated cancellation', { timeout: 1000 }, async () => {
  const hello = new TextEncoder().encode('data: {"type":"server.connected"}\n\n');
  for (const earlyEOF of [true, false]) {
    const fixture = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(hello);
      if (earlyEOF) controller.close();
    } });
    const stream = subscribeEventStream(async () => new Response(fixture), AbortSignal.timeout(500), () => undefined);
    await stream.ready;
    if (earlyEOF) {
      await assert.rejects(stream.during(new Promise(() => undefined)), /before reconciliation/);
      stream.close();
      await assert.rejects(stream.completed, /before reconciliation/);
    } else {
      assert.equal(await stream.during(Promise.resolve('reconciled')), 'reconciled');
      stream.close();
      await stream.completed;
    }
  }
  const defect = new TypeError('Synthetic stream cancellation defect');
  const fixture = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(hello); }, cancel() { throw defect; } });
  const stream = subscribeEventStream(async () => new Response(fixture), AbortSignal.timeout(500), () => undefined);
  await stream.ready;
  stream.close();
  await assert.rejects(stream.completed, (error) => error === defect);
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
    for (const file of ['scripts/phase0/install-hooks.mjs', 'scripts/phase0/secret-scan.mjs', '.githooks/pre-commit', '.githooks/pre-merge-commit', '.githooks/reference-transaction']) {
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

test('attachment documentation matches the wheel lock and the Windows quota semantics', () => {
  const wheels = readFileSync('scripts/phase0/requirements.txt', 'utf8').split(/\r?\n/).filter((line) => line.includes('--hash=sha256:'));
  const licensing = readFileSync('docs/validation/p0-s7-licensing.md', 'utf8');
  assert.match(licensing, new RegExp(`${wheels.length} 個 Python wheels`));
  const pdf = readFileSync('docs/validation/p0-s3-attachments.md', 'utf8');
  assert.match(pdf, /Windows PDF 子程序[^。]+2 秒週期檢查的 user-time 配額[^。]+5 秒 wall-clock timeout/);
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
