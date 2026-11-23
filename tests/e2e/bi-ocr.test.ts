import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { documentOcr } from '../../apps/adapter/src/bi/document-ocr.ts';
import { documentWorker } from '../../apps/adapter/src/bi/document-worker.ts';
import type { Projection } from '../../apps/adapter/src/bi/document-worker.ts';
import { ocrLanguages } from '../../apps/adapter/src/bi/windows-ocr.ts';
import { startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { ocrVision } from '../../apps/adapter/src/opencode/ocr-vision.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { pdf, stream } from '../fixtures/knowledge/pdf.ts';
import { chromium } from './chromium.ts';
import { selectLocale } from './gui-locales.ts';
import { dataDirectory } from './test-data.ts';
import { webAPI } from './web-api.ts';

const alias = 'gpt-5.4-synthetic';
const textAlias = 'synthetic-text';
const scanQuote = 'ALPHA setting is 13 mm.';
const visionQuote = 'MODEL setting is 23 mm.';
const textLayer = 'INDEX setting is 99 mm.';
const limits = { language: 'auto', mode: 'auto' } as const;
const signal = () => AbortSignal.timeout(30_000);
const reply = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });

function fixtures(root: string) {
  writeFileSync(join(root, 'original.pdf'), pdf([stream(textLayer), stream(scanQuote + ' BETA setting is 17 mm.'), stream('A7')]));
  execFileSync(process.env.OEP_PYTHON || 'python', ['-I', '-B', 'tests/fixtures/knowledge/ocr.py', root], { windowsHide: true });
  return { png: join(root, 'scan.png'), sparse: join(root, 'sparse.png'), scanned: join(root, 'scanned.pdf'), mixed: join(root, 'mixed.pdf') };
}

type TestWire = { model: string; max_tokens: number; messages: { role: string; content: string | (
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: string } })[] }[] };

function gateway(fetch: typeof globalThis.fetch) {
  return startGateway({ url: 'http://example.invalid/v1', key: randomUUID(), alias: textAlias, aliases: [textAlias, alias],
    web: true, trace: () => {}, fetch });
}

test('Windows OCR reads generated scanned PDF, PNG, and mixed PDF and returns line bounds', { timeout: 45_000 }, async t => {
  if (!(await ocrLanguages(signal())).includes('en-US')) return t.skip('Windows.Media.Ocr en-US recognition language is unavailable');
  const root = dataDirectory();
  const files = fixtures(root);
  const jpeg = join(root, 'scan.jpg');
  execFileSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Drawing\n$image = [Drawing.Image]::FromFile($env:OEP_FIXTURE_PNG)\n' +
    'try { $image.Save($env:OEP_FIXTURE_JPEG, [Drawing.Imaging.ImageFormat]::Jpeg) } finally { $image.Dispose() }',
  ], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, OEP_FIXTURE_PNG: files.png, OEP_FIXTURE_JPEG: jpeg } });
  const timings: string[] = [];
  for (const [name, file, kind, page, language] of [
    ['scanned PDF', files.scanned, 'pdf', 1, 'auto'], ['PNG', files.png, 'image', 1, 'en-US'],
    ['JPEG', jpeg, 'image', 1, 'en-US'], ['mixed PDF', files.mixed, 'pdf', 2, 'auto'],
  ] as const) {
    const local = documentOcr({ language, mode: 'local' }, {
      select: () => assert.fail('Local OCR must not select a Gateway model'),
      probeSupport: async () => assert.fail('Local OCR must not probe the Gateway'),
      recognize: async () => assert.fail('Local OCR must not send an image'),
    });
    const started = performance.now();
    const result = await documentWorker<Projection>(['convert', kind, ''], readFileSync(file), signal(), local);
    timings.push(name + ' ' + Math.round(performance.now() - started) + ' ms');
    assert.deepEqual(result.pages?.map(p => p.status), page === 2 ? ['text-layer', 'local'] : ['local']);
    const segment = result.segments.at(-1)!;
    assert.equal(segment.locator, 'page:' + page);
    assert.deepEqual(segment.ocr, { provenance: 'OCR', engine: 'Windows.Media.Ocr (en-US)' });
    assert.ok(segment.text.includes(scanQuote));
    const line = segment.lines?.find(({ text }) => text.includes(scanQuote));
    assert.ok(line);
    const [x, y, w, h] = line.box;
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= segment.width! && y + h <= segment.height!);
    if (page === 2) assert.deepEqual(result.segments[0], { locator: 'page:1', text: textLayer });
  }
  t.diagnostic('Local OCR with conversion, per page: ' + timings.join(', '));
});

test('probes the relay once, falls back for sparse pages, and preserves local text when the probe is rejected', { timeout: 60_000 }, async t => {
  const root = dataDirectory();
  const files = fixtures(root);
  const canRead = (await ocrLanguages(signal())).includes('en-US');
  for (const supported of [true, false]) {
    const image = readFileSync(supported ? files.sparse : files.png);
    const data = image.toString('base64');
    let probes = 0;
    let uploads = 0;
    const relay = await gateway(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as TestWire;
      const parts = body.messages[1].content;
      assert.equal(body.model, alias);
      assert.ok(Array.isArray(parts));
      const part = parts.find(p => p.type === 'image_url');
      assert.ok(part);
      if (part.image_url.detail === 'low') {
        probes++;
        assert.doesNotMatch(part.image_url.url, /scan\.png/);
        assert.ok(part.image_url.url.length < 400 && !part.image_url.url.endsWith(data));
        assert.equal(body.max_tokens, 256);
        return supported ? reply('red green blue yellow') : new Response(null, { status: 415 });
      }
      uploads++;
      assert.equal(body.max_tokens, 4096);
      assert.equal(part.image_url.url, 'data:image/png;base64,' + data);
      return reply(JSON.stringify({ text: visionQuote }));
    });
    try {
      const vision = ocrVision(relay, new ModelSeat(), [textAlias, alias], () => textAlias);
      assert.equal(vision.select(textAlias), alias);
      const started = performance.now();
      assert.equal(await vision.probeSupport(alias, signal()), supported ? 'supported' : 'unsupported');
      const probeMs = Math.round(performance.now() - started);
      const recognize = documentOcr({ ...limits, mode: supported ? 'auto' : 'model' }, vision);
      const page = await recognize({ page: 1, mime: 'image/png', base64: data }, signal());
      if (supported) {
        assert.deepEqual(page, { status: 'model', text: visionQuote, ocr: { provenance: 'OCR', engine: alias } });
        const cached = performance.now();
        assert.deepEqual(await vision.recognize(alias, image, 'image/png', 'en-US', signal()), { text: visionQuote });
        t.diagnostic(`Synthetic Gateway image probe ${probeMs} ms, cached vision page through relay ${Math.round(performance.now() - cached)} ms`);
      } else {
        assert.equal(page.warning, 'vision-unsupported');
        if (canRead) {
          assert.equal(page.status, 'local');
          assert.ok(page.text?.includes(scanQuote));
        }
        assert.equal((await recognize({ page: 2, mime: 'image/png', base64: data }, signal())).warning, 'vision-unsupported');
        assert.deepEqual(await vision.recognize(alias, image, 'image/png', 'en-US', signal()), { warning: 'vision-unsupported' });
      }
      assert.equal(probes, 1);
      assert.equal(uploads, supported ? 2 : 0);
    } finally { await relay.close(); }
  }
});

test('shows per-page OCR in the installed BI plugin in zh-TW and en, then reviews and cites OCR text', { timeout: 150_000 }, async t => {
  if (!(await ocrLanguages(signal())).includes('en-US')) return t.skip('Windows.Media.Ocr en-US recognition language is unavailable');
  const root = dataDirectory();
  const { mixed, png } = fixtures(root);
  const profile = join(root, 'profile');
  const audit = join(root, 'audit');
  mkdirSync(profile);
  mkdirSync(audit);
  let probes = 0;
  let images = 0;
  const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias,
    isolatedJob: true, async fetch(_target, init) {
      if (init?.method === 'GET') return Response.json({ data: [{ id: alias }] });
      const body = JSON.parse(String(init?.body)) as TestWire;
      const content = body.messages[1].content;
      if (Array.isArray(content)) {
        const image = content.find(part => part.type === 'image_url');
        assert.ok(image);
        if (image.image_url.detail === 'low') { probes++; return reply('red green blue yellow'); }
        images++;
        assert.equal(image.image_url.url, 'data:image/png;base64,' + readFileSync(png).toString('base64'));
        return reply(JSON.stringify({ text: visionQuote }));
      }
      const input = JSON.parse(content);
      if (input.segments) {
        const candidates = (input.segments as { id: string; text: string }[]).flatMap(({ id, text }) => {
          if (text.includes(scanQuote)) return [
            { name: 'ALPHA', fields: { content: { value: '13 mm', quote: scanQuote, segment: id } } },
            { name: 'BETA', fields: { content: { value: '99 mm', quote: textLayer, segment: id } } },
          ];
          if (text.includes(visionQuote)) return [{ name: 'MODEL', fields: { content: { value: '23 mm', quote: visionQuote, segment: id } } }];
          return [];
        });
        return reply(JSON.stringify({ candidates }));
      }
      const passage = input.evidence.find(({ text }: { text: string }) => text === scanQuote);
      assert.ok(passage);
      return reply(JSON.stringify({ state: 'answer', citations: [{ passageID: passage.id, quote: scanQuote }] }));
    } }, profile);
  try {
    const adapter = await startAdapter(root, runtime, () => {});
    try {
      const api = await webAPI(adapter.pairURL());
      const browser = await chromium(join(root, 'chromium'));
      const click = (selector: string) => browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      const choose = async (selector: string, path: string) => {
        const { root: { nodeId } } = await browser.command<{ root: { nodeId: number } }>('DOM.getDocument');
        const input = await browser.command<{ nodeId: number }>('DOM.querySelector', { nodeId, selector });
        await browser.command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
      };
      const entry = '[data-plugin-page="oep.bi-knowledge.build"]';
      const open = async () => {
        await click(entry);
        await browser.ready('document.querySelector("#bi-builder-run")?.disabled === false');
      };
      try {
        await browser.command('Page.navigate', { url: adapter.pairURL() });
        await browser.ready('document.querySelector("#open-capabilities")?.disabled === false');
        await browser.ready('document.querySelector("#connection").textContent === "已連線"');
        await click('#open-capabilities');
        await choose('#plugin-file', resolve('dist/plugins/BI-Knowledge.oepplugin'));
        await browser.ready('document.querySelector("#plugin-dialog")?.open');
        await click('#plugin-dialog input');
        await click('#plugin-dialog button:last-child');
        await browser.ready(`!document.querySelector('#plugin-dialog').open && Boolean(document.querySelector(${JSON.stringify(entry)}))`, 25_000);
        await open();
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-ocr-mode").selectedOptions[0].textContent'), /必要時使用模型辨識/);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-ocr-language").textContent'), /繁體中文/);
        assert.equal(await browser.evaluate('document.querySelector("#bi-builder-convert-panel").contains(document.querySelector("#bi-builder-ocr-mode"))'), true);
        await click('#bi-builder-consent');
        await choose('#bi-builder-file', mixed);
        await click('#bi-builder-run');
        await browser.ready('document.querySelector("#bi-builder-submit")?.hidden === false', 60_000);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-pages").innerText'), /第 1 頁 · 文字層.*第 2 頁 · 本機 OCR/s);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").innerText'), /引文與指定段落的原文不符/);
        assert.equal(probes, 0, 'Readable local OCR must not probe or send an image');
        await click('#bi-builder-submit');
        await browser.ready('document.querySelector("#bi-builder-review")?.hidden === false');
        await click('#bi-builder-review');
        await browser.ready('document.querySelector("#chat-files .feature-preview")?.innerText.includes("OCR 辨識引擎：Windows.Media.Ocr")');
        const reviewPath = '/api/knowledge/reviews';
        const { reviews: [review] } = await (await api.get(reviewPath)).json();
        assert.equal((await api.post(reviewPath, { action: 'approve', id: review.id, edit: review.edit })).status, 200);
        assert.equal((await api.post(reviewPath, { action: 'publish', id: review.id })).status, 200);
        const answer = await runtime.knowledge!.ask.ask({ vault: review.vault, question: 'ALPHA setting' }, signal());
        assert.equal(answer.state, 'verified');
        if (answer.state !== 'verified') assert.fail('Expected verified citation');
        assert.equal(answer.citations[0].source, 'mixed.pdf');
        assert.equal(answer.citations[0].locator, 'page:2 [OCR: Windows.Media.Ocr (en-US)]');
        assert.equal(answer.citations[0].quote, scanQuote);

        await selectLocale(browser, 'en', '#menu-locale');
        await open();
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-ocr-mode").textContent'), /Use model recognition when needed/);
        await browser.evaluate(`(() => {
          document.querySelector("#bi-builder-reader").value = "image";
          document.querySelector("#bi-builder-ocr-language").value = "en-US";
          document.querySelector("#bi-builder-ocr-mode").value = "model";
        })()`);
        await click('#bi-builder-save-convert');
        await browser.ready('document.querySelector("#bi-builder-status").textContent === "Stage settings saved"');
        await open();
        assert.deepEqual(await browser.evaluate(`
          ["reader", "ocr-language", "ocr-mode"].map(id => document.querySelector("#bi-builder-" + id).value)`
        ), ['image', 'en-US', 'model']);
        await browser.evaluate(`(() => {
          const mode = document.querySelector("#bi-builder-mode");
          mode.value = "step";
          mode.dispatchEvent(new Event("change"));
        })()`);
        await choose('#bi-builder-file', png);
        await click('#bi-builder-run');
        await browser.ready('document.querySelector("#bi-builder-run-ingest")?.checkVisibility() && !document.querySelector("#bi-builder-run-ingest").disabled', 60_000);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-pages").innerText'), /Page 1 · Model recognition/);
        await open();
        await click('#bi-builder-run-ingest');
        await browser.ready('document.querySelector("#bi-builder-run-testing")?.checkVisibility() && !document.querySelector("#bi-builder-run-testing").disabled', 60_000);
        await click('#bi-builder-run-testing');
        await browser.ready('document.querySelector("#bi-builder-pages")?.innerText.includes("Page 1 · Model recognition") && document.querySelector("#bi-builder-submit")?.hidden === false', 60_000);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").innerText'), /OCR by gpt-5.4-synthetic.*MODEL setting is 23 mm/s);
        assert.equal(probes, 1);
        assert.equal(images, 1);
        const traffic = readFileSync(join(audit, 'knowledge-gateway.jsonl'), 'utf8');
        assert.doesNotMatch(traffic, /data:image|base64|iVBORw|ALPHA setting|MODEL setting/);
      } finally { await browser.close(); }
    } finally { await adapter.close(); }
  } finally { await runtime.stop(); }
});
