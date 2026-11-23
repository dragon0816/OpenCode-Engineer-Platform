import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { syntheticMcpCertificate } from '../fixtures/mcp/tls.ts';
import { chromium } from './chromium.ts';
import { mappingChecks } from './gui-mapping.ts';
import { assertNativeDialogTextInThemes, assertUiTextInThemes } from './forbidden-shell-text.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const marker = process.argv.includes('--leaks') ? 'synthetic-mcp-' + randomUUID() : '';
const pidFile = join(root, 'mcp-fixture-pid');
const credentials = new Map<string, string>();
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
const activeTurn = Promise.withResolvers<void>();
const completeTurn = Promise.withResolvers<void>();
const modelRequests = new Map<string, string[]>();
const awaited = (promise: Promise<void>, reason: string) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), 10000).unref()),
]);
async function openRuntime() {
  const audit = join(root, randomUUID());
  mkdirSync(audit);
  const store = new WebStore(join(root, 'web.sqlite'));
  const definitions = store.customMcpServers();
  store.close();
  runtime = await startRuntime(audit, {
    url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-mcp-browser', isolatedJob: true,
    fetch: async (_target, init) => {
      const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
      const text = JSON.stringify(messages.at(-1)?.content);
      if (text.includes('Synthetic restart guard')) {
        activeTurn.resolve();
        await completeTurn.promise;
      }
      for (const prompt of ['Synthetic restart guard', 'Synthetic tool listing', 'Synthetic disabled listing']) {
        if (text.includes(prompt)) modelRequests.set(prompt, tools?.flatMap((tool) => tool.function?.name ?? []) ?? []);
      }
      noMarker(JSON.stringify(messages));
      return completion(model, [{ role: 'assistant', content: 'Synthetic reply' }], 'stop');
    },
  }, profile, definitions);
  restart = Promise.withResolvers<void>();
  adapter = await startAdapter(root, runtime, () => undefined, false, restart.resolve, undefined, undefined, {
    readCredentials: (names) => Object.fromEntries(names.map((name) => [name, credentials.get(name)])),
    writeCredential(name, value) {
      if (value === null) credentials.delete(name);
      else credentials.set(name, value);
    },
  });
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
const api = (path: string, data?: object) => evaluate<string>(`import('/api.js').then(async ({ request }) => {
  try { return JSON.stringify(await request(${JSON.stringify(path)}, ${data === undefined ? '{}' : JSON.stringify({ data })})); }
  catch (error) { return JSON.stringify({ status: error.status }); }
})`);
async function submit(text: string) {
  const path = '/api/projects/default/sessions';
  const session = JSON.parse(await api(path, { agent: 'inspector' }));
  const id = randomUUID();
  await api(path + '/' + session.id + '/turns', { id, text, attachments: [], workbook: false });
  return path + '/' + session.id + '/state';
}
async function apply() {
  await click('#mcp-restart');
  await awaited(restart.promise, 'Restart callback absent');
  await closeRuntime();
  await openRuntime();
  await settings();
}
async function settings() {
  await page.command('Page.navigate', { url: adapter!.pairURL() });
  await page.ready("!document.querySelector('#new-session')?.disabled && location.hash === ''");
  await click('#open-settings');
  await click('[data-section="mcp"]');
  await page.ready("document.querySelector('#mcp-servers').children.length > 0");
}
async function screenshots(state: string) {
  for (const [name, width, height] of [['wide', 1440, 900], ['narrow', 390, 844]] as const) {
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
  const mapping = mappingChecks(page, 'servers');
  await settings();
  await evaluate("window.addEventListener('error', (event) => window.mcpTestError = event.message); document.querySelector('#mcp-add').focus()");
  assert.equal(await evaluate('document.activeElement.id'), 'mcp-add');
  await press(' ', 32);
  await page.ready("document.querySelector('#mcp-editor').open || window.mcpTestError");
  assert.equal(await evaluate('window.mcpTestError ?? null'), null);
  assert.equal(await evaluate('document.activeElement.name'), 'name');
  assert.equal(await evaluate(`(() => {
    const form = document.querySelector('#mcp-form');
    const visible = selector => form.querySelector(selector)?.checkVisibility();
    return ['[name=name]', '[name=transport]', '[name=executable]', '[name=args]', '[name=cwd]',
      '#mcp-add-credential', '#mcp-projects [name=project][value=default]', '#mcp-projects [name=project][value=secondary]',
      '[name=dataScope]', '[name=enabled]', '[type=submit]', '#mcp-cancel', 'details summary'].every(visible)
      && ['startup', 'catalog', 'execution'].every(name => form.querySelector('details [name=' + name + '][type=number]'))
      && Boolean(form.querySelector('#mcp-form-status[role=status]'));
  })()`), true);
  await mapping.check('settings-mcp-access', '#mcp-editor', {
    selectors: ['[name=project][value=default]', '[name=project][value=secondary]', '[name=dataScope]', '[name=enabled]', '[type=submit]', '#mcp-cancel', '#mcp-form-status'],
  });
  await mapping.check('settings-mcp-timeouts', '#mcp-editor', { selectors: ['details [name=startup]', 'details [name=catalog]', 'details [name=execution]'] });
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
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.id'), 'mcp-add-credential');
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.value'), 'default');
  await press(' ', 32);
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.value'), 'secondary');
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.name'), 'dataScope');
  await page.command('Input.insertText', { text: '僅讀取合成測試資料。' });
  if (marker) {
    await click('#mcp-add-credential');
    assert.equal(await evaluate(`(() => {
      const row = document.querySelector('#mcp-credential-rows .mcp-credential');
      return ['[data-mcp-name]', '[data-mcp-value][type=password]', '[type=checkbox]', 'button']
        .every(selector => row.querySelector(selector)?.checkVisibility()) &&
        row.querySelector('button').textContent === '移除此欄位';
    })()`), true);
    await evaluate("document.querySelector('[data-mcp-name]').value = 'SYNTHETIC_MCP'; document.querySelector('[name=dataScope]').focus()");
  }
  if (marker) await mapping.check('settings-mcp-credentials', '#mcp-editor', {
    selectors: ['[data-mcp-name]', '[data-mcp-value][type=password]', '.mcp-credential [type=checkbox]'],
    labels: ['新增憑證欄位', '移除此欄位'],
  });
  await assertUiTextInThemes(page, '#mcp-editor');
  await evaluate("window.syntheticExecutable = document.querySelector('[name=executable]').value; document.querySelector('[name=executable]').value = 'relative.exe'");
  await click('#mcp-form button[type=submit]');
  await page.ready("document.querySelector('#mcp-form-status').textContent.includes('完整路徑')");
  await evaluate("document.querySelector('[name=executable]').value = window.syntheticExecutable");
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.tagName'), 'SUMMARY');
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.name'), 'enabled');
  await press('Tab', 9);
  assert.equal(await evaluate('document.activeElement.type'), 'submit');
  await press(' ', 32);
  await page.ready("!document.querySelector('#mcp-editor').open && !document.querySelector('#mcp-restart-bar').hidden");
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#mcp-servers .settings-actions button')].map(button => button.textContent)`),
    ['編輯', '停用', '測試連線', '移除']);
  assert.equal(await evaluate("document.querySelector('#settings-mcp #mcp-restart-bar #mcp-restart').checkVisibility()"), true);
  await mapping.check('settings-mcp-restart', '#mcp-restart-bar', { selectors: ['p', '#mcp-restart'] });
  await mapping.check('settings-mcp-list', '#settings-mcp', {
    selectors: ['#mcp-add', '.mcp-card h4', '.mcp-badges span', '.mcp-card > p:nth-of-type(2)', '.mcp-result', '#mcp-status'],
    labels: ['編輯', '停用', '測試連線', '移除'],
  });
  if (marker) {
    const id = await evaluate<string>("document.querySelector('#mcp-servers h4').id.replace('mcp-server-', '')");
    assert.match(id, /^[a-f0-9]{32}$/);
    const result = await evaluate<string>(`import('/api.js').then(async ({ request }) => JSON.stringify(await request(
      '/api/settings/mcp/custom', { data: { action: 'credential', id: ${JSON.stringify(id)}, name: 'SYNTHETIC_MCP',
        value: ${JSON.stringify(marker)} } })))`);
    noMarker(result);
    assert.deepEqual(JSON.parse(result), { configured: true });
    assert.ok(credentials.get(`OEP_MCP_${id.toUpperCase()}_SYNTHETIC_MCP`) === marker, 'Credential reached the isolated store');
  }
  let probePid: string | undefined;
  await screenshots('restart');
  await click('#mcp-servers .settings-actions button:nth-child(3)');
  await page.ready("document.querySelector('.mcp-result').textContent.includes('synthetic_catalog')", 22_000);
  await assertUiTextInThemes(page, '#settings-mcp');
  if (marker) {
    assert.ok(existsSync(pidFile), 'Credential reached the child environment');
    probePid = readFileSync(pidFile, 'utf8');
    const pid = Number(probePid);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id`).trim(), '');
    const catalog = await evaluate<string>("document.querySelector('.mcp-result').textContent");
    assert.match(catalog, /Read the synthetic catalog/);
    assert.match(catalog, /已隱藏/);
    noMarker(await evaluate<string>('document.documentElement.outerHTML'));
  }
  await screenshots('result');
  if (marker) {
    await click('.mcp-result button');
    await page.ready("document.querySelector('.mcp-result button')?.textContent === '啟用工具'");
    await click('.mcp-result button');
    await page.ready("document.querySelector('.mcp-result button')?.textContent === '停用工具'");
    await mapping.check('settings-mcp-tools', '.mcp-result', { selectors: ['li', 'li button'], labels: ['停用工具'] });
    const statePath = await submit('Synthetic restart guard');
    await awaited(activeTurn.promise, 'Synthetic restart guard failed to start');
    try {
      assert.deepEqual(JSON.parse(await api('/api/settings/mcp/restart', {})), { status: 409 });
    } finally { completeTurn.resolve(); }
    await page.ready(`import('/api.js').then(async ({ request }) =>
      (await request(${JSON.stringify(statePath)})).runs.at(-1)?.state === 'verified')`, 15000);
  }
  await apply();
  const texts = await evaluate<string>("document.querySelector('#mcp-servers').textContent");

  assert.match(texts, /已啟用/);
  assert.match(texts, /已暫停提供給助理/);
  assert.match(texts, /仍可測試連線/);
  assert.equal(await evaluate("document.querySelector('#mcp-restart-bar').hidden"), true);
  if (marker) {
    const statePath = await submit('Synthetic tool listing');
    await page.ready(`import('/api.js').then(async ({ request }) =>
      (await request(${JSON.stringify(statePath)})).runs.at(-1)?.state === 'verified')`, 15000);
    const tools = modelRequests.get('Synthetic tool listing') ?? [];
    assert.ok(!tools.some((name) => name.endsWith('_synthetic_catalog')));
    const detail = await api(statePath);
    assert.doesNotMatch(detail, /Synthetic catalog read/);
    noMarker(detail);
    assert.equal(readFileSync(pidFile, 'utf8'), probePid, 'Assistant restart must not start the paused process');
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
  if (marker) {
    await apply();
    const statePath = await submit('Synthetic disabled listing');
    await page.ready(`import('/api.js').then(async ({ request }) =>
      (await request(${JSON.stringify(statePath)})).runs.at(-1)?.state === 'verified')`, 15000);
    const tools = modelRequests.get('Synthetic disabled listing');
    assert.ok(tools && !tools.some((name) => name.endsWith('_synthetic_catalog')));
  }
  await page.command('Page.enable');
  await assertNativeDialogTextInThemes(page, '#mcp-servers', 'confirm', '移除');
  const remove = click('#mcp-servers .settings-actions button:last-child');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.command('Page.handleJavaScriptDialog', { accept: true });
  await remove;
  await page.ready("document.querySelector('#mcp-servers').textContent.includes('尚未新增')");
  if (marker) {
    const tlsRoot = join(root, 'tls-fixture');
    mkdirSync(tlsRoot);
    const stub = createServer(syntheticMcpCertificate(tlsRoot), (_request, response) => response.writeHead(200).end());
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    try {
      const port = (stub.address() as AddressInfo).port;
      await click('#mcp-add');
      await evaluate(`const form = document.querySelector('#mcp-form');
        form.elements.name.value = '合成遠端';
        form.elements.transport.value = 'remote';
        form.elements.transport.dispatchEvent(new Event('change'));
        form.elements.url.value = 'http://127.0.0.1:${port}/mcp';`);
      assert.equal(await evaluate(`document.querySelector('#mcp-remote-fields [name=url]').checkVisibility() &&
        document.querySelector('#mcp-remote-fields [name=localService]').checkVisibility() &&
        !document.querySelector('#mcp-stdio-fields [name=executable]').checkVisibility()`), true);
      await mapping.check('settings-mcp-connection', '#mcp-editor', {
        selectors: ['[name=name]', '[name=transport]', '[name=executable]', '[name=args]', '[name=cwd]', '[name=url]', '[name=localService]'],
      });
      await assertUiTextInThemes(page, '#mcp-editor');
      await click('#mcp-form button[type=submit]');
      await page.ready("document.querySelector('#mcp-form-diagnostic').textContent.includes('HTTPS')");
      await assertUiTextInThemes(page, '#mcp-editor');
      await evaluate(`document.querySelector('#mcp-form [name=url]').value = 'https://127.0.0.1:${port}/mcp'`);
      await click('#mcp-form button[type=submit]');
      await page.ready("document.querySelector('#mcp-form-status').textContent.includes('私人位址')");
      await evaluate("document.querySelector('#mcp-form [name=localService]').checked = true");
      await click('#mcp-form button[type=submit]');
      await page.ready("!document.querySelector('#mcp-editor').open");
      assert.match(await evaluate<string>("document.querySelector('.mcp-badges').textContent"), /已暫停提供給助理/);
      await click('#mcp-servers .settings-actions button:nth-child(3)');
      await page.ready("document.querySelector('.mcp-result').textContent.length > 0 && " +
        "!document.querySelector('.mcp-result').textContent.includes('正在測試')", 22000);
      assert.match(await evaluate<string>("document.querySelector('.mcp-result').textContent"), /TLS/);
    } finally { await new Promise<void>((resolve) => stub.close(() => resolve())); }
  }
  if (marker) mapping.finish();
  console.log('Chromium MCP add, catalog test, apply, persistence, edit, disable, and remove verified.');
} finally {
  completeTurn.resolve();
  try { await page.close(); } finally { await closeRuntime(); }
  if (marker) scan(root);
}
