import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { jsonInput, listen, send, until } from '../../scripts/phase0/probe-http.ts';
import { chromium } from './chromium.ts';
import { assertWorkbenchFits, selectLocale } from './gui-locales.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

export async function verifyGatewayModelsInBrowser(root: string, capture: boolean) {
  const profile = join(root, 'profile');
  mkdirSync(profile, { recursive: true });
  const [a, b, c, d] = ['synthetic-model-a', 'synthetic-model-b', 'synthetic-model-c', 'synthetic-model-d'];
  const key = randomUUID();
  let ids = [a, b, c];
  let failDiscovery = false;
  let discoveries = 0;
  const pinged: string[] = [];
  const routed = new Map<string, string>();
  const busyTurn = 'Synthetic restart busy turn';
  const fallbackTurn = 'Synthetic fallback turn';
  const releaseBusy = Promise.withResolvers<void>();
  const gateway = await listen(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.method === 'GET' && request.url === '/v1/models') {
      discoveries++;
      if (failDiscovery) send(response, 503, { detail: key });
      else send(response, 200, { object: 'list', data: ids.map((id) => ({ object: 'model', id })) });
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    const { model, messages, stream } = await jsonInput<WireRequest & { stream: boolean }>(request);
    if (!stream) {
      pinged.push(model);
      send(response, 200, { choices: [{ message: { role: 'assistant', content: 'OEP-READY' }, finish_reason: 'stop' }] });
      return;
    }
    const text = JSON.stringify(messages.findLast((message) => message.role === 'user')?.content);
    for (const prompt of [busyTurn, fallbackTurn]) {
      if (!text.includes(prompt)) continue;
      routed.set(prompt, model);
      if (prompt === busyTurn) await releaseBusy.promise;
    }
    const body = await completion(model, [{ role: 'assistant', content: 'Synthetic model reply' }], 'stop').text();
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body);
  });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let web: Awaited<ReturnType<typeof startAdapter>> | undefined;
  let page: Awaited<ReturnType<typeof chromium>> | undefined;
  let restart = Promise.withResolvers<void>();
  async function closeRuntime() {
    try { await web?.close(); }
    finally {
      web = undefined;
      if (runtime) {
        const result = await runtime.stop();
        runtime = undefined;
        assert.deepEqual({ supervisorExit: result.supervisorExit, childExit: result.childExit, orphans: result.orphans },
          { supervisorExit: 0, childExit: 0, orphans: 0 });
      }
    }
  }
  async function openRuntime() {
    restart = Promise.withResolvers<void>();
    runtime = await startRuntime(mkdtempSync(join(root, 'launch-')),
      { url: gateway.url, key, alias: a, aliases: [a, b], isolatedJob: true }, profile);
    web = await startAdapter(root, runtime, () => undefined, false, restart.resolve);
    const url = web.pairURL();
    await page!.command('Page.navigate', { url });
    await page!.ready(`location.origin === ${JSON.stringify(new URL(url).origin)} &&
      document.querySelector('#connection')?.textContent === '已連線' && document.querySelector('#refresh-models')?.disabled === false`);
  }
  try {
    const browser = page = await chromium(join(root, 'chromium'));
    const { evaluate, ready, command } = browser;
    const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const choice = (id: string) => `#model-health input[value="${id}"]`;
    const settings = async () => {
      await click('#open-settings');
      await click('#settings-nav [data-section="model"]');
      await ready("!document.querySelector('#settings-model').hidden");
    };
    const values = (selector: string) => evaluate<string[]>(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].map(element => element.value)`);
    const status = (match: string) => ready(`document.querySelector('#model-settings-status').textContent.includes(${JSON.stringify(match)})`);
    const turn = (text: string) => evaluate(`{
      document.querySelector('#prompt').value = ${JSON.stringify(text)};
      document.querySelector('#composer').requestSubmit();
    }`);
    const sessionAlias = (session: string) => evaluate<string>(`fetch('/api/sessions/' + ${JSON.stringify(session)} + '/state')
      .then(response => response.json()).then(value => value.session.alias)`);
    await openRuntime();
    assert.equal(discoveries, 1);
    assert.deepEqual(await values('#model-health input'), [a, b, c]);
    assert.deepEqual(await values('#model-health input:checked'), [a, b]);
    await click('#new-session');
    await ready("!document.querySelector('#session-alias').disabled");
    const oldSession = await evaluate<string>("localStorage.getItem('oep.activeSession.default')");
    assert.equal(await sessionAlias(oldSession), a);
    await evaluate(`{
      const menu = document.querySelector('#session-alias');
      menu.value = ${JSON.stringify(b)};
      menu.dispatchEvent(new Event('change'));
    }`);
    await ready("document.querySelector('#session-model-status').textContent === '模型已切換'");
    await settings();
    ids = [a, b, c, d];
    await click('#refresh-models');
    await status('已重新整理模型清單');
    assert.equal(discoveries, 2);
    failDiscovery = true;
    await click('#refresh-models');
    await status('已保留目前的清單');
    assert.deepEqual(await values('#model-health input'), ids);
    assert.equal(discoveries, 3);
    await evaluate(`document.querySelector(${JSON.stringify(choice(c))}).closest('li').querySelector('button').click()`);
    await ready(`document.querySelector(${JSON.stringify(choice(c))}).closest('li').querySelector('small').textContent === '可用'`);
    assert.equal(pinged.at(-1), c);

    const unsaved = '有尚未儲存的變更';
    const deferred = '目前有對話或工作進行中，完成後會自動套用';
    const confirmText = '設定尚未儲存。要捨棄變更嗎？';
    const selectDefault = (id: string) => evaluate(`{
      const select = document.querySelector('#default-alias');
      select.value = ${JSON.stringify(id)};
      select.dispatchEvent(new Event('change'));
    }`);
    const draftStatus = (dirty: boolean) => ready(`document.querySelector('#model-unsaved').textContent === ${JSON.stringify(dirty ? unsaved : '')} &&
      document.querySelector('#save-model').disabled === ${!dirty}`);
    await draftStatus(false);
    await selectDefault(b);
    await draftStatus(true);
    await selectDefault(a);
    await draftStatus(false);
    await click(choice(c));
    await draftStatus(true);
    assert.ok(await evaluate(`(() => {
      const save = document.querySelector('#save-model');
      const actions = save.parentElement;
      return actions.previousElementSibling.matches('.model-choices') && getComputedStyle(actions).position === 'sticky' &&
        getComputedStyle(save).backgroundColor !== getComputedStyle(document.querySelector('#refresh-models')).backgroundColor;
    })()`));
    await evaluate(`{
      window.__modelConfirm = [];
      window.confirm = (text) => { window.__modelConfirm.push(text); return window.__discardModel === true; };
    }`);
    await click('#settings-nav [data-section="assistant"]');
    await ready("!document.querySelector('#settings-model').hidden");
    await click('#open-chat');
    await ready("!document.querySelector('#settings-view').hidden");
    await draftStatus(true);
    assert.deepEqual(await evaluate('window.__modelConfirm'), [confirmText, confirmText]);
    await evaluate('window.__discardModel = true');
    await click('#settings-nav [data-section="assistant"]');
    await ready("!document.querySelector('#settings-assistant').hidden");
    await settings();
    await draftStatus(false);
    assert.deepEqual(await values('#model-health input:checked'), [a, b]);
    await click(choice(c));
    await click('#open-chat');
    await ready("document.querySelector('#settings-view').hidden && !document.querySelector('#send').disabled");
    assert.deepEqual(await evaluate('window.__modelConfirm'), [confirmText, confirmText, confirmText, confirmText]);

    await turn(busyTurn);
    await until(async () => routed.get(busyTurn));
    assert.equal(routed.get(busyTurn), b);
    await settings();
    await evaluate(`{
      const fetchRequest = window.fetch;
      window.__modelRestartRequests = 0;
      window.fetch = (path, options) => {
        if (path === '/api/settings/model/restart') window.__modelRestartRequests++;
        return fetchRequest(path, options);
      };
    }`);
    await click(choice(b));
    await click(choice(c));
    await selectDefault(c);
    await click('#save-model');
    await status(deferred);
    await ready("!document.querySelector('#model-restart-bar').hidden && !document.querySelector('#model-restart').disabled");
    await draftStatus(false);
    assert.deepEqual(await values('#session-alias option'), [a, b]);
    await ready('window.__modelRestartRequests >= 2');
    await click('#settings-nav [data-section="assistant"]');
    await ready("!document.querySelector('#settings-assistant').hidden");
    const requestsBeforeLeaving = await evaluate('window.__modelRestartRequests');
    await delay(2_300);
    assert.equal(await evaluate('window.__modelRestartRequests'), requestsBeforeLeaving);

    await evaluate('window.__beforeReload = true');
    await command('Page.reload');
    await ready("window.__beforeReload !== true && document.querySelector('#connection')?.textContent === '已連線' && !document.querySelector('#refresh-models')?.disabled");
    await settings();
    assert.deepEqual(await values('#model-health input:checked'), [a, c]);
    assert.equal(await evaluate("document.querySelector('#default-alias').value"), c);
    assert.equal(await evaluate("document.querySelector('#model-restart-bar').hidden"), false);
    await click('#model-restart');
    await status(deferred);
    releaseBusy.resolve();
    await ready("document.querySelector('#messages').textContent.includes('Synthetic model reply') && !document.querySelector('#send').disabled");
    await status('正在重新啟動');
    await restart.promise;
    await closeRuntime();
    await openRuntime();
    await ready("document.querySelector('#session-model-status').textContent === '已套用'");
    assert.equal(discoveries, 4);
    assert.deepEqual(runtime!.aliases, [a, c]);
    assert.deepEqual([...runtime!.knowledge!.benchmarks.keys()], [a, c]);
    await ready("!document.querySelector('#send').disabled");
    assert.deepEqual(await values('#session-alias option'), [a, c]);
    assert.match(await evaluate<string>("document.querySelector('#session-alias option:checked').textContent"), /設定預設 · synthetic-model-c/);
    assert.match(await evaluate<string>("document.querySelector('#session-model-help').textContent"), /下一則訊息/);
    assert.match(await evaluate<string>("document.querySelector('#session-model-fallback').textContent"), /下一則訊息將使用預設模型 synthetic-model-c/);
    assert.equal(await sessionAlias(oldSession), b);
    const rejected = await evaluate<{ status: number; code: string }>(`(async () => {
      const { csrf } = await fetch('/api/bootstrap').then(response => response.json());
      const response = await fetch('/api/sessions/' + ${JSON.stringify(oldSession)} + '/model', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OEP-CSRF': csrf },
        body: JSON.stringify({ alias: ${JSON.stringify(b)} }),
      });
      return { status: response.status, code: (await response.json()).errorDetail.code };
    })()`);
    assert.deepEqual(rejected, { status: 400, code: 'unapproved-model' });
    await turn(fallbackTurn);
    await ready("document.querySelector('#session-model-fallback').textContent.includes('已改用預設模型 synthetic-model-c')");
    await ready("[...document.querySelectorAll('#messages .assistant')].length === 2 && !document.querySelector('#send').disabled");
    assert.equal(routed.get(fallbackTurn), c);
    assert.equal(await sessionAlias(oldSession), c);
    await click('#new-session');
    await ready(`localStorage.getItem('oep.activeSession.default') !== ${JSON.stringify(oldSession)} && !document.querySelector('#send').disabled`);
    assert.equal(await sessionAlias(await evaluate<string>("localStorage.getItem('oep.activeSession.default')")), c);
    await settings();
    assert.equal(await evaluate("document.querySelector('#model-restart-bar').hidden"), true);
    await status('已套用');
    assert.deepEqual(await values('#model-health input:checked'), [a, c]);
    const visible = await evaluate<string>("fetch('/api/settings/model').then(response => response.text()).then(data => data + document.documentElement.outerHTML)");
    assert.ok(!visible.includes(key) && !visible.includes(gateway.url));
    await click(choice(d));
    await draftStatus(true);
    assert.equal(await evaluate("document.querySelector('#model-settings-status').textContent"), '');
    for (const [width, height, layout] of [[1440, 900, 'wide'], [390, 844, 'narrow']] as const) {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await ready(`innerWidth === ${width}`);
      for (const theme of ['light', 'dark']) {
        await evaluate(`{
          document.querySelector('#appearance-status').textContent = '';
          document.querySelector('#theme').value = ${JSON.stringify(theme)};
          document.querySelector('#appearance-settings').requestSubmit();
        }`);
        await ready("document.querySelector('#appearance-status').textContent === '已儲存'");
        await assertWorkbenchFits(browser, `model settings ${theme} ${layout}`);
        if (!capture) continue;
        for (const locale of ['zh-TW', 'en'] as const) {
          await selectLocale(browser, locale);
          const image = await command<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          const suffix = locale === 'en' ? '-en' : '';
          writeFileSync(join('docs', 'validation', 'gui', `settings-model-${theme}-${layout}${suffix}.png`), Buffer.from(image.data, 'base64'));
        }
        await selectLocale(browser, 'zh-TW');
      }
    }
    await click(choice(d));
    await click(choice(a));
    await click('#save-model');
    await status('正在重新啟動');
    await restart.promise;
    await closeRuntime();
    await openRuntime();
    await ready("document.querySelector('#session-model-status').textContent === '已套用' && !document.querySelector('#session-alias').disabled");
    assert.deepEqual(await values('#session-alias option'), [c]);
    await ready("document.querySelector('#choose-more-models').checkVisibility() && document.querySelector('#choose-more-models').textContent === '到設定選擇更多模型'");
    await click('#choose-more-models');
    await ready("!document.querySelector('#settings-view').hidden && !document.querySelector('#settings-model').hidden");
    assert.deepEqual(await values('#model-health input:checked'), [c]);
    console.log('Chromium verified model discovery, unsaved edits and confirmation, automatic and deferred apply, reload, composer hint, default and session fallback.');
  } finally {
    releaseBusy.resolve();
    try { await page?.close(); }
    finally {
      try { await closeRuntime(); }
      finally { await gateway.close(); }
    }
  }
}
