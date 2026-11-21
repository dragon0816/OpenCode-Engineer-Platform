import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
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
    const web = await startAdapter(root, runtime, () => undefined);
    try {
      const api = await webAPI(web.pairURL());
      const anonymous = await fetch(api.origin + '/api/knowledge/vaults');
      assert.equal(anonymous.status, 401);
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
      try {
        await browser.command('Page.navigate', { url: web.pairURL() });
        await browser.ready("!document.querySelector('#open-knowledge')?.disabled");
        await browser.evaluate("document.querySelector('#open-knowledge').click()");
        await browser.ready("document.querySelector('#knowledge-status').textContent.includes('沒有已發布')");
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
        await browser.evaluate(`
          document.querySelector('#knowledge-repository').open = true;
          document.querySelector('#knowledge-folder').value = ${JSON.stringify(repository)};
          document.querySelector('#knowledge-check-folder').click();
        `);
        await browser.ready("document.querySelector('#knowledge-repository-status').textContent.includes('已解析發布標籤')");
        await browser.evaluate(`
          document.querySelector('#knowledge-model-consent').checked = true;
          document.querySelector('#knowledge-import-folder').click();
        `);
        await browser.ready("!document.querySelector('#knowledge-ask')?.disabled");
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-repository-status').textContent"), /tag-a/);
        assert.match(await browser.evaluate<string>("document.querySelector('#vault-details').textContent"), /tag-a@/);
        assert.equal((await (await api.get('/api/knowledge/vaults')).json()).vaults[0]?.id, vault);
        context.diagnostic('Chromium checked and imported the repository, and the authenticated API exposed its active generation');
        await browser.evaluate(`
          document.querySelector('#knowledge-question').value = ${JSON.stringify(question)};
          document.querySelector('#knowledge-ask').click();
        `);
        await browser.ready("document.querySelector('#knowledge-answer')?.textContent.includes('±0.8 dB')");
        assert.match(await browser.evaluate<string>("document.querySelector('#knowledge-answer details summary').textContent"), /合成量測手冊#row=1/);
        await browser.evaluate(`
          document.querySelector('#knowledge-question').value = 'SYN-48B synthetic rejected question';
          document.querySelector('#knowledge-ask').click();
        `);
        await browser.ready("document.querySelector('#knowledge-status').textContent.includes('模型服務拒絕處理這個問題')");
        assert.equal(await browser.evaluate("document.querySelector('#knowledge-status').textContent"),
          '模型服務拒絕處理這個問題，系統未再次傳送證據。請換個問法再試。');
        assert.equal(rejectedCalls, 1);
        await browser.evaluate(`
          const reviewPanel = document.querySelector('#wiki-review');
          reviewPanel.open = true;
          const [reviewVault, reviewVersion] = reviewPanel.querySelectorAll('input');
          reviewVault.value = 'synthetic-wiki';
          reviewVersion.value = '1';
          reviewPanel.querySelector('button').click();
        `);
        await browser.ready("document.querySelector('#wiki-review textarea').value.includes('synthetic-wiki')");
        const clickReview = (label: string) => browser.evaluate(
          `[...document.querySelectorAll('#wiki-review button')].find(element => element.textContent === ${JSON.stringify(label)}).click()`);
        await clickReview('送交審核');
        await browser.ready("document.querySelector('#wiki-review').textContent.includes('pending')");
        const reviewList = await (await api.get(reviewsPath)).json();
        const id = reviewList.reviews[0].id;
        assert.equal((await api.post(reviewsPath, { action: 'publish', id })).status, 422);
        await clickReview('核准');
        await browser.ready("document.querySelector('#wiki-review').textContent.includes('approved')");
        await clickReview('發布');
        await browser.ready("document.querySelector('#wiki-review').textContent.includes('回復前一版本')");
        assert.equal((await (await api.get(reviewsPath)).json()).intents.length, 1);
        await clickReview('回復前一版本');
        await until(async () => !(await (await api.get('/api/knowledge/vaults')).json()).vaults
          .some(({ id }: { id: string }) => id === 'synthetic-wiki'), 5000);
        await browser.evaluate("document.querySelector('#open-chat').click()");
        assert.equal(await browser.evaluate("document.querySelector('#chat-view').hidden"), false);
        assert.equal(await browser.evaluate("document.activeElement.id"), 'open-chat');
      } finally { await browser.close(); }
      const noEvidence = await api.post('/api/knowledge/ask', { vault, question: 'SYN-404' });
      assert.equal((await noEvidence.json()).reason, 'no-evidence');
      const forged = await api.post('/api/knowledge/ask', { vault, question: 'Does SYN-48B have the wrong limit?' });
      assert.equal((await forged.json()).reason, 'invalid-citation');
      assert.equal(knowledgeCalls, 2);
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
      assert.equal(knowledgeCalls, 4);
      assert.equal(toolResults, 2);
      context.diagnostic('Chromium rendered a reproducible citation and OpenCode MCP returned both verified and rejected results');
    } finally { await web.close(); }
  } finally {
    const stopped = await runtime.stop();
    assert.equal(stopped.orphans, 0);
    assert.equal(stopped.supervisorExit, 0);
  }
});
