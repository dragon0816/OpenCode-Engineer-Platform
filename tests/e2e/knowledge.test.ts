import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { TelegramRouter } from '../../apps/adapter/src/telegram/router.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import type { Candidate } from '../../packages/knowledge/src/ingest.ts';
import { canonical } from '../../packages/knowledge/src/snapshot.ts';
import { largeKnowledgeFixture } from '../fixtures/knowledge/large.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { syntheticRepository } from '../fixtures/knowledge/repository.ts';
import { chromium } from './chromium.ts';
import { assertUiTextInThemes } from './forbidden-shell-text.ts';
import { assertContrastInThemes } from './gui-contrast.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { webAPI } from './web-api.ts';

test('uses the same validated knowledge service from Chromium and OpenCode chat MCP', { timeout: 120_000 }, async (context) => {
  const root = dataDirectory();
  const audit = mkdtempSync(join(root, 'launch-'));
  const profile = join(root, 'profile');
  mkdirSync(profile);
  const { snapshot } = goldFixture();
  const repository = join(root, 'repository');
  const fixture = syntheticRepository(repository, { snapshot });
  const citationId = fixture.evidenceIds.get('calibration')!;
  const vault = snapshot.vault.id;
  const question = 'SYN-48B 零點校正容差是多少？';
  const toolName = 'oep_knowledge_ask';
  let knowledgeCalls = 0;
  let rejectedCalls = 0;
  let toolResults = 0;
  let benchmarkStarted = false;
  const synthetic: typeof fetch = async (_target, init) => {
    const { model, messages, tools, stream } = JSON.parse(String(init?.body)) as WireRequest & { stream: boolean };
    if (!stream) {
      const user = JSON.parse(String(messages.find((message) => message.role === 'user')?.content));
      if (user.fields) {
        assert.deepEqual(user.fields, ['setting']);
        assert.match(user.source, /7\.2 mm/);
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          title: '校正筆記', fields: { setting: { value: '7.2 mm', quote: '7.2 mm' } },
        }) } }] });
      }
      if (user.question === 'SYN-NEW calibration') {
        const passage = user.evidence.find(({ text }: { text: string }) => text.includes('SYN-NEW'));
        assert.ok(passage);
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          state: 'answer', citations: [{ passageID: passage.id, quote: '7.2 mm' }],
        }) } }] });
      }
      if (user.question.startsWith('Benchmark')) {
        if (user.question.includes('cancel')) {
          benchmarkStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          state: 'answer', citations: [{ passageID: citationId, quote: '±0.8 dB' }],
        }) } }] });
      }
      assert.deepEqual(user.evidence.map(({ id }: { id: string }) => id), [citationId]);
      if (user.question === 'SYN-48B synthetic rejected question') {
        rejectedCalls++;
        return new Response('Synthetic private gateway body', { status: 400 });
      }
      const quote = user.question === question ? '±0.8 dB' : '±4 kHz';
      knowledgeCalls++;
      return Response.json({ choices: [{ message: { content:
        JSON.stringify({ state: 'answer', citations: [{ passageID: citationId, quote }] }) }, finish_reason: 'stop' }] });
    }
    const sample = JSON.stringify(messages.find((message) => message.role === 'user')?.content).match(/Synthetic Telegram topic ([12])/);
    if (sample) return completion(model, [{ role: 'assistant', content: 'Synthetic answer topic ' + sample[1] }], 'stop');
    const output = messages.find((message) => message.role === 'tool');
    if (output) {
      const result = JSON.stringify(output.content);
      const rejected = JSON.stringify(messages.find((message) => message.role === 'user')?.content).includes('wrong limit');
      if (rejected) {
        assert.match(result, /invalid-citation/);
        assert.doesNotMatch(result, /±4 kHz/);
      } else {
        assert.match(result, /verified/);
        assert.ok(result.includes(citationId));
        assert.match(result, /±0.8 dB/);
      }
      toolResults++;
      return completion(model, [{ role: 'assistant', content: rejected ? '合成驗收拒答' : '合成驗收結果 ±0.8 dB' }], 'stop');
    }
    if (!tools?.some((tool) => tool.function?.name === toolName)) {
      return completion(model, [{ role: 'assistant', content: 'Knowledge tool unavailable' }], 'stop');
    }
    const user = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
    return completion(model, toolCall(0, 'call_oep_knowledge', toolName,
      { vault, question: user.includes('wrong limit') ? 'Does SYN-48B have the wrong limit?' : question }), 'tool_calls');
  };
  const runtime = await startRuntime(audit, { url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-knowledge',
    fetch: synthetic, isolatedJob: true }, profile);
  try {
    const reader = Reflect.get(runtime.knowledge!.ask, 'store');
    assert.throws(() => reader.installReviewSchema('blocked-write', 'local', '1', []), /readonly/i);
    const web = await startAdapter(root, runtime, () => undefined);
    try {
      const api = await webAPI(web.pairURL());
      const anonymous = await fetch(api.origin + '/api/knowledge/vaults');
      assert.equal(anonymous.status, 401);
      assert.equal((await fetch(api.origin + '/api/jobs')).status, 401);
      assert.equal((await fetch(api.origin + '/api/knowledge/import', {
        method: 'POST', headers: { origin: api.origin },
      })).status, 401);
      const reviewsPath = '/api/knowledge/reviews';
      assert.equal((await fetch(api.origin + reviewsPath)).status, 401);
      assert.equal((await fetch(api.origin + reviewsPath, { method: 'POST', headers: { origin: api.origin } })).status, 401);
      assert.equal((await api.post('/api/knowledge/inspect', { folder: 'relative-path' })).status, 400);
      assert.equal((await api.post('/api/knowledge/import', { folder: root })).status, 422);
      const inspection = await api.post('/api/knowledge/inspect', { folder: repository });
      assert.equal(inspection.status, 200);
      const structure = await inspection.text();
      assert.match(structure, /resolved-tag/);
      assert.doesNotMatch(structure, /tag-a|±0\.8 dB|合成量測手冊/);
      assert.equal((await api.post('/api/knowledge/ask', { vault, question, revision: 'draft' })).status, 400);
      assert.equal(runtime.gatewayCursor(), 0);
      const browser = await chromium(join(root, 'chromium'));
      const ready = async (expression: string) => {
        try { await browser.ready(expression); }
        catch { assert.fail(expression + '\n' + await browser.evaluate('document.querySelector("#knowledge-view").innerText')); }
      };
      const key = async (name: string, code: number) => {
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
      };
      const mouse = async (selector: string) => {
        const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
          const control = document.querySelector(${JSON.stringify(selector)});
          control.scrollIntoView({ block: 'center' });
          const rect = control.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await browser.command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        }
      };
      const selectors = (scope: string, expected: string[]) => browser.evaluate<string[]>(`(() => {
        const root = document.querySelector(${JSON.stringify(scope)});
        return ${JSON.stringify(expected)}.filter(selector => !root?.querySelector(selector));
      })()`).then((missing) => assert.deepEqual(missing, [], scope));
      const labels = (scope: string, expected: string[]) => browser.evaluate<string[]>(`(() => {
        const root = document.querySelector(${JSON.stringify(scope)});
        const actions = [...root.querySelectorAll('button, summary, a')].map((item) => item.textContent.trim());
        return ${JSON.stringify(expected)}.filter(label => !actions.includes(label));
      })()`).then((missing) => assert.deepEqual(missing, [], scope));
      const preview = '#file-preview .feature-preview:not([hidden])';
      const previewBody = preview + ' .preview-body';
      const panelIsOpen = "!document.querySelector('#chat-files').hidden";
      const closePreview = () => browser.evaluate("document.querySelector('#close-files').click()");
      const featureText = async (scope: string) => {
        await assertUiTextInThemes(browser, scope);
        await assertContrastInThemes(browser, [{ selector: scope }]);
      };
      const clickLabel = (scope: string, label: string) => browser.evaluate(
        `[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button, summary')]
          .find(element => element.textContent.trim() === ${JSON.stringify(label)}).click()`);
      const captureGallery = async (screens: [string, () => Promise<unknown>][]) => {
        try {
          for (const theme of ['light', 'dark']) {
            for (const [size, width] of [['wide', 1360], ['narrow', 420]] as const) {
              await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
              await ready(`innerWidth === ${width}`);
              await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
              for (const [name, show] of screens) {
                if (await browser.evaluate<boolean>(panelIsOpen)) await closePreview();
                await show();
                await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => {
                  window.scrollTo(0, 0);
                  document.querySelector('#chat-files').scrollTop = 0;
                  requestAnimationFrame(() => resolve(true));
                }))`);
                const image = await browser.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join('docs', 'validation', 'gui', `${name}-${theme}-${size}.png`), Buffer.from(image.data, 'base64'));
              }
            }
          }
        } finally {
          await browser.command('Emulation.clearDeviceMetricsOverride');
          await browser.evaluate('delete document.documentElement.dataset.theme');
        }
      };
      try {
        await browser.command('Page.navigate', { url: web.pairURL() });
        await ready("!document.querySelector('#open-knowledge')?.disabled");
        await browser.evaluate("document.querySelector('#open-jobs').click()");
        await ready("document.querySelector('#jobs-content').textContent.includes('Telegram 收件')");
        assert.equal(await browser.evaluate("document.querySelector('#jobs-view').hidden"), false);
        await featureText('#jobs-view');
        await labels('#jobs-content', ['新增排程', '執行紀錄', '重新整理', '更多', 'Telegram 收件', '通知紀錄']);
        await clickLabel('#jobs-content', '更多');
        await clickLabel('#jobs-content', 'Telegram 收件');
        await selectors(preview, ['select[aria-label="收件狀態篩選"]', 'details textarea', 'details input:first-of-type']);
        await labels(preview, ['儲存收件設定']);
        await featureText(preview);
        await closePreview();
        await browser.evaluate("document.querySelector('#jobs-content .feature-more button').focus()");
        await key('Escape', 27);
        assert.equal(await browser.evaluate("!document.querySelector('#jobs-content .feature-more').open && document.activeElement.matches('#jobs-content summary')"), true);
        await browser.evaluate("document.querySelector('#open-knowledge').click()");
        assert.equal(await browser.evaluate("document.querySelector('#jobs-view').hidden"), true);
        await ready("document.querySelector('#knowledge-status').textContent.includes('沒有已發布')");
        await assertUiTextInThemes(browser);
        await browser.evaluate("document.querySelector('#open-review').focus()");
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await ready(`document.querySelector('#open-review').getAttribute('aria-current') === 'page' &&
          !document.querySelector('#review-view').hidden && document.querySelector('#knowledge-view').hidden &&
          document.activeElement === document.querySelector('#review-title')`);
        await assertUiTextInThemes(browser);
        await featureText('#review-view');
        await labels('#review-view', ['重新整理清單', '審核紀錄']);
        await browser.evaluate("document.querySelector('#open-knowledge').click()");
        for (const tab of ['overview', 'ask', 'quality', 'build']) {
          await mouse('#knowledge-tab-' + tab);
          await ready(`document.querySelector('#knowledge-tab-${tab}').getAttribute('aria-selected') === 'true' &&
            document.querySelectorAll('#knowledge-view [role=tabpanel]:not([hidden])').length === 1 &&
            !document.getElementById(document.querySelector('#knowledge-tab-${tab}').getAttribute('aria-controls')).hidden`);
          await featureText('#knowledge-view [role=tabpanel]:not([hidden])');
        }
        await key('Home', 36);
        for (const tab of ['overview', 'ask', 'quality', 'build']) {
          assert.equal(await browser.evaluate(`document.activeElement.id === 'knowledge-tab-${tab}' &&
            document.activeElement.getAttribute('aria-selected') === 'true' && document.activeElement.tabIndex === 0 &&
            !document.getElementById(document.activeElement.getAttribute('aria-controls')).hidden &&
            document.querySelectorAll('#knowledge-view [role=tabpanel]:not([hidden])').length === 1`), true, tab);
          await key('ArrowRight', 39);
        }
        assert.equal(await browser.evaluate("document.querySelector('#knowledge-ask').disabled"), true);
        context.diagnostic('Knowledge page displayed the empty published store');
        await browser.evaluate("document.querySelector('#open-chat').click()");
        await browser.evaluate("document.querySelector('#open-knowledge').focus()");
        await browser.command('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
        });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.equal(await browser.evaluate("document.querySelector('#knowledge-view').hidden"), false);
        assert.equal(await browser.evaluate("document.activeElement.id"), 'knowledge-title');
        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-build').click();
          document.querySelector('#knowledge-repository').open = true;
          document.querySelector('#knowledge-folder').value = ${JSON.stringify(repository)};
          document.querySelector('#knowledge-check-folder').click();
        }`);
        await ready("document.querySelector('#knowledge-repository-status').textContent.includes('已解析發布標籤')");
        await browser.evaluate(`{
          document.querySelector('#knowledge-model-consent').checked = true;
          document.querySelector('#knowledge-import-folder').click();
        }`);
        await ready("!document.querySelector('#knowledge-ask')?.disabled");
        await selectors('#knowledge-view', ['#vault', '#vault-status', '#knowledge-folder', '#knowledge-model-consent',
          '#knowledge-check-folder', '#knowledge-import-folder', '#knowledge-question', '#knowledge-ask', '#knowledge-answer']);
        await selectors('#knowledge-overview', ['#vault-details', '#vault-technical', '#knowledge-rebuild', '#knowledge-demo-load',
          '#demo-model-consent', '#knowledge-filters [name=text]', '#knowledge-filters [name=type]', '#knowledge-filters [name=category]',
          '#knowledge-filters [name=domain]', '#knowledge-filters [name=sample]', '#knowledge-filters button',
          '#knowledge-prev', '#knowledge-next', '#knowledge-browser-status', '#knowledge-fts input', '#knowledge-fts button']);
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-repository-status').textContent"), /tag-a/);
        assert.match(await browser.evaluate<string>("document.querySelector('#vault-technical').textContent"), /tag-a@/);
        assert.equal((await (await api.get('/api/knowledge/vaults')).json()).vaults[0]?.id, vault);
        context.diagnostic('Chromium checked and imported the repository, and the authenticated API exposed its active generation');
        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-ask').click();
          document.querySelector('#knowledge-question').value = ${JSON.stringify(question)};
          document.querySelector('#knowledge-ask').click();
        }`);
        await ready("document.querySelector('#knowledge-answer')?.textContent.includes('±0.8 dB')");
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-answer button.knowledge-reference').textContent"), /合成量測手冊#row=1/);
        await featureText('#knowledge-view');
        await mouse('#knowledge-answer .knowledge-reference');
        await ready(`${panelIsOpen} && document.querySelector('${previewBody}').textContent.includes('±0.8 dB')`);
        assert.equal(await browser.evaluate("document.activeElement.matches('#panel-tabs [aria-selected=true]')"), true);
        await featureText(preview);
        await key('Escape', 27);
        await ready("document.querySelector('#chat-files').hidden && document.activeElement.matches('#knowledge-answer .knowledge-reference')");
        await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
        await ready('innerWidth === 390 && matchMedia("(max-width: 900px)").matches');
        await browser.evaluate("document.querySelector('#knowledge-answer .knowledge-reference').click()");
        await ready(panelIsOpen);
        assert.deepEqual(await browser.evaluate(`(() => {
          const overlay = document.querySelector('#chat-files');
          const { x, y, width, height } = overlay.getBoundingClientRect();
          return { x, y, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight,
            modal: overlay.getAttribute('aria-modal'), workAreaInert: document.querySelector('#work-area').inert,
            railInert: document.querySelector('.navigation').inert, back: document.querySelector('#close-files').textContent };
        })()`), { x: 0, y: 0, width: 390, height: 900, viewportWidth: 390, viewportHeight: 900,
          modal: 'true', workAreaInert: true, railInert: true, back: '返回頁面' });
        await closePreview();
        await ready("document.querySelector('#chat-files').hidden && !document.querySelector('#work-area').inert && document.activeElement.matches('#knowledge-answer .knowledge-reference')");
        await browser.command('Emulation.clearDeviceMetricsOverride');
        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-overview').click();
          document.querySelector('#knowledge-fts input').value = 'SYN-48B';
          document.querySelector('#knowledge-fts').requestSubmit();
        }`);
        await ready("document.querySelector('#knowledge-matches mark')?.textContent.includes('SYN')");
        await ready("!document.querySelector('#knowledge-next').disabled");
        await browser.evaluate("document.querySelector('#knowledge-next').click()");
        await ready("document.querySelector('#knowledge-browser-status').textContent.includes('26')");
        await browser.evaluate("document.querySelector('#knowledge-cards [data-sort=title]').click()");
        await ready("document.querySelector('#knowledge-cards th[aria-sort=descending]')");
        assert.equal(await browser.evaluate("document.querySelectorAll('#knowledge-cards th [data-sort]').length"), 6);
        await browser.evaluate("document.querySelector('#knowledge-matches button').click()");
        await ready(panelIsOpen);
        await clickLabel(preview, '開啟卡片');
        await ready(`document.querySelector('${previewBody} blockquote')?.textContent.includes('±0.8 dB')`);
        if (process.env.OEP_KNOWLEDGE_SCREENSHOTS === '1') {
          await captureGallery(['overview', 'ask', 'quality', 'build', 'drawer'].map((screen) =>
            ['slice3a-' + screen, async () => {
              await browser.evaluate(`{
                document.querySelector('#knowledge-tab-${screen === 'drawer' ? 'overview' : screen}').click();
                document.querySelector('#knowledge-folder').value = 'C:/OEP/合成儲存庫';
                if ('${screen}' === 'drawer') document.querySelector('#knowledge-cards tbody button').click();
              }`);
              if (screen === 'drawer') await ready(`document.querySelector('${previewBody} h3')`);
            }]));
        }
        await browser.evaluate("document.querySelector('#close-files').click(); document.querySelector('#knowledge-tab-ask').click()");
        await browser.evaluate(`{
          document.querySelector('#knowledge-question').value = 'SYN-48B synthetic rejected question';
          document.querySelector('#knowledge-ask').click();
        }`);
        await ready("document.querySelector('#knowledge-status').textContent.includes('模型服務拒絕處理這個問題')");
        assert.equal(await browser.evaluate("document.querySelector('#knowledge-status').textContent"),
          '模型服務拒絕處理這個問題，系統未再次傳送證據。請換個問法再試。');
        assert.equal(rejectedCalls, 1);
        await browser.evaluate("document.querySelector('#open-chat').click(); document.querySelector('#new-session').click()");
        await ready("!document.querySelector('#prompt').disabled");
        await browser.evaluate(`{
          document.querySelector('#prompt').value = ${JSON.stringify('/ask ' + vault + ' ' + question)};
          document.querySelector('#composer').requestSubmit();
        }`);
        await ready("document.querySelector('#knowledge-status').textContent.includes('引用已通過驗證')");
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-answer button.knowledge-reference').textContent"), /合成量測手冊#row=1/);
        await ready("document.querySelector('#vault').value === 'synthetic-bench' && !document.querySelector('#quality-actions').hidden && !document.querySelector('#vault').disabled");
        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-quality').click();
          const form = document.querySelector('#quality-add-set');
          form.elements.name.value = '合成品質檢查';
          form.requestSubmit();
        }`);
        await ready("document.querySelector('#quality-sets').value === '合成品質檢查'");
        await selectors('#knowledge-quality', ['#quality-sets', '#quality-aliases', '#quality-run', '#quality-stop', '#quality-add-set input',
          '#quality-add-set button', '#quality-remove-set', '#quality-json-file', '#quality-json', '#quality-import', '#quality-export',
          '#quality-editor [name=query]', '#quality-editor [name=answer]', '#quality-editor [name=kind]', '#quality-editor [name=passages]',
          '#quality-find', '#quality-evidence', '#quality-matches', '#quality-editor [type=submit]', '#quality-new-question']);
        await featureText('#knowledge-quality');
        await browser.evaluate(`{
          const form = document.querySelector('#quality-editor');
          form.elements.query.value = 'Benchmark SYN-48B calibration';
          form.elements.answer.value = '±0.8 dB';
          form.elements.passages.value = 'SYN-48B';
          document.querySelector('#quality-find').click();
        }`);
        await ready("document.querySelector('#quality-matches button')");
        await browser.evaluate(`{
          document.querySelector('#quality-matches button').click();
          document.querySelector('#quality-editor').requestSubmit();
        }`);
        await ready("document.querySelector('#quality-questions li')?.textContent.includes('Benchmark')");
        await labels('#quality-questions', ['編輯', '刪除']);
        await browser.evaluate(`{
          document.querySelector('#quality-question-list').open = true;
          document.querySelector('#quality-questions button').click();
          const form = document.querySelector('#quality-editor');
          form.elements.query.value = 'Benchmark SYN-48B calibration revised';
          form.requestSubmit();
        }`);
        await ready("document.querySelector('#quality-questions li')?.textContent.includes('revised')");
        await browser.evaluate(`{
          const form = document.querySelector('#quality-editor');
          form.elements.query.value = 'SYN-404 absent';
          form.elements.kind.value = 'no-evidence';
          form.requestSubmit();
        }`);
        await ready("document.querySelectorAll('#quality-questions li').length === 2");
        await browser.evaluate("document.querySelector('#quality-run').click()");
        await ready("document.querySelector('#quality-results').textContent.includes('D03 通過')");
        await browser.evaluate(`{
          document.querySelector('#quality-export').click();
          const json = document.querySelector('#quality-json');
          const questions = JSON.parse(json.value);
          questions[0].answer = '合成錯誤答案';
          json.value = JSON.stringify(questions);
          document.querySelector('#quality-import').click();
        }`);
        await until(async () => {
          const data = await (await api.post('/api/knowledge/benchmarks', { vault })).json();
          return data.sets.some((entry: { questions: { answer: string }[] }) =>
            entry.questions.some(({ answer }) => answer === '合成錯誤答案')) || undefined;
        }, 5000);
        await ready("!document.querySelector('#quality-actions').hidden && !document.querySelector('#quality-actions').inert && !document.querySelector('#quality-run').disabled");
        await browser.evaluate("document.querySelector('#quality-run').click()");
        await ready("document.querySelector('#quality-results').textContent.includes('D03 未通過')");
        await browser.evaluate("document.querySelector('#quality-results details').open = true");
        assert.match(await browser.evaluate<string>("document.querySelector('#quality-results details').textContent"), /答案或引用與預期不符/);
        await browser.evaluate("document.querySelector('#quality-results details button').click()");
        await ready(`${panelIsOpen} && document.querySelector('${previewBody} blockquote')?.textContent.includes('±0.8 dB')`);
        await browser.evaluate("document.querySelector('#close-files').click()");
        await browser.evaluate(`{
          document.querySelector('#quality-questions button').click();
          const form = document.querySelector('#quality-editor');
          form.elements.query.value = 'Benchmark SYN-48B calibration cancel';
          form.requestSubmit();
        }`);
        await ready("document.querySelector('#quality-questions li')?.textContent.includes('cancel')");
        await browser.evaluate("document.querySelector('#quality-run').click()");
        await until(() => Promise.resolve(benchmarkStarted || undefined), 5000);
        await browser.evaluate("document.querySelector('#quality-stop').click()");
        await ready("document.querySelector('#quality-results').textContent.includes('已取消')");

        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-build').click();
          const reviewPanel = document.querySelector('#wiki-review');
          reviewPanel.open = true;
          const [reviewVault, reviewVersion] = reviewPanel.querySelectorAll('input');
          reviewVault.value = 'synthetic-wiki';
          reviewVersion.value = '1';
          [...reviewPanel.querySelectorAll('button')].find(button => button.textContent === '安裝 Schema 並建立草稿範本').click();
        }`);
        await ready("document.querySelector('#wiki-review details textarea').value.includes('synthetic-wiki')");
        await featureText('#knowledge-build');
        for (const kind of ['#ingest-review', '#wiki-review']) {
          await labels(kind, ['安裝 Schema 並建立草稿範本', '載入既有知識庫', '載入來源至草稿', '查看來源文字',
            '送交審核', '送交 JSON 審核', '查看已送審草稿']);
          await selectors(kind, ['input[list]', 'datalist', 'details input', 'input[type=file]', 'textarea', 'details textarea', '[role=status]']);
        }
        await labels('#ingest-review', ['產生模型提案']);
        const clickReview = (label: string) => browser.evaluate(
          `[...document.querySelectorAll('#wiki-review button')].find(element => element.textContent === ${JSON.stringify(label)}).click()`);
        await browser.evaluate(`{
          document.querySelector('#wiki-review textarea').value = 'Synthetic Wiki source.';
        }`);
        await clickReview('載入來源至草稿');
        await ready(`document.querySelector('${preview} textarea[readonly]').value.includes('Synthetic Wiki')`);
        await closePreview();
        await clickReview('送交審核');
        await ready("!Array.from(document.querySelectorAll('#wiki-review button')).find(item => item.textContent === '查看已送審草稿').hidden");
        await browser.evaluate("document.querySelector('#open-review').click()");
        await ready("document.querySelector('#review-wiki-pending').textContent.includes('待審核')");
        await featureText('#review-view');
        await mouse('#review-wiki-pending button');
        await ready(`${panelIsOpen} && document.querySelector('${previewBody} blockquote')?.textContent.includes('Synthetic Wiki')`);
        await featureText(preview);
        await labels(preview, ['比較版本與證據', '搜尋草稿', '儲存修訂', '核准', '拒絕', '捨棄草稿']);
        assert.equal(await browser.evaluate(`![...document.querySelectorAll('${preview} button')].some(item => item.textContent === '發布')`), true);
        const reviewList = await (await api.get(reviewsPath)).json();
        const id = reviewList.reviews[0].id;
        assert.equal((await api.post(reviewsPath, { action: 'publish', id })).status, 422);
        await clickLabel(preview, '核准');
        await ready(`document.querySelector('${preview}').textContent.includes('已核准')`);
        const approved = await (await api.get(reviewsPath)).json();
        assert.equal(approved.reviews.find((row: { id: string }) => row.id === id).status, 'approved');
        assert.equal(approved.intents.length, 0);
        await labels(preview, ['發布']);
        await clickLabel(preview, '發布');
        await ready(`document.querySelector('${preview}').textContent.includes('回復前一版本')`);
        assert.equal((await (await api.get(reviewsPath)).json()).intents.length, 1);
        await clickLabel(preview, '更多');
        await clickLabel(preview, '回復前一版本');
        await until(async () => !(await (await api.get('/api/knowledge/vaults')).json()).vaults
          .some(({ id }: { id: string }) => id === 'synthetic-wiki'), 5000);
        await ready(`document.querySelector('${preview}')?.textContent.includes('重新啟用')`);
        await closePreview();
        await browser.evaluate("document.querySelector('#open-knowledge').click(); document.querySelector('#knowledge-tab-build').click()");
        const bi = (label: string) => browser.evaluate(
          `[...document.querySelectorAll('#ingest-review button')].find(element => element.textContent === ${JSON.stringify(label)}).click()`);
        await browser.evaluate(`{
          const panel = document.querySelector('#ingest-review');
          panel.open = true;
          const [vaultInput, version, fields] = panel.querySelectorAll('input');
          vaultInput.value = ${JSON.stringify(vault)};
          version.value = '1';
          fields.value = 'setting';
          panel.querySelector('textarea').value = 'Synthetic SYN-NEW calibration is 7.2 mm.';
        }`);
        await bi('安裝 Schema 並建立草稿範本');
        await ready("[...document.querySelectorAll('#ingest-review button')].some(button => button.textContent === '新增卡片')");
        await bi('載入來源至草稿');
        await bi('新增卡片');
        await selectors('#ingest-review', ['fieldset select', 'fieldset input', 'fieldset textarea', 'fieldset button']);
        await browser.evaluate(`{
          const card = [...document.querySelectorAll('#ingest-review fieldset')].at(-1);
          const [title, setting] = card.querySelectorAll('input');
          title.value = 'Synthetic new calibration';
          setting.value = '7.2 mm';
          document.querySelector('#file-preview .feature-preview:not([hidden]) textarea[readonly]').select();
          card.querySelector('button').click();
        }`);
        await closePreview();
        await bi('送交審核');
        await ready("!Array.from(document.querySelectorAll('#ingest-review button')).find(item => item.textContent === '查看已送審草稿').hidden");
        await bi('查看已送審草稿');
        await ready(`document.querySelector('${preview}').textContent.includes('待審核')`);
        await clickLabel(preview, '比較版本與證據');
        await ready(`document.querySelector('${preview}').textContent.includes('新增 1 · 變更 0 · 移除 0')`);
        await clickLabel(preview, '核准');
        await ready(`document.querySelector('${preview}').textContent.includes('已核准')`);
        await clickLabel(preview, '發布');
        await ready(`document.querySelector('${preview}').textContent.includes('回復前一版本')`);
        const biAnswer = await (await api.post('/api/knowledge/ask', { vault, question: 'SYN-NEW calibration' })).json();
        assert.equal(biAnswer.state, 'verified');
        assert.equal(biAnswer.citations[0].quote, '7.2 mm');
        assert.equal(biAnswer.citations[0].source, 'pasted.md');
        await clickLabel(preview, '更多');
        await clickLabel(preview, '回復前一版本');
        await until(async () => (await (await api.get('/api/knowledge/vaults')).json()).vaults
          .some(({ id, tag }: { id: string; tag?: string }) => id === vault && tag === 'tag-a'), 5000);
        await closePreview();
        await bi('載入既有知識庫');
        await ready("document.querySelector('#ingest-review [role=status]').textContent.includes('已載入知識庫')");
        await bi('產生模型提案');
        await ready(`document.querySelector('${preview} h2')?.textContent === '模型提案' &&
          document.querySelector('${previewBody} blockquote')?.textContent.includes('7.2 mm')`);
        await featureText(preview);
        await closePreview();

        const { sha256: scheduleSchema } = await (await api.post(reviewsPath, {
          action: 'schema', vault: 'schedule-example', schema: 'local-bi', version: '1', fields: ['setting'],
        })).json();
        const sampleSource = '合成排程來源';
        const candidate: Candidate = {
          vault: { id: 'schedule-example', kind: 'bi', title: '測試排程資料' }, schema: scheduleSchema,
          sources: [{ id: 'schedule-source', ref: 'schedule.txt', original: sampleSource, markdown: sampleSource }],
          cards: [{ id: 'schedule-card', type: 'record', key: 'schedule-card', title: '定期檢查', version: '1', fields: { setting: sampleSource } }],
          relationships: [], evidence: [{ sourceId: 'schedule-source', cardId: 'schedule-card', field: 'setting', start: 0, end: sampleSource.length }],
        };
        for (const state of ['active', 'paused', 'draft']) {
          const id = 'schedule-' + state;
          assert.equal((await api.post('/api/jobs', { action: 'schedule', id, zone: 'Asia/Taipei', time: '09:00', candidate })).status, 200);
          if (state !== 'draft') assert.equal((await api.post('/api/jobs', { action: 'state', id, state })).status, 200);
        }
        assert.equal((await api.post('/api/jobs', { action: 'runNow', id: 'schedule-paused' })).status, 200);
        runtime.knowledge!.reviewStore.enqueueBi('manual-fixture', candidate);
        assert.ok(runtime.knowledge!.reviewStore.claimBi('manual-fixture'));
        const jobsFixture = new TelegramInbox(join(root, 'telegram.sqlite'), false);
        try {
          jobsFixture.db.prepare("INSERT INTO bi_sources(id,ref,state,reason,domain,bytes) VALUES (1,'fixture.txt','blocked','需要文字','檢查',?)")
            .run(Buffer.from(sampleSource));
          jobsFixture.db.exec("INSERT INTO outbox (bot,id,topic,text,state) VALUES ('bi','fixture-notice',1,'測試通知','indeterminate')");
        } finally { jobsFixture.db.close(); }
        await browser.evaluate("document.querySelector('#open-jobs').click()");
        await ready("document.querySelector('#jobs-content').textContent.includes('下次執行 ')");
        await labels('#jobs-content', ['schedule-active', 'schedule-paused', 'schedule-draft', '編輯', '核准', '拒絕', '暫停', '恢復', '移除', '立即執行']);
        await selectors('#jobs-content', ['[data-feature-focus="job-manual-fixture"]',
          '[data-feature-focus="job-more-manual-fixture"]:is(button)']);
        await mouse('[data-feature-focus="schedule-schedule-active"]');
        await ready(`${panelIsOpen} && document.querySelector('${preview} h2')?.textContent === 'schedule-active'`);
        assert.equal(await browser.evaluate(`document.querySelector('${preview}').closest('#chat-files')?.id`), 'chat-files');
        await clickLabel(preview, '執行紀錄');
        await ready(`document.querySelector('${preview} h2')?.textContent === '執行紀錄 · schedule-active'`);
        await key('Escape', 27);
        await ready("document.querySelector('#chat-files').hidden && document.activeElement.dataset.featureFocus === 'schedule-schedule-active'");
        await clickLabel('#jobs-content', '執行紀錄');
        await ready(`document.querySelector('${previewBody}').textContent.includes('schedule-paused')`);
        await featureText(preview);
        await closePreview();
        await clickLabel('#jobs-content', '新增排程');
        await selectors(preview, ['input[type=time]', 'input:not([type])', 'details textarea']);
        await labels(preview, ['儲存待核准排程', '立即送出工作']);
        await closePreview();
        await browser.evaluate("document.querySelector('#jobs-content .knowledge-pager details').open = true");
        await clickLabel('#jobs-content', '通知紀錄');
        await labels(preview, ['需核對的通知', '手動重送']);
        await featureText(preview);
        await closePreview();
        await clickLabel('#jobs-content', 'Telegram 收件');
        await clickLabel(preview, '收件 1 · 需要補件');
        await selectors(preview, ['a[href="/api/jobs/source/1"]', 'textarea']);
        await labels(preview, ['下載來源', '送審']);
        await closePreview();
        await browser.evaluate("document.querySelector('#open-review').click()");
        await ready("document.querySelector('#review-import-jobs').textContent.includes('已送審')");
        await labels('#review-import-jobs', ['立即執行']);
        await featureText('#review-view');

        if (process.env.OEP_KNOWLEDGE_SCREENSHOTS === '1') {
          const showJobs = async () => {
            await browser.evaluate("if (document.querySelector('#jobs-view').hidden) document.querySelector('#open-jobs').click()");
            await ready("!document.querySelector('#jobs-view').hidden && document.querySelector('#jobs-content').textContent.includes('下次執行 ')");
          };
          const showReview = async () => {
            await browser.evaluate("if (document.querySelector('#review-view').hidden) document.querySelector('#open-review').click()");
            await ready("!document.querySelector('#review-view').hidden && document.querySelector('#review-bi-pending button')");
          };
          await captureGallery([
            ['jobs-list', showJobs],
            ['jobs-details', async () => {
              await showJobs();
              await clickLabel('#jobs-content', 'schedule-paused');
              await clickLabel(preview, '執行紀錄');
              await ready(`document.querySelector('${previewBody}')?.textContent.includes('schedule-paused')`);
            }],
            ['review-list', showReview],
            ['review-item', async () => {
              await showReview();
              await browser.evaluate("document.querySelector('#review-bi-pending button').click()");
              await ready(`document.querySelector('${previewBody} blockquote')`);
            }],
          ]);
        }

        const large = largeKnowledgeFixture();
        runtime.knowledge!.reviewStore.import(large, Buffer.from(canonical(large)));
        for (const [operation, input] of [
          ['list', { offset: 1475 }],
          ['filter', { sample: 'sample', type: 'odd', domain: 'Lab' }],
          ['FTS', { query: 'calibration' }],
        ] as const) {
          const times = [];
          for (let attempt = 0; attempt < 12; attempt++) {
            const started = performance.now();
            const response = await api.post('/api/knowledge/browse', { vault: large.vault.id, ...input });
            const data = await response.json();
            times.push(performance.now() - started);
            assert.equal(response.status, 200);
            if (operation === 'FTS') assert.equal(data.passages.length, 25);
            else {
              assert.equal(data.cards.length, 25);
              assert.equal(data.total, operation === 'list' ? 1500 : 750);
            }
          }
          const slowest = Math.max(...times);
          context.diagnostic(`1500-card HTTP ${operation} max ${slowest.toFixed(2)} ms`);
          assert.ok(slowest < 200, operation + ' HTTP time exceeded 200 ms');
        }
        for (const version of [8, 9] as const) {
          const { snapshot: variant } = goldFixture();
          variant.vault = { ...variant.vault, id: 'synthetic-v' + version, title: '合成相容性資料 ' + version };
          for (const card of variant.cards) card.fields = { field: '合成欄位' };
          const folder = join(root, 'variant-' + version);
          syntheticRepository(folder, { snapshot: variant, version });
          assert.equal((await api.post('/api/knowledge/import', { folder })).status, 200);
        }
        await browser.evaluate("document.querySelector('#open-chat').click(); document.querySelector('#open-knowledge').click()");
        await ready("document.querySelector('#vault option[value=synthetic-large]')");
        await browser.evaluate(`{
          const vault = document.querySelector('#vault');
          vault.value = 'synthetic-large';
          vault.dispatchEvent(new Event('change'));
          document.querySelector('#knowledge-tab-overview').click();
          document.querySelector('#knowledge-tab-overview').focus();
        }`);
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        assert.equal(await browser.evaluate("document.activeElement.id"), 'knowledge-tab-ask');
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
        await ready("document.querySelector('#knowledge-browser-status').textContent.includes('1500')");
        await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
        assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
        await browser.command('Emulation.clearDeviceMetricsOverride');
        await browser.evaluate("document.querySelector('#knowledge-cards tbody button').click()");
        await ready(`document.querySelector('${previewBody} blockquote')?.textContent.includes('passage 0')`);
        await clickLabel(preview, 'Sample 1');
        await ready(`document.querySelector('${preview} h2').textContent === 'Sample 1'`);
        await browser.evaluate("document.querySelector('#close-files').click()");
        await browser.evaluate(`{
          const form = document.querySelector('#knowledge-filters');
          form.elements.type.value = 'odd';
          form.elements.sample.value = 'sample';
          form.elements.domain.value = 'Lab';
          form.elements.text.value = 'Sample';
          form.requestSubmit();
        }`);
        await ready("document.querySelector('#knowledge-browser-status').textContent.includes('750')");
        await browser.evaluate("document.querySelector('#knowledge-cards [data-sort=title]').click()");
        await ready("document.querySelector('#knowledge-cards tbody button')?.textContent === 'Sample 1499'");
        await browser.evaluate("document.querySelector('#knowledge-next').click()");
        await ready("document.querySelector('#knowledge-browser-status').textContent.includes('26–50')");
        for (const version of [8, 9]) {
          await browser.evaluate(`{
            const vault = document.querySelector('#vault');
            vault.value = 'synthetic-v${version}';
            vault.dispatchEvent(new Event('change'));
          }`);
          await ready("document.querySelector('#knowledge-cards tbody button')");
          await browser.evaluate("document.querySelector('#knowledge-cards tbody button').click()");
          await ready(`document.querySelector('${previewBody}').textContent.includes('合成欄位')`);
          assert.match(await browser.evaluate<string>(`document.querySelector('${previewBody}').textContent`), /欄位狀態無資料/);
          await browser.evaluate("document.querySelector('#close-files').click()");
        }
        await browser.evaluate(`{
          window.confirm = () => true;
          document.querySelector('#knowledge-rebuild').click();
        }`);
        await ready("document.querySelector('#knowledge-rebuild-status').textContent.includes('已重建')");
        await browser.evaluate(`{
          const vault = document.querySelector('#vault');
          vault.value = 'synthetic-large';
          vault.dispatchEvent(new Event('change'));
          document.querySelector('#knowledge-tab-quality').click();
          window.knowledgeReloadMarker = true;
        }`);
        await browser.command('Page.reload');
        await ready("!window.knowledgeReloadMarker && document.readyState === 'complete' && document.querySelector('#open-knowledge')?.disabled === false");
        await browser.evaluate("document.querySelector('#open-knowledge').click()");
        await ready(`document.querySelector('#vault').value === 'synthetic-large' &&
          document.querySelector('#knowledge-tab-quality').getAttribute('aria-selected') === 'true' &&
          !document.querySelector('#knowledge-quality').hidden`);
        await browser.evaluate("document.querySelector('#knowledge-tab-overview').click()");
        await browser.evaluate("document.querySelector('#knowledge-demo-load').click()");
        await ready("document.querySelector('#vault').value === 'oep-synthetic-demo' && !document.querySelector('#knowledge-demo-remove').hidden");
        await selectors('#knowledge-overview', ['#knowledge-demo-remove']);
        await featureText('#knowledge-view');
        await ready("document.querySelectorAll('#quality-questions li').length === 48");
        assert.equal(await browser.evaluate("document.querySelector('#quality-editor').hidden"), true);
        await browser.evaluate("document.querySelector('#knowledge-demo-remove').click()");
        await ready("!document.querySelector('#vault option[value=oep-synthetic-demo]')");

        assert.equal((await api.post('/api/settings/knowledge', { atlasUrl: 'http://atlas.example.invalid', toolbox: true })).status, 400);
        await browser.evaluate(`{
          document.querySelector('#open-settings').click();
          document.querySelector('[data-section=integrations]').click();
          window.atlasOpened = [];
          window.open = (...args) => window.atlasOpened.push(args);
        }`);
        await ready("document.querySelector('#knowledge-toolbox').checked");
        await browser.evaluate(`{
          document.querySelector('#atlas-url').value = 'https://atlas.example.invalid/';
          document.querySelector('#knowledge-toolbox').checked = false;
          document.querySelector('#knowledge-settings').requestSubmit();
        }`);
        await ready("document.querySelector('#knowledge-settings-status').textContent === '已儲存。'");
        assert.equal(await browser.evaluate("window.atlasOpened.length"), 0);
        await browser.evaluate("window.confirm = () => false; document.querySelector('#open-atlas').click()");
        assert.equal(await browser.evaluate("window.atlasOpened.length"), 0);
        await browser.evaluate("window.confirm = () => true; document.querySelector('#open-atlas').click()");
        assert.equal(await browser.evaluate("window.atlasOpened[0][0]"), 'https://atlas.example.invalid/');
        const disabled = await (await api.post('/api/sessions', { agent: 'inspector' })).json();
        assert.deepEqual(disabled.tools, []);
        const accepted = await api.post(`/api/sessions/${disabled.id}/turns`, {
          id: randomUUID(), text: 'Synthetic toolbox disabled probe', attachments: [], workbook: false,
        });
        assert.equal(accepted.status, 202);
        await until(async () => {
          const state = await (await api.get(`/api/sessions/${disabled.id}/state`)).json();
          return state.messages.some((entry: { text: string }) => entry.text === 'Knowledge tool unavailable') || undefined;
        }, 15_000);
        await browser.evaluate("document.querySelector('#open-chat').click()");
        assert.equal(await browser.evaluate("document.querySelector('#chat-view').hidden"), false);
        assert.equal(await browser.evaluate("document.activeElement.id"), 'open-chat');
        await browser.evaluate("document.querySelector('#open-settings').click()");
        await browser.evaluate("document.querySelector('[data-section=mcp]').click()");
        await ready("document.querySelector('#mcp-knowledge-status').textContent === '已停用'");
        assert.equal(await browser.evaluate("document.querySelector('#mcp-knowledge-tools').hidden"), false);
        if (process.env.OEP_MCP_SCREENSHOTS === '1') {
          for (const theme of ['light', 'dark']) {
            for (const [size, width] of [['wide', 1360], ['narrow', 420]] as const) {
              await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
              await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'; window.scrollTo(0, 0)`);
              const image = await browser.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
              writeFileSync(join('docs', 'validation', 'gui', `slice4a-mcp-${theme}-${size}.png`), Buffer.from(image.data, 'base64'));
            }
          }
          await browser.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
          await browser.evaluate("delete document.documentElement.dataset.theme");
        }
        await browser.evaluate("document.querySelector('#mcp-open-knowledge-settings').focus()");
        await browser.command('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
        });
        await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.equal(await browser.evaluate("document.activeElement.id"), 'knowledge-toolbox');
        assert.equal((await api.post('/api/settings/knowledge', { atlasUrl: '', toolbox: true })).status, 200);
      } finally { await browser.close(); }
      const noEvidence = await api.post('/api/knowledge/ask', { vault, question: 'SYN-404' });
      assert.equal((await noEvidence.json()).reason, 'no-evidence');
      const forged = await api.post('/api/knowledge/ask', { vault, question: 'Does SYN-48B have the wrong limit?' });
      assert.equal((await forged.json()).reason, 'invalid-citation');
      assert.equal(knowledgeCalls, 3);
      for (const [prompt, reply] of [[question, '合成驗收結果 ±0.8 dB'],
        ['Does SYN-48B have the wrong limit?', '合成驗收拒答']]) {
        const created = await api.post('/api/sessions', { agent: 'inspector' });
        assert.equal(created.status, 201);
        const session = await created.json();
        const accepted = await api.post(`/api/sessions/${session.id}/turns`, {
          id: randomUUID(), text: `Use the built-in knowledge tool on vault "${vault}". ${prompt}`, attachments: [], workbook: false,
        });
        assert.equal(accepted.status, 202);
        const state = await until(async () => {
          const result = await (await api.get(`/api/sessions/${session.id}/state`)).json();
          const state = result.runs.at(-1)?.state;
          return state === 'verified' || state === 'failed' ? result : undefined;
        }, 35_000);
        assert.equal(state.runs.at(-1).state, 'verified');
        assert.ok(state.messages.some((entry: { text: string }) => entry.text.includes(reply)));
      }
      assert.equal(knowledgeCalls, 5);
      assert.equal(toolResults, 2);
      const inbox = new TelegramInbox(join(root, 'test-telegram.sqlite'));
      const sessions = new WebStore(join(root, 'test-telegram-chat.sqlite'));
      const chat = new ChatService(sessions, runtime, root, join(audit, 'test-telegram.jsonl'), () => {});
      try {
        const router = new TelegramRouter(inbox, runtime, chat, sessions);
        const signal = new AbortController().signal;
        const result = await router.handle({ id: 1, bot: 'main', topic: 1,
          payload: JSON.stringify({ text: '/ask ' + vault + ' ' + question }) }, signal);
        assert.match(result ?? '', /±0\.8 dB/);
        assert.ok(result?.includes(citationId));
        for (const topic of [1, 2]) {
          const row = { id: topic + 1, bot: 'main' as const, topic,
            payload: JSON.stringify({ text: 'Synthetic Telegram topic ' + topic }) };
          assert.equal(await until(() => router.handle(row, signal), 25_000), 'Synthetic answer topic ' + topic);
        }
        assert.equal(sessions.sessions().length, 2);
        assert.equal(new Set(sessions.sessions().map((session) => session.upstreamID)).size, 2);
      } finally {
        await chat.close();
        sessions.close();
        inbox.db.close();
      }
      context.diagnostic('Chromium rendered a reproducible citation and OpenCode MCP returned both verified and rejected results');
    } finally { await web.close(); }
  } finally {
    const stopped = await runtime.stop();
    assert.equal(stopped.orphans, 0);
    assert.equal(stopped.supervisorExit, 0);
  }
});
