import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { chromium } from './chromium.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const marker = process.argv.includes('--leaks') ? 'synthetic-mcp-' + randomUUID() : '';
const pidFile = join(root, 'mcp-fixture-pid');
let credentialReference: string | undefined;
const powershell = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const noMarker = (value: string | Buffer) => {
  if (marker && value.includes(marker)) assert.fail('Synthetic credential reached an unexpected output');
};
function scan(folder: string) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'chromium' || entry.isSymbolicLink()) continue;
    const file = join(folder, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.isFile()) noMarker(readFileSync(file));
  }
}
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
  const args = [resolve('tests/fixtures/mcp/stdio.mjs')];
  if (marker) args.push(createHash('sha256').update(marker).digest('hex'), pidFile);
  await page.command('Input.insertText', { text: args.join('\n') });
  await press('Tab', 9);
  await page.command('Input.insertText', { text: root });
  await evaluate("document.querySelector('input[name=project][value=default]').checked = true");
  await evaluate("document.querySelector('[name=dataScope]').value = '僅讀取合成測試資料。'");
  if (marker) {
    await click('#mcp-add-credential');
    await evaluate("document.querySelector('[data-mcp-name]').value = 'SYNTHETIC_MCP'");
  }
  await click('#mcp-form button[type=submit]');
  await page.ready("!document.querySelector('#mcp-editor').open && !document.querySelector('#mcp-restart-bar').hidden");
  if (marker) {
    const id = await evaluate<string>("document.querySelector('#mcp-servers h4').id.replace('mcp-server-', '')");
    assert.match(id, /^[a-f0-9]{32}$/);
    credentialReference = `OEP_MCP_${id.toUpperCase()}_SYNTHETIC_MCP`;
    const result = await evaluate<string>(`import('/api.js').then(async ({ request }) => JSON.stringify(await request(
      '/api/settings/mcp/custom', { data: { action: 'credential', id: ${JSON.stringify(id)}, name: 'SYNTHETIC_MCP',
        value: ${JSON.stringify(marker)} } })))`);
    noMarker(result);
    assert.deepEqual(JSON.parse(result), { configured: true });
  }
  let probePid: string | undefined;
  await screenshots('restart');
  await click('#mcp-servers .settings-actions button:nth-child(3)');
  await page.ready("document.querySelector('.mcp-result').textContent.includes('synthetic_catalog')", 22_000);
  if (marker) {
    assert.ok(existsSync(pidFile), 'Credential reached the child environment');
    probePid = readFileSync(pidFile, 'utf8');
    const pid = Number(probePid);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`).trim(), '');
    noMarker(await evaluate<string>('document.documentElement.outerHTML'));
  }
  await screenshots('result');
  await click('#mcp-restart');
  await Promise.race([restart.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Restart callback absent')), 5000).unref())]);
  await closeRuntime();
  await openRuntime();
  await settings();
  const texts = await evaluate<string>("document.querySelector('#mcp-servers').textContent");

  assert.match(texts, /已啟用/);
  assert.equal(await evaluate("document.querySelector('#mcp-restart-bar').hidden"), true);
  if (marker) {
    await evaluate(`import('/api.js').then(async ({ request }) => {
      const session = await request('/api/projects/default/sessions', { data: { agent: 'inspector' } });
      return request('/api/projects/default/sessions/' + session.id + '/turns', { data: {
        id: crypto.randomUUID(), text: 'Synthetic tool listing', attachments: [], workbook: false,
      } });
    })`);
    const pidBefore = probePid;
    const deadline = Date.now() + 10_000;
    while (readFileSync(pidFile, 'utf8') === pidBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.notEqual(String(pid), pidBefore);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const command = powershell(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`);
    assert.match(command, /stdio\.mjs/i);
    noMarker(command);
    const snapshot = await evaluate<string>("import('/api.js').then(async ({ request }) => JSON.stringify(await request('/api/settings/mcp/custom')))");
    assert.match(snapshot, /"configured":true/);
    noMarker(snapshot);
    noMarker(await evaluate<string>('document.documentElement.outerHTML'));
  }
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
  try {
    try { await page.close(); } finally { await closeRuntime(); }
    if (marker) scan(root);
  } finally {
    if (credentialReference) powershell(`[Environment]::SetEnvironmentVariable('${credentialReference}',$null,'User')`);
  }
}
