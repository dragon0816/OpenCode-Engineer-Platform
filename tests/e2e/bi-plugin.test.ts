import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkServerIdentity } from 'node:tls';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { TelegramApi } from '../../apps/adapter/src/telegram/poller.ts';
import { gatewayAliases, gatewaySettings } from '../../apps/adapter/src/opencode/gateway.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { readApprovedPage } from '../../packages/knowledge/src/bi/link-intake.ts';
import { canonical, sha256 } from '../../packages/knowledge/src/snapshot.ts';
import { pdf, stream } from '../fixtures/knowledge/pdf.ts';
import { biPluginRepository, biPluginRepositoryQuote } from '../fixtures/knowledge/repository.ts';
import { syntheticMcpCertificate } from '../fixtures/mcp/tls.ts';
import { chromium } from './chromium.ts';
import { labelInLocale, selectLocale, type Locale } from './gui-locales.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { dataDirectory } from './test-data.ts';
import { webAPI } from './web-api.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import { until } from '../../scripts/phase0/probe-http.ts';

const plugin = 'oep.bi-knowledge';
const entry = '[data-plugin-page="oep.bi-knowledge.build"]';
const archive = resolve('dist/plugins/BI-Knowledge.oepplugin');
const endpoint = '/api/knowledge/reviews';
const url = 'https://synthetic-bi.invalid/calibration';
const pdfFact = 'SYN-ALPHA calibration limit is 13 mm.';
const webFact = 'SYN-BETA calibration limit is 19 mm.';
const sourceFacts = [pdfFact, webFact, biPluginRepositoryQuote];
type Browser = Awaited<ReturnType<typeof chromium>>;
type API = Awaited<ReturnType<typeof webAPI>>;
const click = (browser: Browser, selector: string) => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');

async function fill(browser: Browser, selector: string, value: string) {
  await browser.evaluate('(() => { const field = document.querySelector(' + JSON.stringify(selector) + '); field.value = ' +
    JSON.stringify(value) + '; field.dispatchEvent(new Event("input", { bubbles: true })); })()');
}

async function selectFile(browser: Browser, selector: string, path: string) {
  const { root } = await browser.command<{ root: { nodeId: number } }>('DOM.getDocument');
  const { nodeId } = await browser.command<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector });
  await browser.command('DOM.setFileInputFiles', { nodeId, files: [path] });
}

async function fixturePage(root: string) {
  const folder = join(root, 'https');
  mkdirSync(folder);
  const tls = syntheticMcpCertificate(folder);
  const html = '<title>Synthetic calibration</title><main><p id="limit">' + webFact + '</p></main>';
  const server = createServer(tls, (_req, response) => response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
  }).end(html));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const fetchBiPage: typeof readApprovedPage = (link, origins, signal) => readApprovedPage(link, origins, signal, {
    async pin(host, allowLocal) {
      assert.equal(host, 'synthetic-bi.invalid');
      assert.equal(allowLocal, false);
      return '127.0.0.1';
    },
    request: ((target: URL, options: Parameters<typeof request>[1], callback: Parameters<typeof request>[2]) =>
      request(target, { ...options, ca: tls.cert, port: (server.address() as AddressInfo).port,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate) }, callback)) as typeof request,
  });
  return { fetchBiPage, close() {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

function reply(value: unknown) {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

const syntheticGateway: typeof fetch = async (_target, init) => {
  const wire = JSON.parse(String(init?.body)) as WireRequest;
  const input = JSON.parse(String(wire.messages.find(({ role }) => role === 'user')?.content));
  if (input.segments) {
    // Give Chromium time to observe the active extraction step.
    await delay(1_500);
    const candidates = (input.segments as { id: string; text: string }[]).flatMap(segment => {
      const quote = sourceFacts.find(fact => segment.text.includes(fact));
      if (!quote) return [];
      const value = quote.match(/\d+ mm/)![0];
      return [{ name: quote.split(' ')[0], fields: { [input.fields[0]]: { value, quote, segment: segment.id } } }];
    });
    return reply({ candidates });
  }
  const requested = (input.question as string | undefined)?.match(/SYN-[A-Z]+/)?.[0];
  const passage = (input.evidence as { id: string; text: string }[] | undefined)
    ?.find(({ text }) => requested && text.includes(requested));
  return passage ? reply({ state: 'answer', citations: [{ passageID: passage.id, quote: passage.text }] }) :
    reply({ state: 'abstain' });
};

async function openBuilder(browser: Browser) {
  await click(browser, entry);
  await browser.ready('document.querySelector("#bi-builder-run")?.disabled === false');
}

async function install(browser: Browser, pair: string) {
  await browser.command('Page.navigate', { url: pair });
  await browser.ready('document.querySelector("#open-capabilities")?.disabled === false');
  await click(browser, '#open-capabilities');
  await selectFile(browser, '#plugin-file', archive);
  await browser.ready('document.querySelector("#plugin-dialog").open');
  assert.equal(await browser.evaluate('document.querySelector("#plugin-dialog button:last-child").disabled'), true);
  await click(browser, '#plugin-dialog input');
  await click(browser, '#plugin-dialog button:last-child');
  await browser.ready('!document.querySelector("#plugin-dialog").open && Boolean(document.querySelector(' + JSON.stringify(entry) + '))', 25_000);
}

async function stage(browser: Browser, api: API) {
  await click(browser, '#bi-builder-submit');
  await browser.ready('document.querySelector("#bi-builder-review")?.hidden === false');
  const { reviews } = await (await api.get(endpoint)).json();
  const review = reviews[0];
  assert.equal(review.status, 'pending');
  assert.equal(review.publication, null);
  assert.equal((await api.post(endpoint, { action: 'publish', id: review.id })).status, 422);
  return review as { id: string; vault: string; edit: number };
}

async function reviewAction(browser: Browser, label: string) {
  const expression = '[...document.querySelectorAll("#chat-files .feature-preview button")].find(button => button.textContent === ' +
    JSON.stringify(label) + ' && button.checkVisibility())';
  await browser.ready('Boolean(' + expression + ')');
  await browser.evaluate(expression + '.click()');
}

async function finish(browser: Browser, api: API, locale: Locale, review: { id: string; vault: string }) {
  await click(browser, '#bi-builder-review');
  await reviewAction(browser, labelInLocale('核准', locale));
  await browser.ready('[...document.querySelectorAll("#chat-files .feature-preview button")].some(button => ' +
    'button.textContent === ' + JSON.stringify(labelInLocale('發布', locale)) + ' && button.checkVisibility())');
  const { reviews } = await (await api.get(endpoint)).json();
  const approved = reviews.find(({ id }: { id: string }) => id === review.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.publication, null);
  await reviewAction(browser, labelInLocale('發布', locale));
  await browser.ready('[...document.querySelectorAll("#chat-files .feature-preview")].some(el => el.checkVisibility() && el.innerText.includes(' +
    JSON.stringify(labelInLocale('已發布', locale)) + '))');
  await openBuilder(browser);
  await browser.ready('document.querySelector("#bi-builder-summary")?.textContent.includes(' +
    JSON.stringify(locale === 'en' ? 'published' : '已發布') + ')');
}

async function bind(api: API, vaults: string[]) {
  const { agent } = await (await api.get('/api/agents/main')).json();
  return api.post('/api/agents/main', { action: 'edit', revision: agent.revision, knowledgeReads: vaults });
}

test('installs BI Knowledge and publishes cited PDF, HTTPS and repository evidence through owner review', { timeout: 300_000 }, async () => {
  assert.ok(existsSync(archive), 'Build the BI plugin before this test');
  const root = dataDirectory();
  const profile = join(root, 'profile');
  const audit = join(root, 'audit');
  mkdirSync(profile);
  mkdirSync(audit);
  const fixture = join(root, 'export');
  biPluginRepository(fixture);
  const file = join(root, 'calibration.pdf');
  writeFileSync(file, pdf([stream('Synthetic calibration index.'), stream(pdfFact)]));
  const web = await fixturePage(root);
  try {
    const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-bi-plugin',
      fetch: syntheticGateway, isolatedJob: true }, profile);
    try {
      const start = () => startAdapter(root, runtime, () => {}, false, undefined, undefined, undefined, undefined,
        async () => [fixture], { fetchBiPage: web.fetchBiPage });
      let adapter = await start();
      try {
        let api = await webAPI(adapter.pairURL());
        const browser = await chromium(join(root, 'chromium'));
        let documents: string;
        let imported: string;
        const output = process.env.OEP_BI_SCREENSHOTS;
        async function capture(locale: Locale, step: number) {
          await browser.ready('Boolean(document.querySelector("#bi-builder-steps li:nth-child(' + step + ')[aria-current=step]"))', 60_000);
          if (!output) return;
          mkdirSync(output, { recursive: true });
          const target = step === 1 ? '#bi-builder-steps' : step === 6 ? '#bi-builder-summary' : '#bi-builder-progress-title';
          await browser.evaluate('document.querySelector(' + JSON.stringify(target) + ').scrollIntoView({block:"start"})');
          const { data } = await browser.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(output, locale + '-' + step + '.png'), Buffer.from(data, 'base64'));
        }
        try {
          await install(browser, adapter.pairURL());
          assert.equal(await browser.evaluate('document.querySelector("#bi-document-panel").hidden'), true);

          for (const locale of ['zh-TW', 'en'] as const) {
            if (locale === 'en') {
              await selectLocale(browser, 'en', '#menu-locale');
              await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 1180, deviceScaleFactor: 1, mobile: false });
            }
            await openBuilder(browser);
            const title = locale === 'en' ? 'BI Knowledge' : 'BI 知識庫';
            assert.equal(await browser.evaluate('document.querySelector("#plugin-page-title").textContent'), title);
            assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
            assert.equal(await browser.evaluate('document.querySelectorAll("#bi-builder-steps li").length'), 6);
            if (locale === 'zh-TW') {
              await fill(browser, '#bi-builder-title', 'Synthetic document calibration');
              await selectFile(browser, '#bi-builder-file', file);
              await click(browser, '#bi-builder-pick');
              await browser.ready('document.querySelector("#bi-builder-folder").value.length > 0');
              await click(browser, '#bi-builder-schemas');
              await browser.ready('Array.from(document.querySelector("#bi-builder-schema").options).some(option => option.label.includes("synthetic/measurement"))');
              await browser.evaluate('(() => { const schema = document.querySelector("#bi-builder-schema"); schema.value = ' +
                '[...schema.options].find(option => option.label.includes("synthetic/measurement")).value; schema.dispatchEvent(new Event("change")); })()');
              await click(browser, '#bi-builder-consent');
            } else {
              await fill(browser, '#bi-builder-url', url);
            }
            await capture(locale, 1);
            await click(browser, '#bi-builder-run');
            await capture(locale, 2);
            await capture(locale, 3);
            await browser.ready('document.querySelector("#bi-builder-submit")?.hidden === false', 60_000);
            assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").textContent'),
              locale === 'zh-TW' ? /page:2.*13 mm/s : /#limit.*19 mm/s);
            await capture(locale, 4);
            const review = await stage(browser, api);
            if (locale === 'zh-TW') {
              documents = review.vault;
              assert.equal((await bind(api, [documents])).status, 400);
            } else assert.equal(review.vault, documents!);
            await capture(locale, 5);
            await finish(browser, api, locale, review);
            await capture(locale, 6);
          }

          await fill(browser, '#bi-builder-title', 'Synthetic repository calibration');
          await click(browser, '#bi-builder-repository');
          await browser.ready('document.querySelector("#bi-builder-submit")?.hidden === false');
          assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").textContent'),
            /Upstream tag tag-a.*2 cards.*1 evidence passage.*1 relationship.*1 cards have no citable passage/s);
          const review = await stage(browser, api);
          imported = review.vault;
          assert.equal((await bind(api, [documents!, imported])).status, 400);
          await finish(browser, api, 'en', review);
          assert.equal((await bind(api, [documents!, imported])).status, 200);
          {
            using db = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
            const bound = db.prepare("SELECT vault_id FROM agent_knowledge_reads WHERE agent_id='main' ORDER BY vault_id").all();
            assert.deepEqual(bound.map(row => row.vault_id), [documents!, imported].sort());
          }
        } finally { await browser.close(); }

        const created = await api.post('/api/sessions', { agent: 'inspector' });
        assert.equal(created.status, 201);
        const session = await created.json();
        const askAll = async () => {
          const observations = [];
          for (const [vault, subject, source, locator, quote] of [
            [documents!, 'SYN-ALPHA', 'calibration.pdf', 'page:2', pdfFact],
            [documents!, 'SYN-BETA', url, '#limit', webFact],
            [imported!, 'SYN-GAMMA', 'calibration-note.txt', '#L2-L4', biPluginRepositoryQuote],
          ]) {
            const response = await api.post('/api/sessions/' + session.id + '/knowledge-ask',
              { vault, question: 'What is the ' + subject + ' calibration limit?' });
            assert.equal(response.status, 200);
            const answer = await response.json();
            assert.equal(answer.state, 'verified');
            assert.equal(answer.answer, quote);
            assert.equal(answer.citations[0].source, source);
            assert.equal(answer.citations[0].locator, locator);
            assert.equal(answer.citations[0].quote, quote);
            observations.push(answer);
          }
          return observations;
        };
        const before = await askAll();
        assert.equal((await api.post('/api/plugins/' + plugin + '/uninstall', {})).status, 200);
        assert.deepEqual(await (await api.get('/api/plugins')).json(), []);
        assert.deepEqual(await askAll(), before);
        await adapter.close();
        adapter = await start();
        api = await webAPI(adapter.pairURL());
        assert.deepEqual(await (await api.get('/api/plugins')).json(), []);
        assert.deepEqual(await askAll(), before);
      } finally { await adapter.close(); }
    } finally { await runtime.stop(); }
  } finally { await web.close(); }
});

const ownerExport = process.env.OEP_MARKET_INTEL_DIR;
test('runs BI stage checkpoints and benchmark thresholds, edits a working export, and queries published cards', { timeout: 300_000 }, async () => {
  const root = dataDirectory();
  const profile = join(root, 'profile');
  const audit = join(root, 'audit');
  mkdirSync(profile);
  mkdirSync(audit);
  const fixture = join(root, 'working-export');
  cpSync(resolve('tests/fixtures/knowledge/bi-working-export'), fixture, { recursive: true });
  // Match the size class of the example export without reusing any of its data.
  for (let seq = 2; seq <= 5; seq++) {
    const commit = { format: 'aep.knowledge.commit/v1', repo: 'synthetic-working', author: 'fixture', seq, clock: seq,
      kind: 'change', purpose: 'Synthetic import size check', base: null, created: '2026-01-01T00:00:00Z', files: [],
      ops: [{ unit: 'meta:fixture:' + seq, value: 'x'.repeat(3 * 1024 * 1024), base: null }] };
    writeFileSync(join(fixture, 'commits', 'fixture', seq + '.json'), JSON.stringify({ ...commit, id: sha256(canonical(commit)) }));
  }
  const file = join(root, 'synthetic-reading.txt');
  const fact = 'SYN-GAMMA calibration limit is 23 mm.';
  writeFileSync(file, 'Name: SYN-GAMMA\nReading: ' + fact);
  let boundVault = '';
  let toolSteps = 0;
  const gateway: typeof fetch = async (_target, init) => {
    const { model, messages, tools, stream } = JSON.parse(String(init?.body)) as WireRequest & { stream: boolean };
    if (!stream) {
      const input = JSON.parse(String(messages.find(({ role }) => role === 'user')?.content));
      assert.equal(input.segments, undefined, 'Ingest uses the saved deterministic rule method');
      const passage = (input.evidence as { id: string; text: string }[]).find(({ text }) => text.includes('SYN-GAMMA baseline is 21 mm.') || text.includes(fact));
      return passage ? reply({ state: 'answer', citations: [{ passageID: passage.id, quote: passage.text }] }) : reply({ state: 'abstain' });
    }
    assert.match(JSON.stringify(messages), /BI knowledge-query procedure/);
    assert.ok(tools?.some(tool => tool.function?.name === 'oep_bi_query'));
    const results = messages.filter(({ role }) => role === 'tool').map(({ content }) => JSON.stringify(content));
    toolSteps = Math.max(toolSteps, results.length);
    if (!results.length) return completion(model, toolCall(0, 'bi-filter', 'oep_bi_query',
      { vault: boundVault, type: 'Measurement', text: 'SYN-GAMMA' }), 'tool_calls');
    assert.match(results[0], /SYN-GAMMA Edited Draft/);
    assert.doesNotMatch(results[0], /SYN-DELTA/);
    if (results.length === 1) return completion(model, toolCall(0, 'bi-link', 'oep_bi_query',
      { vault: boundVault, from: 'gamma', relation: 'related' }), 'tool_calls');
    assert.match(results[1], /SYN-DELTA/);
    if (results.length === 2) return completion(model, toolCall(0, 'bi-evidence', 'oep_knowledge_ask',
      { vault: boundVault, question: 'What is the SYN-GAMMA baseline?' }), 'tool_calls');
    assert.match(results[2], /SYN-GAMMA baseline is 21 mm/);
    assert.match(results[2], /synthetic-draft\.md.*#L2-L2/s);
    return completion(model, [{ role: 'assistant', content: 'SYN-GAMMA baseline is 21 mm (synthetic-draft.md, #L2-L2).' }], 'stop');
  };
  const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-stage-model',
    fetch: gateway, isolatedJob: true }, profile);
  try {
    const adapter = await startAdapter(root, runtime, () => {}, false, undefined, undefined, undefined, undefined, async () => [fixture]);
    try {
      const api = await webAPI(adapter.pairURL());
      const browser = await chromium(join(root, 'stage-chromium'));
      const ready = (id: string) => browser.ready(`document.querySelector('#bi-builder-${id}')?.disabled === false`);
      const visible = (id: string, timeout?: number) => browser.ready(`document.querySelector('#bi-builder-${id}')?.checkVisibility()`, timeout);
      const change = (id: string, value: string) => browser.evaluate(`(() => { const node = document.querySelector('#bi-builder-${id}');
        node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const save = async (stage: string) => {
        await click(browser, '#bi-builder-save-' + stage);
        await ready('save-' + stage);
      };
      try {
        await install(browser, adapter.pairURL());
        await openBuilder(browser);
        await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 850, deviceScaleFactor: 1, mobile: false });
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        await fill(browser, '#bi-builder-title', 'Synthetic empty workspace');
        await click(browser, '#bi-builder-consent');
        await click(browser, '#bi-builder-create-workspace');
        await visible('workspace-cards');
        await ready('run');
        await change('reader', 'text');
        await save('convert');
        await change('method', 'rules');
        await fill(browser, '#bi-builder-field-rules', 'content = Reading');
        await save('ingest');
        await fill(browser, '#bi-builder-benchmark-name', 'Synthetic checks');
        await fill(browser, '#bi-builder-questions', 'What is the SYN-GAMMA calibration limit? = 23 mm\nWhat is the SYN-GAMMA setting? = 24 mm');
        await fill(browser, '#bi-builder-threshold', '50');
        await save('testing');
        await openBuilder(browser);
        for (const [selector, expected] of [['reader', 'text'], ['method', 'rules'], ['threshold', '50']]) {
          assert.equal(await browser.evaluate(`document.querySelector('#bi-builder-${selector}').value`), expected);
        }
        await change('mode', 'step');
        await selectFile(browser, '#bi-builder-file', file);
        assert.equal(await browser.evaluate('document.querySelector("#bi-builder-run").focus(); document.activeElement.id'), 'bi-builder-run');
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await visible('run-ingest', 60_000);
        await ready('run-ingest');
        assert.equal((await (await api.get(endpoint)).json()).reviews.length, 0);
        await click(browser, '#bi-builder-details');
        await browser.ready('[...document.querySelectorAll("#chat-files summary")].some(element => element.textContent === "paragraph:1")');
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await browser.ready('document.querySelector("#chat-files").hidden');
        await openBuilder(browser);
        await visible('run-ingest');
        await click(browser, '#bi-builder-run-ingest');
        await visible('run-testing', 60_000);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").textContent'), /23 mm/);
        assert.equal((await (await api.get(endpoint)).json()).reviews.length, 0);
        await click(browser, '#bi-builder-run-testing');
        await visible('submit', 60_000);
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-report").textContent'), /1\/2.*50%/);

        await change('mode', 'automatic');
        await fill(browser, '#bi-builder-benchmark-name', 'Synthetic strict');
        await fill(browser, '#bi-builder-threshold', '100');
        await save('testing');
        await selectFile(browser, '#bi-builder-file', file);
        await click(browser, '#bi-builder-run');
        await browser.ready('document.querySelector("#bi-builder-report").textContent.includes("100%")', 60_000);
        assert.equal(await browser.evaluate('document.querySelector("#bi-builder-submit").hidden'), true);
        await change('saved-questions', 'Synthetic checks');
        await ready('save-testing');
        assert.equal(await browser.evaluate('document.querySelector("#bi-builder-threshold").value'), '50');

        await selectLocale(browser, 'en', '#menu-locale');
        await openBuilder(browser);
        await fill(browser, '#bi-builder-title', '');
        await fill(browser, '#bi-builder-folder', fixture);
        await click(browser, '#bi-builder-import-workspace');
        await browser.ready('document.querySelector("#bi-builder-title").value === "Synthetic calibration vault"', 60_000);
        await ready('workspace-cards');
        await click(browser, '#bi-builder-workspace-cards');
        await browser.ready('document.querySelector("#bi-builder-workspace-card")?.options.length === 3');
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-workspace-card").textContent'), /SYN-GAMMA Working Draft/);
        await change('workspace-card', 'gamma');
        await visible('card-fields');
        assert.match(await browser.evaluate<string>('document.querySelector("#bi-builder-card-fields").value'), /Awaiting confirmation/);
        await fill(browser, '#bi-builder-card-title', 'SYN-GAMMA Edited Draft');
        await click(browser, '#bi-builder-save-card');
        await browser.ready('document.querySelector("#bi-builder-workspace-card").textContent.includes("Edited Draft")');
        await openBuilder(browser);
        await click(browser, '#bi-builder-prepare-workspace');
        await visible('submit');
        const review = await stage(browser, api);
        boundVault = review.vault;
        assert.equal((await bind(api, [boundVault])).status, 400);
        await finish(browser, api, 'en', review);
      } finally { await browser.close(); }

      assert.equal((await bind(api, [boundVault])).status, 200);
      assert.equal((await api.post('/api/plugins/' + plugin + '/uninstall', {})).status, 200);
      const { id: session } = await (await api.post('/api/sessions', { agent: 'inspector' })).json();
      const id = randomUUID();
      assert.equal((await api.post('/api/sessions/' + session + '/turns', { id, text: 'What is the synthetic calibration baseline?',
        attachments: [], workbook: false })).status, 202);
      await until(async () => {
        const response = await (await api.get('/api/sessions/' + session + '/state')).json();
        return response.messages?.some(({ text }: { text: string }) => text.includes('synthetic-draft.md, #L2-L2')) || undefined;
      }, 45_000);
      assert.equal(toolSteps, 3);
    } finally { await adapter.close(); }
  } finally { await runtime.stop(); }
});

test('schedules BI Telegram intake through the installed Convert and Ingest workers', { timeout: 180_000 }, async () => {
  const root = dataDirectory();
  const profile = join(root, 'profile');
  const audit = join(root, 'audit');
  mkdirSync(profile);
  mkdirSync(audit);
  const file = pdf([stream('Synthetic calibration index.'), stream(pdfFact)]);
  const chat = { type: 'private', id: 42 };
  const from = { id: 42 };
  const updates = [
    { update_id: 707, message: { chat, from, text: url } },
    { update_id: 708, message: { chat, from, document: { file_id: 'fixture-pdf', file_size: file.length, file_name: 'scheduled.pdf' } } },
  ];
  let collecting = false;
  let now = Date.UTC(2026, 0, 6, 0, 58);
  let reads = 0;
  const replies: string[] = [];
  class SyntheticBot extends TelegramApi {
    override async call<T>(method: string, body: { offset?: number; text?: string }, signal: AbortSignal): Promise<T> {
      signal.throwIfAborted();
      if (method === 'getMe') return { id: 72, is_bot: true, username: 'synthetic_bi' } as T;
      if (method === 'getUpdates') return (collecting ? updates.filter(({ update_id }) => update_id >= (body.offset ?? 0)) : []) as T;
      assert.equal(method, 'sendMessage');
      replies.push(body.text!);
      return { message_id: replies.length } as T;
    }
    override async file(id: string, limit: number, signal: AbortSignal) {
      signal.throwIfAborted();
      assert.equal(id, 'fixture-pdf');
      assert.ok(limit >= file.length);
      reads++;
      return file;
    }
  }
  const web = await fixturePage(root);
  try {
    const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-bi-inbox',
      fetch: syntheticGateway, isolatedJob: true }, profile);
    try {
      const adapter = await startAdapter(root, runtime, () => {}, true, undefined, {
        readCredentials: names => Object.fromEntries(names.flatMap(name => name === 'OEP_TELEGRAM_ALLOWED_USER_ID' ? [[name, '42']] :
          name === 'OEP_TELEGRAM_BI_BOT_TOKEN' ? [[name, '72:fixture-bi']] : [])),
        createApi: value => new SyntheticBot(value),
      }, undefined, undefined, undefined, { fetchBiPage: web.fetchBiPage, biScheduleClock: () => now });
      try {
        const api = await webAPI(adapter.pairURL());
        const browser = await chromium(join(root, 'scheduled-chromium'));
        try {
          await install(browser, adapter.pairURL());
          await selectLocale(browser, 'en', '#menu-locale');
          await openBuilder(browser);
          assert.equal((await api.post('/api/jobs', { action: 'configure', domain: 'synthetic', origins: ['https://synthetic-bi.invalid'] })).status, 200);
          await fill(browser, '#bi-builder-title', 'Synthetic inbox vault');
          await click(browser, '#bi-builder-create-workspace');
          await browser.ready('document.querySelector("#bi-builder-inbox-save").disabled === false');
          await click(browser, '#bi-builder-inbox summary');
          await fill(browser, '#bi-builder-inbox-time', '09:00');
          await fill(browser, '#bi-builder-inbox-zone', 'Asia/Taipei');
          await click(browser, '#bi-builder-inbox-save');
          await browser.ready('document.querySelector("#bi-builder-inbox-status").textContent.includes("09:00 (Asia/Taipei)")');
          collecting = true;
          await until(async () => {
            const status = await (await api.get('/api/jobs')).json();
            return status.sources.length === 2 && status.sources.every(({ state }: { state: string }) => state === 'scheduled') || undefined;
          }, 25_000);
          assert.equal(reads, 1);
          assert.equal((await (await api.get(endpoint)).json()).reviews.length, 0);
          now = Date.UTC(2026, 0, 6, 1);
          const scheduled = await until(async () => {
            const status = await (await api.get('/api/jobs')).json();
            return status.occurrences.find((row: { schedule: string; state: string }) =>
              row.schedule === 'bi-inbox-pipeline' && row.state === 'awaiting_review');
          }, 60_000);
          assert.equal(scheduled.wall, '2026-01-06T09:00');
          const { reviews } = await (await api.get(endpoint)).json();
          assert.equal(reviews.length, 2);
          assert.ok(reviews.every((row: { vault: string; status: string; publication: unknown }) =>
            row.vault === reviews[0].vault && row.status === 'pending' && row.publication === null));
          const evidence = [];
          for (const { id } of reviews) {
            const compared = await (await api.post(endpoint, { action: 'compare', id })).json();
            evidence.push(...compared.candidate.passages.map(({ locator, text }: { locator: string; text: string }) => [locator, text]));
          }
          assert.deepEqual(evidence.sort(), [['#limit', webFact], ['page:2', pdfFact]].sort());
          await click(browser, '#open-review');
          await browser.ready('document.querySelector("#review-view")?.checkVisibility()');
          assert.equal((await (await api.get('/api/jobs')).json()).occurrences.length, 1);
          assert.ok(replies.length >= 2);
        } finally { await browser.close(); }
      } finally { await adapter.close(); }
    } finally { await runtime.stop(); }
  } finally { await web.close(); }
});

test('optionally verifies a local owner repository export', {
  skip: !ownerExport || !existsSync(ownerExport) ? 'OEP_MARKET_INTEL_DIR is unavailable' : false,
  timeout: 300_000,
}, async () => {
  const root = dataDirectory();
  let phase = 'startup';
  try {
    const profile = join(root, 'profile');
    const audit = join(root, 'audit');
    mkdirSync(profile);
    mkdirSync(audit);
    const live = process.env.OEP_LIVE_GATEWAY === '1';
    const config = live ? { ...gatewaySettings(), alias: gatewayAliases[0], aliases: gatewayAliases } : {
      url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-bi-plugin',
      fetch: (async (_target, init) => {
        const wire = JSON.parse(String(init?.body)) as WireRequest;
        const input = JSON.parse(String(wire.messages.find(({ role }) => role === 'user')?.content));
        const passage = input.evidence?.[0];
        return passage ? reply({ state: 'answer', citations: [{ passageID: passage.id, quote: passage.text }] }) :
          reply({ state: 'abstain' });
      }) satisfies typeof fetch,
    };
    const runtime = await startRuntime(audit, { ...config, isolatedJob: true }, profile);
    try {
      const adapter = await startAdapter(root, runtime, () => {}, false, undefined, undefined, undefined, undefined,
        async () => [ownerExport!]);
      try {
        const api = await webAPI(adapter.pairURL());
        const browser = await chromium(join(root, 'chromium'));
        let vault: string;
        try {
          phase = 'install';
          await install(browser, adapter.pairURL());
          await openBuilder(browser);
          phase = 'validate';
          await click(browser, '#bi-builder-pick');
          await browser.ready('document.querySelector("#bi-builder-folder").value.length > 0');
          await click(browser, '#bi-builder-consent');
          await click(browser, '#bi-builder-repository');
          await browser.ready('document.querySelector("#bi-builder-submit")?.hidden === false', 60_000);
          phase = 'owner-review';
          const review = await stage(browser, api);
          vault = review.vault;
          assert.equal((await api.post(endpoint, { action: 'approve', id: review.id, edit: review.edit })).status, 200);
          assert.equal((await api.post(endpoint, { action: 'publish', id: review.id })).status, 200);
        } finally { await browser.close(); }
        phase = 'bind';
        assert.equal((await bind(api, [vault!])).status, 200);
        const sessionResponse = await api.post('/api/sessions', { agent: 'inspector' });
        assert.equal(sessionResponse.status, 201);
        const { id } = await sessionResponse.json();
        const snapshot = runtime.knowledge?.reviewStore.snapshot(vault!)!;
        const byId = new Map(snapshot.cards.map(card => [card.id, card]));
        const evidence = snapshot.passages.find(passage => passage.cardId && byId.has(passage.cardId));
        assert.ok(Boolean(evidence), 'No citable evidence in owner export');
        const subject = byId.get(evidence!.cardId!)!.title;
        const question = 'What does the source document about ' + subject.slice(0, 120) + '?';
        const ask = async () => {
          const response = await api.post('/api/sessions/' + id + '/knowledge-ask', { vault, question });
          const answer = await response.json();
          return response.status === 200 && answer.state === 'verified' && answer.citations.length > 0;
        };
        phase = 'ask';
        assert.ok(await ask());
        phase = 'uninstall';
        assert.equal((await api.post('/api/plugins/' + plugin + '/uninstall', {})).status, 200);
        phase = 'ask-after-uninstall';
        assert.ok(await ask());
      } finally { await adapter.close(); }
    } finally { await runtime.stop(); }
  } catch {
    throw new Error('Owner repository test failed at ' + phase);
  } finally {
    if (dirname(root) === resolve(process.env.OEP_DATA_DIR!) && root !== resolve(process.env.OEP_DATA_DIR!)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 4 });
    }
  }
});
