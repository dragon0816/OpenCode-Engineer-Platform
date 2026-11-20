import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectStagedFile, maxUploadBytes, uploadPolicy } from './attachment-probe.ts';
import { evaluate, fixture } from './knowledge-baseline.ts';
import { sse } from './probe-http.ts';

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
