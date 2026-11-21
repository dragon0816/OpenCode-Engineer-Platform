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
import { canonical } from '../../packages/knowledge/src/snapshot.ts';
import { largeKnowledgeFixture } from '../fixtures/knowledge/large.ts';
import { goldFixture } from '../fixtures/knowledge/gold.ts';
import { syntheticRepository } from '../fixtures/knowledge/repository.ts';
import { chromium } from './chromium.ts';
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
  const synthetic: typeof fetch = async (_target, init) => {
    const { model, messages, tools, stream } = JSON.parse(String(init?.body)) as WireRequest & { stream: boolean };
    if (!stream) {
      const user = JSON.parse(String(messages.find((message) => message.role === 'user')?.content));
      if (user.question === 'SYN-NEW calibration') {
        const passage = user.evidence.find(({ text }: { text: string }) => text.includes('SYN-NEW'));
        assert.ok(passage);
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          state: 'answer', citations: [{ passageID: passage.id, quote: '7.2 mm' }],
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
      try {
        await browser.command('Page.navigate', { url: web.pairURL() });
        await ready("!document.querySelector('#open-knowledge')?.disabled");
        await browser.evaluate("document.querySelector('#open-jobs').click()");
        await ready("document.querySelector('#jobs-content').textContent.includes('BI Telegram 收件')");
        assert.equal(await browser.evaluate("document.querySelector('#jobs-view').hidden"), false);
        await browser.evaluate("document.querySelector('#open-knowledge').click()");
        assert.equal(await browser.evaluate("document.querySelector('#jobs-view').hidden"), true);
        await ready("document.querySelector('#knowledge-status').textContent.includes('沒有已發布')");
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
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-repository-status').textContent"), /tag-a/);
        assert.match(await browser.evaluate<string>("document.querySelector('#vault-details').textContent"), /tag-a@/);
        assert.equal((await (await api.get('/api/knowledge/vaults')).json()).vaults[0]?.id, vault);
        context.diagnostic('Chromium checked and imported the repository, and the authenticated API exposed its active generation');
        await browser.evaluate(`{
          document.querySelector('#knowledge-tab-ask').click();
          document.querySelector('#knowledge-question').value = ${JSON.stringify(question)};
          document.querySelector('#knowledge-ask').click();
        }`);
        await ready("document.querySelector('#knowledge-answer')?.textContent.includes('±0.8 dB')");
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-answer details summary').textContent"), /合成量測手冊#row=1/);
        await browser.evaluate("document.querySelector('#knowledge-answer summary').click()");
        await ready("document.querySelector('#knowledge-drawer').open && document.querySelector('#knowledge-drawer-body').textContent.includes('±0.8 dB')");
        await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await ready("!document.querySelector('#knowledge-drawer').open");
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
        await browser.evaluate("document.querySelector('#knowledge-matches button').click()");
        await ready("document.querySelector('#knowledge-drawer').open");
        await browser.evaluate("document.querySelector('#knowledge-drawer-body button').click()");
        await ready("document.querySelector('#knowledge-drawer-body blockquote')?.textContent.includes('±0.8 dB')");
        if (process.env.OEP_KNOWLEDGE_SCREENSHOTS === '1') {
          for (const theme of ['light', 'dark']) {
            for (const [size, width] of [['wide', 1360], ['narrow', 420]] as const) {
              await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
              await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
              for (const screen of ['drawer', 'overview', 'ask', 'quality', 'build']) {
                await browser.evaluate(`{
                  document.querySelector('#knowledge-drawer').close();
                  document.querySelector('#knowledge-tab-${screen === 'drawer' ? 'overview' : screen}').click();
                  document.querySelector('#knowledge-folder').value = 'C:/OEP/合成儲存庫';
                  document.querySelector('#knowledge-title').scrollIntoView({ block: 'start' });
                  window.scrollTo(0, 0);
                  if ('${screen}' === 'drawer') document.querySelector('#knowledge-cards tbody button').click();
                }`);
                if (screen === 'drawer') await ready("document.querySelector('#knowledge-drawer-body h3')");
                const image = await browser.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
                writeFileSync(join('docs', 'validation', 'gui', `slice3a-${screen}-${theme}-${size}.png`), Buffer.from(image.data, 'base64'));
              }
            }
          }
          await browser.command('Emulation.clearDeviceMetricsOverride');
        }
        await browser.evaluate("document.querySelector('#knowledge-drawer').close(); document.querySelector('#knowledge-tab-ask').click()");
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
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-answer details summary').textContent"), /合成量測手冊#row=1/);
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
        const clickReview = (label: string) => browser.evaluate(
          `[...document.querySelectorAll('#wiki-review button')].find(element => element.textContent === ${JSON.stringify(label)}).click()`);
        await browser.evaluate(`{
          document.querySelector('#wiki-review textarea').value = 'Synthetic Wiki source.';
        }`);
        await clickReview('載入來源至草稿');
        await ready("document.querySelector('#wiki-review textarea[readonly]').value.includes('Synthetic Wiki')");
        await clickReview('送交審核');
        await ready("document.querySelector('#wiki-review').textContent.includes('待審核')");
        const reviewList = await (await api.get(reviewsPath)).json();
        const id = reviewList.reviews[0].id;
        assert.equal((await api.post(reviewsPath, { action: 'publish', id })).status, 422);
        await clickReview('核准');
        await ready("document.querySelector('#wiki-review').textContent.includes('已核准')");
        await clickReview('發布');
        await ready("document.querySelector('#wiki-review').textContent.includes('回復前一版本')");
        assert.equal((await (await api.get(reviewsPath)).json()).intents.length, 1);
        await clickReview('回復前一版本');
        await until(async () => !(await (await api.get('/api/knowledge/vaults')).json()).vaults
          .some(({ id }: { id: string }) => id === 'synthetic-wiki'), 5000);
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
        await browser.evaluate(`{
          const card = [...document.querySelectorAll('#ingest-review fieldset')].at(-1);
          const [title, setting] = card.querySelectorAll('input');
          title.value = 'Synthetic new calibration';
          setting.value = '7.2 mm';
          document.querySelector('#ingest-review textarea[readonly]').select();
          card.querySelector('button').click();
        }`);
        await bi('送交審核');
        await ready("document.querySelector('#ingest-review').textContent.includes('待審核')");
        await bi('比較版本與證據');
        await ready("document.querySelector('#ingest-review').textContent.includes('新增 1 · 變更 0 · 移除 0')");
        await bi('核准');
        await ready("document.querySelector('#ingest-review').textContent.includes('已核准')");
        await bi('發布');
        await ready("document.querySelector('#ingest-review').textContent.includes('回復前一版本')");
        const biAnswer = await (await api.post('/api/knowledge/ask', { vault, question: 'SYN-NEW calibration' })).json();
        assert.equal(biAnswer.state, 'verified');
        assert.equal(biAnswer.citations[0].quote, '7.2 mm');
        assert.equal(biAnswer.citations[0].source, 'pasted.md');
        await bi('回復前一版本');
        await until(async () => (await (await api.get('/api/knowledge/vaults')).json()).vaults
          .some(({ id, tag }: { id: string; tag?: string }) => id === vault && tag === 'tag-a'), 5000);
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
          variant.vault = { ...variant.vault, id: 'synthetic-v' + version, title: '合成 SQLite ' + version };
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
        await ready("document.querySelector('#knowledge-drawer-body blockquote')?.textContent.includes('passage 0')");
        await browser.evaluate("document.querySelector('#knowledge-drawer-body button').click()");
        await ready("document.querySelector('#knowledge-drawer-title').textContent === 'Sample 1'");
        await browser.evaluate("document.querySelector('#knowledge-drawer').close()");
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
          await ready("document.querySelector('#knowledge-drawer-body').textContent.includes('合成欄位')");
          assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-drawer-body').textContent"), /欄位狀態無資料/);
          await browser.evaluate("document.querySelector('#knowledge-drawer').close()");
        }
        await browser.evaluate(`{
          window.confirm = () => true;
          document.querySelector('#knowledge-rebuild').click();
        }`);
        await ready("document.querySelector('#knowledge-rebuild-status').textContent.includes('已重建')");
        await browser.evaluate("document.querySelector('#open-chat').click()");
        assert.equal(await browser.evaluate("document.querySelector('#chat-view').hidden"), false);
        assert.equal(await browser.evaluate("document.activeElement.id"), 'open-chat');
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
