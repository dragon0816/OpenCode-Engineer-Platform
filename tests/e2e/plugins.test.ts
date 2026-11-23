import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { verifyPackage } from '../../apps/adapter/src/plugins/package.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { KnowledgeStore } from '../../packages/knowledge/src/store.ts';
import { sampleID, samplePage, samplePlugin } from '../fixtures/plugins/package.ts';
import { chromium } from './chromium.ts';
import { dataDirectory } from './test-data.ts';

test('Chromium installs an unsigned plugin with consent and mounts the bilingual page with keyboard navigation', async () => {
  const root = dataDirectory();
  const web = join(root, 'web');
  mkdirSync(web);
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-plugin', aliases: ['synthetic-plugin'], builtInAliases: ['synthetic-plugin'],
    aliasHealth: () => [{ alias: 'synthetic-plugin', healthy: true }], redact: (value: string) => value,
    endpoint: { request: async () => new Response(null, { status: 503 }) },
  } as unknown as Runtime;
  const app = await startAdapter(web, runtime, () => {}, false, undefined, undefined, undefined, undefined, { dataRoot: root, version: '0.8.0' });
  let page: Awaited<ReturnType<typeof chromium>> | undefined;
  try {
    page = await chromium(join(root, 'chromium'));
    await page.command('Page.navigate', { url: app.pairURL() });
    await page.ready('document.querySelector("#open-capabilities")?.disabled === false');
    await page.evaluate('document.querySelector("#open-capabilities").click()');
    await page.ready('!document.querySelector("#capabilities-view").hidden');
    await page.evaluate('document.querySelector("#install-plugin").focus()');
    const file = join(root, 'synthetic.oepplugin');
    const sample = samplePlugin({ range: '^2.0.0', body: '<img src=x onerror=alert(1)> Synthetic plugin content' });
    writeFileSync(file, sample);
    const { root: documentRoot } = await page.command<{ root: { nodeId: number } }>('DOM.getDocument');
    const { nodeId } = await page.command<{ nodeId: number }>('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#plugin-file' });
    await page.command('DOM.setFileInputFiles', { nodeId, files: [file] });
    await page.ready('document.querySelector("#plugin-dialog").open');
    assert.match(await page.evaluate<string>('document.querySelector("#plugin-dialog").innerText'), /申請權限[\s\S]*相容範圍/u);
    assert.equal(await page.evaluate('document.querySelector("#plugin-dialog button:last-child").disabled'), true);
    await page.evaluate('document.querySelector("#plugin-dialog input").click()');
    assert.equal(await page.evaluate('document.querySelector("#plugin-dialog button:last-child").disabled'), true);
    await page.evaluate(`document.querySelectorAll('#plugin-dialog input')[1].click(); document.querySelector('#plugin-dialog button:last-child').click()`);
    await page.ready('!document.querySelector("#plugin-dialog").open && !!document.querySelector("[data-plugin-page]") && document.activeElement.id === "install-plugin"', 25_000);
    const entry = `#rail-functions [data-plugin-page="${samplePage}"]`;
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(entry)}).textContent`), '合成建置工具');
    const pressSpace = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await page!.command('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
          ...(type === 'keyDown' ? { text: ' ' } : {}) });
      }
    };
    await page.evaluate(`document.querySelector(${JSON.stringify(entry)}).focus()`);
    assert.equal(await page.evaluate('document.activeElement.dataset.pluginPage'), samplePage);
    await pressSpace();
    await page.ready('document.querySelector("#plugin-page-content").textContent === "合成外掛內容"').catch(async (error) => {
      const state = await page!.evaluate(`({ focus: document.activeElement.outerHTML.slice(0, 180), railHidden: document.querySelector('#session-sidebar').hidden,
        pageHidden: document.querySelector('#plugin-page-view').hidden, content: document.querySelector('#plugin-page-content').textContent })`);
      throw new Error('Plugin page did not mount: ' + JSON.stringify(state), { cause: error });
    });
    assert.equal(await page.evaluate('document.activeElement.id'), 'plugin-page-title');
    assert.equal(await page.evaluate('document.querySelector("#work-area #plugin-page-title").textContent'), '合成建置工具');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(entry)}).getAttribute('aria-current')`), 'page');
    const api = `/api/plugins/${sampleID}/pages/${samplePage}/${verifyPackage(sample).digest}`;
    const headers = await page.evaluate<string[]>(`fetch(${JSON.stringify(api)}).then(r => [r.headers.get('content-type'), r.headers.get('content-security-policy')])`);
    assert.match(headers[0], /^application\/json/);
    assert.match(headers[1], /default-src 'none'.*frame-ancestors 'none'/);

    await page.evaluate(`const picker = document.querySelector('#menu-locale'); picker.value = 'en'; picker.dispatchEvent(new Event('change'))`);
    await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await page.ready('innerWidth === 390 && document.querySelector("#session-sidebar").hidden');
    assert.match(await page.evaluate<string>('document.querySelector("#plugin-page-content").textContent'), /^<img src=x onerror=alert\(1\)> Synthetic plugin content$/);
    assert.equal(await page.evaluate('document.querySelector("#plugin-page-content img") === null'), true);
    await page.evaluate('document.querySelector("#toggle-sidebar").focus()');
    await pressSpace();
    await page.ready('!document.querySelector("#session-sidebar").hidden');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(entry)}).textContent`), 'Synthetic builder');
    await page.evaluate(`document.querySelector(${JSON.stringify(entry)}).focus()`);
    await pressSpace();
    await page.ready('document.querySelector("#session-sidebar").hidden && document.activeElement.id === "plugin-page-title"');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);

    const worker = await page.evaluate<number>(`fetch('/api/plugins/${sampleID}/workers/oep.synthetic.worker').then(r => r.status)`);
    assert.equal(worker, 404);
    {
      using db = new DatabaseSync(join(web, 'web.sqlite'), { readOnly: true });
      const row = db.prepare('SELECT artifact FROM plugin_packages WHERE plugin_id = ?').get(sampleID);
      assert.ok(row);
      writeFileSync(join(root, 'plugins', 'packages', sampleID, '1.0.0', row.artifact + '.oepplugin'), samplePlugin({ body: 'Trusted recovery' }));
    }
    await page.evaluate(`fetch(${JSON.stringify(api)}).then(r => r.status)`);
    await page.evaluate(`document.querySelector('#toggle-sidebar').click(); document.querySelector('#open-capabilities').click()`);
    await page.ready(`document.querySelector('#plugins-list').textContent.includes('Disabled because the installed package changed')`);
    await page.evaluate(`[...document.querySelectorAll('#plugins-list button')].find(button => button.textContent === 'Reinstall / trust current version').click()`);
    await page.ready(`document.querySelector('#plugins-status').textContent === 'Plugin changes saved.' && !!document.querySelector('[data-plugin-page]')`);
  } finally {
    await page?.close();
    await app.close();
  }
});

test('Chromium streams a synthetic plugin build and opens its panel and owner review', { timeout: 120_000 }, async () => {
  const root = dataDirectory();
  const web = join(root, 'web');
  mkdirSync(web);
  const reviewStore = new KnowledgeStore(join(root, 'knowledge.sqlite'));
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-plugin', aliases: ['synthetic-plugin'], builtInAliases: ['synthetic-plugin'],
    aliasHealth: () => [], redact: (value: string) => value, knowledge: { reviewStore, overview: () => reviewStore.overview() },
    endpoint: { request: async () => new Response(null, { status: 503 }) },
  } as unknown as Runtime;
  const app = await startAdapter(web, runtime, () => {}, false, undefined, undefined, undefined, undefined,
    { dataRoot: root, version: '0.8.0' });
  let page: Awaited<ReturnType<typeof chromium>> | undefined;
  try {
    const archive = join(root, 'runtime.oepplugin');
    const source = join(root, 'source.txt');
    writeFileSync(archive, samplePlugin({ runtime: true }));
    writeFileSync(source, 'The synthetic amplifier bandwidth is 32 MHz.');
    page = await chromium(join(root, 'chromium'));
    await page.command('Page.navigate', { url: app.pairURL() });
    await page.ready('document.querySelector("#open-capabilities")?.disabled === false');
    await page.evaluate('document.querySelector("#open-capabilities").click()');
    await page.ready('!document.querySelector("#capabilities-view").hidden');
    const setFile = async (selector: string, file: string) => {
      const { root } = await page!.command<{ root: { nodeId: number } }>('DOM.getDocument');
      const { nodeId } = await page!.command<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector });
      assert.ok(nodeId);
      await page!.command('DOM.setFileInputFiles', { nodeId, files: [file] });
    };
    await setFile('#plugin-file', archive);
    await page.ready('document.querySelector("#plugin-dialog").open');
    await page.evaluate('document.querySelector("#plugin-dialog input").click(); document.querySelector("#plugin-dialog button:last-child").click()');
    await page.ready('!document.querySelector("#plugin-dialog").open && !!document.querySelector("[data-plugin-page]")');
    await page.evaluate('document.querySelector("[data-plugin-page]").click()');
    await page.ready('document.querySelector("#plugin-page-actions").textContent.includes("建置合成知識庫")');
    await page.evaluate('[...document.querySelectorAll("#plugin-page-actions button")].find(b => b.textContent === "開啟詳細資料面板").click()');
    await page.ready('document.querySelector("#file-preview").textContent.includes("合成擷取詳細資料")');
    await page.evaluate('const picker = document.querySelector("#menu-locale"); picker.value = "en"; picker.dispatchEvent(new Event("change"))');
    await page.ready('document.querySelector("#plugin-page-actions").textContent.includes("Build synthetic knowledge") && document.querySelector("#file-preview").textContent.includes("Synthetic extraction details")');
    await setFile('#plugin-page-actions input[type=file]', source);
    await page.evaluate(`(() => {
      const actions = document.querySelector('#plugin-page-actions');
      const track = actions.querySelector('progress');
      window.pluginProgress = [];
      new MutationObserver(() => window.pluginProgress.push(track.value)).observe(track, { attributes: true, attributeFilter: ['value'] });
      actions.querySelector('input:not([type=file])').value = 'Chromium synthetic build';
      [...actions.querySelectorAll('button')].find(b => b.textContent === 'Build synthetic knowledge').click();
    })()`);
    await page.ready('document.querySelector("#plugin-page-actions [role=status]").textContent === "Worker completed."', 45_000);
    const values = await page.evaluate<number[]>('window.pluginProgress');
    assert.ok(values.includes(100));
    assert.ok(values.some((value) => value > 0 && value < 100));
    await page.evaluate('[...document.querySelectorAll("#plugin-page-actions button")].find(b => b.textContent === "Open owner review").click()');
    await page.ready('!document.querySelector("#review-view").hidden && document.querySelector("#review-bi-pending").textContent.includes("Chromium synthetic build")');
    assert.equal(reviewStore.reviews()[0].status, 'pending');
    assert.equal(reviewStore.overview().length, 0);
  } finally {
    await page?.close();
    await app.close();
    reviewStore.close();
  }
});
