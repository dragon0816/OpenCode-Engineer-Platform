import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { chromium } from './chromium.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const profile = join(root, 'profile');
mkdirSync(profile);
let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
let adapter: Awaited<ReturnType<typeof startAdapter>> | undefined;
let restart = Promise.withResolvers<void>();
async function openRuntime() {
  const audit = join(root, randomUUID());
  mkdirSync(audit);
  const store = new WebStore(join(root, 'web.sqlite'));
  const definitions = store.customMcpServers();
  store.close();
  runtime = await startRuntime(audit, {
    url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-mcp-browser', isolatedJob: true,
    fetch: async (_target, init) => {
      const { model } = JSON.parse(String(init?.body)) as WireRequest;
      return completion(model, [{ role: 'assistant', content: 'Synthetic reply' }], 'stop');
    },
  }, profile, definitions);
  restart = Promise.withResolvers<void>();
  adapter = await startAdapter(root, runtime, () => undefined, false, restart.resolve);
}
async function closeRuntime() {
  try { await adapter?.close(); } finally {
    adapter = undefined;
    if (runtime) {
      const closed = await runtime.stop();
      runtime = undefined;
      assert.equal(closed.orphans, 0);
    }
  }
}
const page = await chromium(join(root, 'chromium'));
const evaluate = page.evaluate;
const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const press = async (key: string, code: number) => {
  for (const type of ['keyDown', 'keyUp']) await page.command('Input.dispatchKeyEvent', { type, key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: code,
    ...(type === 'keyDown' && key === ' ' && { text: ' ' }) });
};
async function settings() {
  await page.command('Page.navigate', { url: adapter!.pairURL() });
  await page.ready("!document.querySelector('#new-session')?.disabled && location.hash === ''");
  await click('#open-settings');
  await click('[data-section="mcp"]');
  await page.ready("document.querySelector('#mcp-servers').children.length > 0");
}
async function screenshots(state: string) {
  for (const [name, width, height] of [['wide', 1280, 960], ['narrow', 390, 1000]] as const) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (name === 'narrow' && state === 'result') {
        await evaluate("document.querySelector('.mcp-result').scrollIntoView({ block: 'end' })");
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      if (process.argv.includes('--screenshots')) {
        const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join('docs/validation/gui', `slice4c-mcp-${state}-${theme}-${name}.png`), Buffer.from(data, 'base64'));
      }
    }
  }
  await page.command('Emulation.clearDeviceMetricsOverride');
  await evaluate("document.documentElement.dataset.theme = 'light'");
}
try {
  await openRuntime();
  await settings();
  await evaluate("window.addEventListener('error', (event) => window.mcpTestError = event.message); document.querySelector('#mcp-add').focus()");
  assert.equal(await evaluate('document.activeElement.id'), 'mcp-add');
  await press(' ', 32);
  await page.ready("document.querySelector('#mcp-editor').open || window.mcpTestError");
  assert.equal(await evaluate('window.mcpTestError ?? null'), null);
  assert.equal(await evaluate('document.activeElement.name'), 'name');
  await page.command('Input.insertText', { text: '合成工具目錄' });
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.name'), 'transport');
  await screenshots('add');
  await press('Tab', 9);
  await page.command('Input.insertText', { text: process.execPath });
  await press('Tab', 9);
  await page.command('Input.insertText', { text: resolve('tests/fixtures/mcp/stdio.mjs') });
  await press('Tab', 9);
  await page.command('Input.insertText', { text: root });
  await evaluate("document.querySelector('input[name=project][value=default]').checked = true");
  await evaluate("document.querySelector('[name=dataScope]').value = '僅讀取合成測試資料。'");
  await click('#mcp-form button[type=submit]');
  await page.ready("!document.querySelector('#mcp-editor').open && !document.querySelector('#mcp-restart-bar').hidden");
  await screenshots('restart');
  await click('#mcp-servers .settings-actions button:nth-child(3)');
  await page.ready("document.querySelector('.mcp-result').textContent.includes('synthetic_catalog')", 22_000);
  await screenshots('result');
  await click('#mcp-restart');
  await Promise.race([restart.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Restart callback absent')), 5000).unref())]);
  await closeRuntime();
  await openRuntime();
  await settings();
  const texts = await evaluate<string>("document.querySelector('#mcp-servers').textContent");

  assert.match(texts, /已啟用/);
  assert.equal(await evaluate("document.querySelector('#mcp-restart-bar').hidden"), true);
  await screenshots('list');
  await click('#mcp-servers .settings-actions button:first-child');
  await evaluate("document.querySelector('#mcp-form [name=name]').value = '合成工具目錄（已更新）'");
  await click('#mcp-form button[type=submit]');
  await page.ready("document.querySelector('#mcp-servers h4')?.textContent.includes('已更新')");
  await click('#mcp-servers .settings-actions button:nth-child(2)');
  await page.ready("document.querySelector('.mcp-badges').textContent.includes('已停用')");
  await page.command('Page.enable');
  const remove = click('#mcp-servers .settings-actions button:last-child');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.command('Page.handleJavaScriptDialog', { accept: true });
  await remove;
  await page.ready("document.querySelector('#mcp-servers').textContent.includes('尚未新增')");
  console.log('Chromium MCP add, catalog test, apply, persistence, edit, disable, and remove verified.');
} finally {
  try { await page.close(); } finally { await closeRuntime(); }
}
