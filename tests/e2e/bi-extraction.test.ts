import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkServerIdentity } from 'node:tls';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { DocumentExtraction } from '../../apps/adapter/src/bi/document-extraction.ts';
import type { ExtractionStatus } from '../../apps/adapter/src/bi/document-extraction.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { readApprovedPage } from '../../packages/knowledge/src/bi/link-intake.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { syntheticMcpCertificate } from '../fixtures/mcp/tls.ts';
import { chromium } from './chromium.ts';
import { selectLocale } from './gui-locales.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { dataDirectory } from './test-data.ts';
import { webAPI } from './web-api.ts';

const endpoint = '/api/knowledge/bi-documents';
const reviewPath = '/api/knowledge/reviews';
const finished = (status: ExtractionStatus) => ['awaiting-review', 'needs-attention', 'failed'].includes(status.state);
const pdfQuote = 'ALPHA setting is 13 mm.';

function pdf(contents: string[]) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + contents.length + ' /Kids [' + contents.map((_, i) => (4 + i * 2) + ' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, text] of contents.entries()) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ' +
      (5 + i * 2) + ' 0 R >>', '<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream');
  }
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) result += String(offset).padStart(10, '0') + ' 00000 n \n';
  return Buffer.from(result + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

function stream(text: string) { return 'BT /F1 12 Tf 40 700 Td (' + text + ') Tj ET'; }

test('extracts, verifies, reviews, publishes and cites synthetic documents', { timeout: 150_000 }, async () => {
  const root = dataDirectory();
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const audit = mkdtempSync(join(root, 'audit-'));
  const pdfPath = join(root, 'alpha.pdf');
  writeFileSync(pdfPath, pdf([stream('Synthetic front page.'), stream(pdfQuote + ' ALPHA summary is precise.')]));
  const repository = join(root, 'repository');
  mkdirSync(join(repository, 'schemas', 'synthetic'), { recursive: true });
  writeFileSync(join(repository, 'schemas', 'synthetic', 'spec@1.0.0.json'), JSON.stringify({
    schema_id: 'synthetic/spec', version: '1.0.0', title: 'Synthetic schema',
    types: [{ name: 'Measurement', fields: [{ name: 'setting' }, { name: 'summary' }] }],
  }));
  writeFileSync(join(repository, 'repo.json'), 'Deliberately not read by the schema importer.');
  mkdirSync(join(repository, 'cards'));
  writeFileSync(join(repository, 'cards', 'ignored.json'), 'Deliberately not read by the schema importer.');
  let modelCalls = 0;
  let retried = false;
  let toolResults = 0;
  let vault: string;
  const synthetic: typeof fetch = async (_target, init) => {
    const wire = JSON.parse(String(init?.body)) as WireRequest & { stream: boolean; max_tokens: number };
    const { model, messages, stream } = wire;
    const user = String(messages.find(message => message.role === 'user')?.content);
    if (!stream) {
      const input = JSON.parse(user);
      if (input.segments) {
        modelCalls++;
        assert.equal(wire.max_tokens, 4096);
        const segments = input.segments as { id: string; text: string }[];
        assert.ok(segments.reduce((n, segment) => n + Buffer.byteLength(segment.text), 0) <= 6000);
        assert.match(String(messages[0].content), /No source, no value/);
        const candidates = [];
        for (const { id, text } of segments) {
          if (text.includes(pdfQuote) && !retried) {
            retried = true;
            return new Response(null, { status: 503 });
          }
          const field = (value: string, quote: string, segment = id) => ({ value, quote, segment });
          if (text.includes(pdfQuote)) candidates.push({ name: 'ALPHA', fields: {
            setting: field('13 mm', pdfQuote), summary: field('precise', 'ALPHA summary is precise.'),
          } });
          if (text.includes('BETA')) candidates.push({ name: 'BETA', fields: {
            setting: field('14 mm', 'BETA setting is 14 mm.'), summary: field('altered', 'BETA summary is altered.'),
          } });
          if (text.includes('GAMMA')) candidates.push({ name: 'GAMMA', fields: {
            setting: field('15 mm', 'GAMMA setting is 15 mm.'),
          } });
          if (text.includes('DELTA')) candidates.push({ name: 'DELTA', fields: {
            setting: field('hallucinated', 'DELTA setting is 16 mm.'), summary: field('context', 'DELTA summary is context.', '1.1'),
          } });
          if (text.includes('OMEGA setting')) candidates.push({ name: 'OMEGA', fields: { setting: field('4 dB', 'OMEGA setting is 4 dB.') } });
          if (text.includes('OMEGA summary')) candidates.push({ name: 'OMEGA', fields: { summary: field('stable', 'OMEGA summary is stable.') } });
        }
        return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] });
      }
      const passage = input.evidence.find(({ text }: { text: string }) => text === pdfQuote);
      assert.ok(passage);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        state: 'answer', citations: [{ passageID: passage.id, quote: '13 mm' }],
      }) } }] });
    }
    const result = messages.find(message => message.role === 'tool');
    if (result) {
      assert.match(JSON.stringify(result.content), /alpha\.pdf/);
      assert.match(JSON.stringify(result.content), /page:2/);
      assert.match(JSON.stringify(result.content), /13 mm/);
      toolResults++;
      return completion(model, [{ role: 'assistant', content: 'Verified ALPHA setting 13 mm (alpha.pdf, page:2)' }], 'stop');
    }
    return completion(model, toolCall(0, 'extraction_citation', 'oep_knowledge_ask',
      { vault, question: 'ALPHA setting' }), 'tool_calls');
  };
  const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-bi-docs',
    fetch: synthetic, isolatedJob: true }, profile);
  try {
    const adapter = await startAdapter(root, runtime, () => {});
    try {
      const api = await webAPI(adapter.pairURL());
      assert.equal((await fetch(api.origin + endpoint + '/runs')).status, 401);
      const imported = await api.post(endpoint + '/schemas', { folder: repository });
      assert.equal(imported.status, 200);
      const { choices, count } = await imported.json();
      assert.equal(count, 1);
      const choice = choices.find(({ schema }: { schema: string }) => schema === 'synthetic/spec/Measurement');
      assert.deepEqual(choice.fields, ['setting', 'summary']);
      vault = choice.vault;
      const wait = async () => until(async () => {
        const { runs } = await (await api.get(endpoint + '/runs')).json();
        if (runs[0] && finished(runs[0])) return runs[0] as ExtractionStatus;
      }, 30_000);

      const browser = await chromium(join(root, 'chromium'));
      try {
        await browser.command('Page.navigate', { url: adapter.pairURL() });
        await browser.ready("document.querySelector('#open-knowledge')?.disabled === false");
        for (const [locale, label, success] of [
          ['zh-TW', '從文件建立卡片', '通過驗證的卡片已送審。'],
          ['en', 'Build cards from a document', 'Validated cards are ready for review.'],
        ] as const) {
          if (locale === 'en') await selectLocale(browser, locale, '#menu-locale');
          await browser.evaluate(`(() => {
            document.querySelector('#open-knowledge').click();
            document.querySelector('#knowledge-tab-build').click();
            document.querySelector('#bi-document-panel').open = true;
          })()`);
          await browser.ready("document.querySelector('#bi-document-run').disabled === false");
          assert.equal(await browser.evaluate("document.querySelector('#bi-document-panel > summary').textContent"), label);
          await browser.evaluate(`(() => {
            const original = window.fetch;
            window.testBiDocumentUpload = undefined;
            window.fetch = async function (url, options) {
              const response = await original.call(this, url, options);
              if (String(url).startsWith('/api/knowledge/bi-documents/file/')) {
                window.testBiDocumentUpload = { method: options.method, status: response.status,
                  protected: Boolean(options.headers['X-OEP-CSRF']), bytes: options.body?.byteLength };
              }
              return response;
            };
          })()`);
          const { root: { nodeId: documentId } } = await browser.command<{ root: { nodeId: number } }>('DOM.getDocument');
          const { nodeId } = await browser.command<{ nodeId: number }>('DOM.querySelector', { nodeId: documentId, selector: '#bi-document-file' });
          await browser.command('DOM.setFileInputFiles', { nodeId, files: [pdfPath] });
          await browser.evaluate(`(() => {
            document.querySelector('#bi-document-schema').value = ${JSON.stringify(choice.id)};
            document.querySelector('#bi-document-consent').checked = true;
            document.querySelector('#bi-document-run').click();
          })()`);
          await browser.ready('Boolean(window.testBiDocumentUpload)');
          assert.deepEqual(await browser.evaluate('window.testBiDocumentUpload'), {
            method: 'POST', status: 202, protected: true, bytes: pdf([stream('Synthetic front page.'),
              stream(pdfQuote + ' ALPHA summary is precise.')]).length,
          });
          await browser.ready(`document.querySelector('#bi-document-status').textContent.includes(${JSON.stringify(success)}) &&
            !document.querySelector('#bi-document-review').hidden`, 30_000);
          await browser.evaluate("document.querySelector('#bi-document-review').click()");
          await browser.ready(`!document.querySelector('#review-view').hidden &&
            document.body.innerText.includes(${JSON.stringify(pdfQuote)})`);
        }
      } finally { await browser.close(); }

      const run = await wait();
      assert.equal(run.reused, true);
      assert.equal(run.candidates.length, 1);
      assert.equal(run.candidates[0].evidence.setting.locator, 'page:2');
      assert.equal(run.candidates[0].evidence.setting.quote, pdfQuote);
      assert.equal(run.candidates[0].state, 'awaiting-review');
      assert.equal(modelCalls, 2, 'one successful request and one retry, with no repeated extraction');
      using documents = new DatabaseSync(join(root, 'bi-documents.sqlite'), { readOnly: true });
      assert.equal(documents.prepare('SELECT count(*) AS n FROM documents').get()?.n, 1);
      const { reviews } = await (await api.get(reviewPath)).json();
      assert.equal(reviews.filter(({ id }: { id: string }) => id === run.reviewId).length, 1);
      assert.equal((await api.post(reviewPath, { action: 'approve', id: run.reviewId, edit: 0 })).status, 200);
      const published = await api.post(reviewPath, { action: 'publish', id: run.reviewId });
      assert.equal(published.status, 200);
      const compare = await (await api.post(reviewPath, { action: 'compare', id: run.reviewId })).json();
      assert.ok(compare.candidate.passages.some(({ locator, text }: { locator: string; text: string }) =>
        locator === 'page:2' && text === pdfQuote));

      using db = new DatabaseSync(join(root, 'web.sqlite'));
      db.prepare("INSERT INTO agent_knowledge_reads VALUES ('main',?)").run(vault);
      const created = await api.post('/api/sessions', { agent: 'inspector' });
      assert.equal(created.status, 201);
      const session = await created.json();
      const accepted = await api.post('/api/sessions/' + session.id + '/turns', {
        id: randomUUID(), text: 'Use the knowledge tool to find the ALPHA setting.', attachments: [], workbook: false,
      });
      assert.equal(accepted.status, 202);
      const turn = await until(async () => {
        const value = await (await api.get('/api/sessions/' + session.id + '/state')).json();
        if (['verified', 'failed'].includes(value.runs.at(-1)?.state)) return value;
      }, 35_000);
      assert.equal(turn.runs.at(-1).state, 'verified');
      assert.equal(toolResults, 1);
      assert.ok(turn.messages.some(({ text }: { text: string }) => text.includes('13 mm (alpha.pdf, page:2)')));

      const secondText = [pdfQuote + ' ALPHA summary is precise.', 'BETA setting is 14 mm. BETA summary is genuine.',
        'GAMMA setting is 15 mm.', 'DELTA setting is 16 mm. DELTA summary is context.'].join('\n\n');
      const path = endpoint + '/file/' + choice.id + '/0';
      assert.equal((await api.upload(path, 'validation.md', secondText)).status, 202);
      const validation = await wait();
      assert.equal(validation.state, 'needs-attention');
      assert.equal(validation.reviewId, undefined);
      const byName = new Map(validation.candidates.map(candidate => [candidate.name, candidate]));
      assert.deepEqual(byName.get('ALPHA')?.issues, [{ code: 'duplicate' }]);
      assert.deepEqual(byName.get('BETA')?.issues, [{ code: 'invalid-quote', field: 'summary' }]);
      assert.deepEqual(byName.get('GAMMA')?.issues, [{ code: 'missing-evidence', field: 'summary' }]);
      assert.deepEqual(byName.get('DELTA')?.issues, [
        { code: 'unsupported-value', field: 'setting' }, { code: 'invalid-quote', field: 'summary' },
      ]);
      for (const name of ['BETA', 'GAMMA', 'DELTA']) assert.equal(byName.get(name)?.fields.summary, '');
      assert.equal(byName.get('DELTA')?.fields.setting, '');

      const long = ['OMEGA setting is 4 dB.', 'plain filler '.repeat(800), 'OMEGA summary is stable.'].join('\n\n');
      assert.equal((await api.upload(path, 'long.txt', long)).status, 202);
      const chunked = await wait();
      assert.ok(chunked.totalChunks > 1);
      assert.equal(chunked.completedChunks, chunked.totalChunks);
      assert.equal(chunked.state, 'awaiting-review');
      assert.deepEqual(chunked.candidates[0].fields, { setting: '4 dB', summary: 'stable' });
      assert.equal(chunked.candidates[0].evidence.summary.locator, 'paragraph:3');

      const local = join(root, 'html');
      mkdirSync(local);
      const tls = syntheticMcpCertificate(local);
      const page = '<title>Fixture page</title><nav>ignore this</nav><main><p id="spec">OMEGA setting is 4 dB.</p>' +
        '<p id="detail">OMEGA summary is stable.</p><div hidden>ignore this</div></main>';
      const server = createServer(tls, (_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'https://synthetic-bi.invalid/fixture';
      const origin = new URL(url).origin;
      const localTransport = {
        async pin(host: string, allowLocal: boolean) {
          assert.equal(host, 'synthetic-bi.invalid');
          assert.equal(allowLocal, false);
          return '127.0.0.1';
        },
        request: ((target: URL, options: Parameters<typeof request>[1], callback: Parameters<typeof request>[2]) =>
          request(target, { ...options, ca: tls.cert, port: (server.address() as AddressInfo).port,
            checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate) }, callback)) as typeof request,
      };
      const httpsExtraction = new DocumentExtraction(join(root, 'https-extraction.sqlite'), runtime.knowledge!, () => new Set([origin]),
        (link, origins, signal) => readApprovedPage(link, origins, signal, localTransport));
      try {
        await assert.rejects(readApprovedPage('https://localhost', new Set(['https://localhost']), new AbortController().signal), /受阻/);
        await assert.rejects(readApprovedPage(url, new Set(), new AbortController().signal, localTransport), /未核准/);
        const webChoice = httpsExtraction.choices().find(({ id }) => id === choice.id)!;
        const started = httpsExtraction.start({ url }, webChoice.id, true);
        const fromWeb = await until(async () => {
          const state = httpsExtraction.status(started.id)!;
          return finished(state) ? state : undefined;
        }, 30_000);
        assert.equal(fromWeb.state, 'awaiting-review');
        assert.equal(fromWeb.source.title, 'Fixture page');
        assert.equal(fromWeb.source.url, url);
        assert.ok(Date.parse(fromWeb.source.fetchedAt!));
        assert.equal(fromWeb.candidates[0].evidence.setting.locator, '#spec');
        assert.equal(fromWeb.candidates[0].evidence.summary.locator, '#detail');
        using htmlStore = new DatabaseSync(join(root, 'https-extraction.sqlite'), { readOnly: true });
        assert.doesNotMatch(String(htmlStore.prepare('SELECT projection FROM documents').get()?.projection), /ignore this/);

        const htmlResult = httpsExtraction.start({ ref: 'page.html', bytes: Buffer.from(page) }, webChoice.id, true);
        const localHtml = await until(async () => {
          const state = httpsExtraction.status(htmlResult.id)!;
          return finished(state) ? state : undefined;
        }, 30_000);
        assert.equal(localHtml.state, 'awaiting-review');
        assert.equal(localHtml.candidates[0].evidence.setting.locator, '#spec');

        const scanned = httpsExtraction.start({ ref: 'scan.pdf', bytes: pdf(['q BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID 00> EI Q']) },
          webChoice.id, true);
        const unreadable = await until(async () => {
          const state = httpsExtraction.status(scanned.id)!;
          return finished(state) ? state : undefined;
        }, 30_000);
        assert.equal(unreadable.state, 'failed');
        assert.equal(unreadable.issue, 'ocr');
      } finally {
        await httpsExtraction.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    } finally { await adapter.close(); }
  } finally { await runtime.stop(); }
});
