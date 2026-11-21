import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { convertWorkbook } from '../../apps/adapter/src/runs/attachments.ts';
import { gatewayAliases } from '../../apps/adapter/src/opencode/gateway.ts';
import { call } from '../../apps/adapter/src/opencode/client.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { until } from '../../scripts/phase0/probe-http.ts';
import { chromium } from './chromium.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const real = process.argv.includes('--real');
const root = join(dataDirectory(), 'OEP 瀏覽器驗收');
mkdirSync(root);
const audit = mkdtempSync(join(root, 'launch-'));
const profile = join(root, 'profile');
const downloads = join(audit, 'downloads');
mkdirSync(profile);
mkdirSync(downloads);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const asset = (name: string) => resolve('tests/fixtures/attachments', name);
const cases = [
  { name: 'marker.png', agent: 'inspector', expected: 'ORBIT-7349',
    prompt: 'Read the exact identifier printed in the attached synthetic screenshot. Reply with only the identifier.' },
  { name: 'marker.pdf', agent: 'inspector', expected: 'PRINT-2746',
    prompt: 'Read the exact identifier printed in the attached synthetic PDF. Reply with only the identifier.' },
  { name: 'table.xlsx', agent: 'workbook', expected: 'SYN-48B',
    prompt: 'Copy the two tables in the attached synthetic workbook with their exact sheet names, cell values and types. The first row of each sheet is a table header. In the final reply identify the first Item from the first table.' },
] as const;
const sheets = [
  { name: '量測', rows: [['Item', 'Limit', 'Enabled'], ['SYN-48B', 12.5, true], ['SYN-61A', 0, false]] },
  { name: 'Notes', rows: [['Code', 'Comment'], ['R1', '合成資料'], ['R2', 'a,b']] },
];
let slowStarted = false;
const pinged: string[] = [];
const aliases = ['synthetic-browser', gatewayAliases[1]] as const;
const syntheticKey = randomUUID();
const syntheticURL = 'http://example.invalid/v1';
const synthetic: typeof fetch = async (_target, init) => {
  const { model, messages } = JSON.parse(String(init?.body)) as WireRequest;
  const user = JSON.stringify(messages.findLast((message) => message.role === 'user')?.content);
  if (user.includes('Reply with exactly OEP-READY.')) {
    assert.equal(messages.length, 1);
    pinged.push(model);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'OEP-READY' }, finish_reason: 'stop' }] });
  }
  if (user.includes('SYNTHETIC_TOOL_LIMIT')) {
    assert.equal(model, gatewayAliases[1]);
    return completion(model, toolCall(0, 'call_limit', 'write', { path: 'synthetic.txt', content: 'sample' }), 'tool_calls');
  }
  if (user.includes('SYNTHETIC_SLOW_TURN')) {
    slowStarted = true;
    await new Promise<void>((resolve) => {
      const signal = init?.signal;
      const timeout = setTimeout(resolve, 12_000);
      signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
    return completion(model, [{ role: 'assistant', content: '合成慢速回覆' }], 'stop');
  }
  const item = cases.find((item) => user.includes(item.prompt));
  assert.ok(item);
  if (item.agent === 'workbook') {
    assert.match(user, /Row 2,SYN-48B,12.5,TRUE/);
    const path = user.match(/generated\/[a-f\d-]+\.json/)?.[0];
    assert.ok(path);
    if (!messages.slice(messages.findLastIndex((message) => message.role === 'user') + 1).some((message) => message.role === 'tool')) {
      const output = structuredClone(sheets);
      if (user.includes('SYNTHETIC_REVISION')) output[0].rows[1][1] = 13.5;
      return completion(model, toolCall(0, 'call_browser_xlsx', 'write', { path, content: JSON.stringify(output), note: 'token: sample-hidden-value', outside: 'Z:/synthetic/private.txt' }), 'tool_calls');
    }
  } else assert.ok(user.includes(readFileSync(asset(item.name)).toString('base64')));
  return completion(model, [{ role: 'assistant', content: item.agent === 'workbook'
    ? '# 合成量測摘要\n- 讀取工作表\n- 建立合成結果\n\n| 項目 | 數值 |\n| --- | --- |\n| SYN-48B | 12.5 |\n\n```text\nSYN-48B\n```\n<script>window.injected=1</script><img src=x onerror=window.injected=1> [測試](javascript:alert(1))'
    : item.expected }], 'stop');
};

console.log(JSON.stringify({ browser: real ? 'real' : 'synthetic', audit }));
const runtime = await startRuntime(audit, real ? undefined : {
  url: syntheticURL, key: syntheticKey, alias: aliases[0], aliases, fetch: synthetic, isolatedJob: true,
}, profile);
try {
  const stopping = Promise.withResolvers<void>();
  const web = await startAdapter(root, runtime, stopping.resolve);
  try {
    const page = await chromium(join(root, 'chromium'));
    try {
      await page.command('Page.navigate', { url: web.pairURL() });
      await page.ready("!document.querySelector('#new-session')?.disabled && location.hash === ''");
      assert.equal(await page.evaluate("document.cookie.includes('oep_session')"), false);
      assert.equal(await page.evaluate("document.querySelector('#demo-job').hidden"), false);
      await page.command('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      let passed = 0;
      for (const item of cases) {
        const started = Date.now();
        let sessionID: string | undefined;
        let matched = false;
        let toolEvents = false;
        let artifact: { path: string; sha256: string } | undefined;
        let failure: string | undefined;
        try {
          const previous = await page.evaluate<string>("document.querySelector('[aria-current=true]')?.dataset.session");
          await page.evaluate(`document.querySelector('#agent').value = ${JSON.stringify(item.agent)};
            document.querySelector('#new-session').click()`);
          await page.ready(`document.querySelector('[aria-current=true]')?.dataset.session !== ${JSON.stringify(previous)} &&
            !document.querySelector('#pick').disabled`);
          sessionID = await page.evaluate<string>("document.querySelector('[aria-current=true]')?.dataset.session");
          if (item.name === 'marker.pdf') {
            const source = readFileSync(asset(item.name)).toString('base64');
            await page.evaluate(`(() => {
              const bytes = Uint8Array.from(atob(${JSON.stringify(source)}), (char) => char.charCodeAt(0));
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(new File([bytes], 'marker.pdf', { type: 'application/pdf' }));
              document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
            })()`);
          } else {
            const { root } = await page.command<{ root: { nodeId: number } }>('DOM.getDocument');
            const { nodeId } = await page.command<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
            await page.command('DOM.setFileInputFiles', { nodeId, files: [asset(item.name)] });
          }
          await page.ready(`document.querySelector('#attachments').textContent.includes(${JSON.stringify(item.name)}) &&
            document.querySelector('#attachments input')?.checked`);
          if (item.agent === 'workbook') assert.match(await page.evaluate<string>("document.querySelector('#attachments').textContent"), /CSV/);
          await page.evaluate(`document.querySelector('#prompt').value = ${JSON.stringify(item.prompt)};
            document.querySelector('#workbook').checked = ${item.agent === 'workbook'};
            document.querySelector('#send').click()`);
          await page.ready("['已完成','這次處理未完成'].includes(document.querySelector('#progress').textContent)", 130_000);
          const progress = await page.evaluate<string>("document.querySelector('#progress').textContent");
          if (progress !== '已完成') throw new Error(await page.evaluate<string>("document.querySelector('#error').textContent"));
          matched = await page.evaluate<boolean>(`[...document.querySelectorAll('.message.assistant')].some(
            (item) => item.textContent.includes(${JSON.stringify(item.expected)}))`);
          assert.ok(matched, 'Expected fixture value missing from the browser reply');
          if (item.agent === 'workbook') {
            toolEvents = await page.evaluate<boolean>("document.querySelector('#activity').textContent.includes('工具完成')");
            assert.ok(toolEvents, 'Tool completion did not reach the browser');
            const manifest = await page.evaluate<{ bytes: number; sha256: string }>(`(async () => {
              const response = await fetch('/api/sessions/' + document.querySelector('[aria-current=true]')?.dataset.session + '/state');
              return (await response.json()).runs.at(-1).artifact;
            })()`);
            await page.evaluate("document.querySelector('#artifacts a').click()");
            const path = join(downloads, 'output.xlsx');
            await until(async () => existsSync(path) || undefined, 10_000);
            const bytes = readFileSync(path);
            artifact = { path, sha256: sha256(bytes) };
            assert.equal(artifact.sha256, manifest.sha256);
            assert.equal(bytes.length, manifest.bytes);
            assert.deepEqual(await convertWorkbook(bytes), await convertWorkbook(readFileSync(asset(item.name))));
          }
          passed++;
        } catch (error) {
          failure = error instanceof Error ? error.message.split('\n')[0] : 'Unknown failure';
        } finally {
          const record = { alias: runtime.alias, case: item.name, sessionID, matched, toolEvents, artifact, failure,
            elapsedMs: Date.now() - started, fixtureSha256: sha256(readFileSync(asset(item.name))) };
          appendFileSync(join(audit, 'browser-attempts.jsonl'), `${JSON.stringify(record)}\n`);
          console.log(JSON.stringify(record));
          const screenshot = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(audit, `${item.name}.screenshot.png`), Buffer.from(screenshot.data, 'base64'));
        }
      }
      if (!real) {
        await page.ready("document.querySelector('.tool-card[data-status=done]')");
        assert.equal(await page.evaluate("document.querySelectorAll('.tool-card').length"), 1);
        await page.evaluate("document.querySelector('.tool-card summary').click()");
        assert.equal(await page.evaluate("document.querySelector('.tool-card').open"), true);
        assert.equal(await page.evaluate("/sample-hidden-value|Z:\\/synthetic/.test(document.querySelector('.tool-details').textContent)"), false);
        assert.equal(await page.evaluate("!!document.querySelector('#messages table') && !!document.querySelector('#messages pre code')"), true);
        assert.equal(await page.evaluate("!window.injected && !document.querySelector('#messages script, #messages img, #messages a[href^=javascript]')"), true);
        await page.evaluate("document.querySelector('.tool-card summary').click()");
        await page.command('Page.reload');
        await page.ready("document.querySelectorAll('.tool-card').length === 1");
        await page.command('Network.enable');
        const network = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
        await page.command('Network.emulateNetworkConditions', { ...network, offline: true });
        await page.command('Network.emulateNetworkConditions', { ...network, offline: false });
        await page.ready("document.querySelector('#connection').textContent === '已連線'");
        assert.equal(await page.evaluate("document.querySelectorAll('.tool-card').length"), 1);
        assert.equal(await page.evaluate("document.querySelector('.tool-card').open"), false);
        await page.evaluate("document.querySelector('[aria-current=true]').nextElementSibling.querySelector('summary').focus()");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await page.ready("document.activeElement.dataset.action === 'rename'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.dataset.action === 'remove'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.ready("document.activeElement.tagName === 'SUMMARY' && !document.activeElement.parentElement.open");
        assert.equal(await page.evaluate("document.querySelector('[aria-current=true] time').textContent === '剛剛'"), true);
        const selected = await page.evaluate<string>("document.querySelector('[aria-current=true]')?.dataset.session");
        const longTitle = '合成量測報告與工作表輸出驗證'.repeat(4);
        await page.evaluate(`window.prompt = () => ${JSON.stringify(longTitle)};
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=rename]').click()`);
        await page.ready(`document.querySelector('#session-title').textContent === ${JSON.stringify(longTitle)}`);
        assert.equal(await page.evaluate(`(() => {
          const title = document.querySelector('[aria-current=true] .session-name');
          return title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis';
        })()`), true);
        await page.evaluate(`
          window.prompt = () => '合成會話';
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=rename]').click();
        `);
        await page.ready("document.querySelector('#session-title').textContent === '合成會話'");
        await page.evaluate(`
          const search = document.querySelector('#session-search');
          search.value = '合成會話';
          search.dispatchEvent(new Event('input'));
        `);
        assert.equal(await page.evaluate("document.querySelectorAll('#sessions [data-session]').length"), 1);
        await page.evaluate("document.querySelector('#clear-session-search').click()");
        assert.equal(await page.evaluate("document.querySelectorAll('#sessions [data-session]').length"), cases.length);
        await page.ready("!document.querySelector('#save-appearance').disabled");
        await page.evaluate(`
          const theme = document.querySelector('#theme');
          theme.value = 'dark';
          theme.dispatchEvent(new Event('change'));
          document.querySelector('#density').value = 'compact';
          document.querySelector('#appearance-settings').requestSubmit();
        `);
        await page.ready("document.querySelector('#appearance-status').textContent === '已儲存'");
        await page.ready("!document.querySelector('#save-assistant').disabled");
        await page.evaluate(`
          document.querySelector('#assistant-name').value = '合成助理';
          document.querySelector('#assistant-introduction').value = '測試簡介';
          document.querySelector('#assistant-instructions').value = '使用繁體中文';
          document.querySelector('#assistant-settings').requestSubmit();
        `);
        await page.ready("document.querySelector('#settings-status').textContent === '已儲存'");
        await page.evaluate("document.documentElement.dataset.beforeSettingsReload = 'true'");
        await page.command('Page.reload');
        await page.ready(`!document.documentElement.dataset.beforeSettingsReload &&
          document.querySelector('#assistant-name')?.value === '合成助理'`);
        assert.equal(await page.evaluate("document.querySelector('#assistant-introduction').value"), '測試簡介');
        assert.equal(await page.evaluate("document.querySelector('#assistant-instructions').value"), '使用繁體中文');
        await page.ready(`document.querySelector('[aria-current=true]')?.dataset.session === ${JSON.stringify(selected)} &&
          document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.density === 'compact' &&
          document.querySelector('#session-title').textContent === '合成會話'`);
        await page.evaluate(`
          window.confirm = () => false;
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
        `);
        assert.equal(await page.evaluate("document.querySelector('[aria-current=true]')?.dataset.session"), selected);
        await page.evaluate("document.querySelector('#new-session-secondary').click()");
        await page.ready(`document.querySelector('[aria-current=true]')?.dataset.session &&
          document.querySelector('[aria-current=true]').dataset.session !== ${JSON.stringify(selected)} &&
          !document.querySelector('#pick').disabled`);
        const other = await page.evaluate<string>("document.querySelector('[aria-current=true]').dataset.session");
        assert.equal(await page.evaluate("document.querySelectorAll('#sessions [data-session]').length"), 1);
        await page.ready("document.querySelector('#attachments').querySelectorAll('input').length === 0");
        assert.equal(await page.evaluate("document.querySelector('#artifacts').querySelectorAll('a').length"), 0);
        const isolation = await page.evaluate<number[]>(`(async () => {
          const first = '/api/projects/default/sessions/';
          const second = '/api/projects/secondary/sessions/';
          const primary = ${JSON.stringify(selected)};
          const secondary = ${JSON.stringify(other)};
          const bootstrap = await fetch('/api/bootstrap').then(response => response.json());
          const request = (path, options) => fetch(path, options).then(response => response.status);
          const state = await fetch(first + primary + '/state').then(response => response.json());
          const run = state.runs.at(-1).id;
          return Promise.all([
            request(first + secondary + '/state'),
            request(second + primary + '/state'),
            request(second + primary + '/events'),
            request(second + primary + '/artifacts/' + run),
            request(second + primary + '/attachments', {
              method: 'POST', headers: { 'X-OEP-CSRF': bootstrap.csrf }, body: 'synthetic',
            }),
          ]);
        })()`);
        assert.deepEqual(isolation, [404, 404, 404, 404, 404]);
        await page.evaluate("document.querySelector('.project h2 button').click()");
        await page.ready(`document.querySelector('[data-session="' + ${JSON.stringify(selected)} + '"]') !== null`);
        await page.evaluate(`document.querySelector('[data-session="' + ${JSON.stringify(selected)} + '"]').click()`);
        await page.ready("document.querySelector('#session-title').textContent === '合成會話'");
        await page.ready("document.querySelector('.tool-card')");
        const capture = async (name: string) => {
          await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
          const image = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          writeFileSync(join(audit, name + '.png'), Buffer.from(image.data, 'base64'));
        };
        await page.ready("!document.querySelector('#recheck-model').disabled && !document.querySelector('#save-limits').disabled");
        assert.deepEqual([...pinged].sort(), [...aliases].sort());
        await page.ready(`document.querySelector('#runtime-details').textContent.includes('v2.3.2') &&
          document.querySelector('#runtime-agent').textContent.includes('Excel 工作表')`);
        const avatarBytes = readFileSync(asset('marker.png'));
        const oversized = Buffer.from(avatarBytes);
        oversized.writeUInt32BE(1025, 16);
        const apiChecks = await page.evaluate<{ statuses: number[]; visible: string }>(`(async () => {
          const { csrf } = await fetch('/api/bootstrap').then(response => response.json());
          const post = (path, data) => fetch(path, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-OEP-CSRF': csrf,
          }, body: JSON.stringify(data) }).then(response => response.status);
          const session = '/api/sessions/' + ${JSON.stringify(selected)};
          const appearance = '/api/settings/appearance';
          const statuses = [];
          for (const avatar of [btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), btoa('bad signature'),
              ${JSON.stringify(oversized.toString('base64'))}, btoa('A'.repeat(91 * 1024)), ${JSON.stringify(avatarBytes.toString('base64'))}]) {
            statuses.push(await post(appearance, { theme: 'dark', density: 'compact', avatar }));
          }
          statuses.push(await post('/api/settings', { name: ${JSON.stringify(syntheticKey)}, introduction: '', instructions: '' }));
          statuses.push(await post('/api/settings/model', { alias: 'unknown-synthetic-alias' }));
          statuses.push(await post(session + '/model', { alias: 'unknown-synthetic-alias' }));
          statuses.push(await post('/api/settings/limits', { recentMessages: -1, historyBytes: 0, toolCalls: 0, timeoutSeconds: 5 }));
          const responses = await Promise.all(['', '/appearance', '/avatar', '/model', '/limits', '/runtime']
            .map(suffix => fetch('/api/settings' + suffix).then(response => response.text())));
          return { statuses, visible: responses.join(' ') + document.documentElement.outerHTML };
        })()`);
        assert.deepEqual(apiChecks.statuses, [400, 400, 400, 400, 200, 400, 400, 400, 400]);
        for (const marker of [syntheticKey, syntheticURL, 'example.invalid']) assert.equal(apiChecks.visible.includes(marker), false);
        await page.command('Page.reload');
        await page.ready("document.querySelector('.sidebar-assistant img')?.naturalWidth > 0 && document.querySelector('#messages .assistant-avatar img')?.naturalWidth > 0");
        await page.evaluate("document.querySelector('#avatar-reset').click(); document.querySelector('#appearance-settings').requestSubmit()");
        await page.ready("document.querySelector('#appearance-status').textContent === '已儲存' && !document.querySelector('.sidebar-assistant img')");
        await page.evaluate("document.querySelector('#recheck-model').click()");
        await page.ready("document.querySelector('#model-settings-status').textContent === '已重新檢查'");
        assert.deepEqual(pinged.slice(2).sort(), [...aliases].sort());
        const traces = ['health.jsonl', 'gateway.jsonl', 'web-turns.jsonl'].map((name) =>
          readFileSync(join(audit, name), 'utf8')).join(' ');
        for (const marker of [syntheticKey, syntheticURL, 'example.invalid']) assert.equal(traces.includes(marker), false);
        await page.evaluate("document.querySelector('#recheck-model').click()");
        await page.ready("document.querySelector('#model-settings-status').textContent.includes('30 秒')");
        await page.evaluate(`
          document.querySelector('#default-alias').value = ${JSON.stringify(gatewayAliases[1])};
          document.querySelector('#model-settings').requestSubmit();
          document.querySelector('#session-alias').value = ${JSON.stringify(gatewayAliases[1])};
          document.querySelector('#session-alias').dispatchEvent(new Event('change'));
        `);
        await page.ready("document.querySelector('#session-model-status').textContent === '模型已切換' && document.querySelector('#model-settings-status').textContent === '已儲存'");
        await page.evaluate(`
          document.querySelector('#limit-toolCalls').value = '0';
          document.querySelector('#limit-timeoutSeconds').value = '5';
          document.querySelector('#limits-settings').requestSubmit();
        `);
        await page.ready("document.querySelector('#limits-status').textContent === '已儲存'");
        await page.command('Page.reload');
        await page.ready(`document.querySelector('#session-alias').value === ${JSON.stringify(gatewayAliases[1])} &&
          document.querySelector('#default-alias').value === ${JSON.stringify(gatewayAliases[1])} &&
          document.querySelector('#limit-toolCalls')?.value === '0' && document.querySelector('#limit-timeoutSeconds')?.value === '5'`);
        for (const [prompt, status] of [['SYNTHETIC_TOOL_LIMIT', '工具呼叫次數上限'], ['SYNTHETIC_SLOW_TURN', '回合時限']]) {
          await page.ready("!document.querySelector('#send').disabled");
          await page.evaluate(`
            document.querySelector('#prompt').value = ${JSON.stringify(prompt)};
            document.querySelector('#composer').requestSubmit();
          `);
          await page.ready(`document.querySelector('#error').textContent.includes(${JSON.stringify(status)})`);
        }
        slowStarted = false;
        await page.evaluate(`
          document.querySelector('#limit-toolCalls').value = '24';
          document.querySelector('#limit-timeoutSeconds').value = '105';
          document.querySelector('#limits-settings').requestSubmit();
        `);
        await page.ready("document.querySelector('#limits-status').textContent === '已儲存'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: ',', code: 'Comma', modifiers: 2, windowsVirtualKeyCode: 188 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', modifiers: 2, windowsVirtualKeyCode: 188 });
        await page.ready("document.activeElement.id === 'settings-title'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.id === 'close-settings'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.dataset.section === 'assistant'");
        await page.evaluate(`
          window.confirm = () => false;
          document.querySelector('#assistant-name').value = '未儲存的名稱';
          document.querySelector('[data-section=appearance]').click();
        `);
        assert.equal(await page.evaluate("document.querySelector('#settings-appearance').hidden"), true);
        await page.evaluate("window.confirm = () => true");
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.dataset.section === 'appearance'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await page.ready("!document.querySelector('#settings-appearance').hidden");
        assert.equal(await page.evaluate("document.querySelector('#assistant-name').value"), '合成助理');
        for (const [width, layout] of [[1200, 'wide'], [390, 'narrow']] as const) {
          await page.command('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
          for (const theme of ['light', 'dark']) {
            await page.evaluate(`
              document.querySelector('#appearance-status').textContent = '';
              document.querySelector('#theme').value = ${JSON.stringify(theme)};
              document.querySelector('#appearance-settings').requestSubmit();
            `);
            await page.ready("document.querySelector('#appearance-status').textContent === '已儲存'");
            for (const section of ['assistant', 'appearance', 'model', 'limits', 'runtime', 'integrations']) {
              await page.evaluate(`(() => {
                const sectionButton = document.querySelector('[data-section="${section}"]');
                sectionButton.click();
                sectionButton.focus();
                window.scrollTo(0, 0);
              })()`);
              assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
              await capture(`settings-${section}-${theme}-${layout}`);
            }
          }
        }
        await page.evaluate("document.querySelector('#open-chat').click()");
        await page.command('Emulation.clearDeviceMetricsOverride');
        const captureLayouts = async (running: boolean) => {
          for (const [width, layout] of [[1200, 'wide'], [390, 'narrow']] as const) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
            assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
            if (layout === 'narrow') await page.ready("matchMedia('(max-width: 540px)').matches && document.querySelector('#session-sidebar').hidden");
            for (const theme of ['light', 'dark']) {
              await page.evaluate(`(() => {
                const theme = document.querySelector('#theme');
                theme.value = ${JSON.stringify(theme)};
                theme.dispatchEvent(new Event('change'));
              })()`);
              if (running) {
                await page.evaluate("document.querySelector('#messages').scrollTop = document.querySelector('#messages').scrollHeight; window.scrollTo(0, 0)");
                await capture(`running-${theme}-${layout}`);
              } else {
                if (layout === 'narrow') {
                  await page.evaluate("if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click()");
                  await page.ready("!document.querySelector('#session-sidebar').hidden");
                }
                await capture(`workbench-${theme}-${layout}`);
                if (layout === 'narrow') {
                  await page.evaluate("if (!document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click()");
                  await page.ready("document.querySelector('#session-sidebar').hidden");
                }
                await page.evaluate(`(() => {
                  const pane = document.querySelector('#messages');
                  const card = document.querySelector('.tool-card');
                  pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 110;
                  window.scrollTo(0, 0);
                })()`);
                await capture(`conversation-${theme}-${layout}`);
                await page.evaluate(`(() => {
                  const pane = document.querySelector('#messages');
                  const card = document.querySelector('.tool-card');
                  card.open = true;
                  pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 5;
                  window.scrollTo(0, 0);
                })()`);
                await capture(`tools-expanded-${theme}-${layout}`);
                await page.evaluate("document.querySelector('.tool-card').open = false; window.scrollTo(0, 0)");
              }
            }
          }
        };
        await captureLayouts(false);
        await page.evaluate(`(() => {
          document.querySelector('#prompt').value = 'SYNTHETIC_SLOW_TURN';
          document.querySelector('#workbook').checked = true;
          document.querySelector('#composer').requestSubmit();
        })()`);
        await until(async () => slowStarted || undefined, 8_000);
        await page.ready("!document.querySelector('#cancel-turn').hidden && document.querySelector('#send').hidden");
        await page.ready("/已等候 [1-9] 秒/.test(document.querySelector('#progress').textContent)");
        await captureLayouts(true);
        await page.evaluate("document.querySelector('#cancel-turn').click(); document.querySelector('#cancel-turn').click()");
        await page.ready("document.querySelector('#progress').textContent === '已停止這次處理' && !document.querySelector('#send').disabled");
        const ledger = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
        try {
          const row = ledger.prepare("SELECT record FROM runs WHERE state = 'cancelled' AND json_extract(record, '$.mode') = 'web-workbook'").get();
          assert.ok(row);
          const run = JSON.parse(String(row.record));
          assert.equal(run.mode, 'web-workbook');
          assert.equal(run.artifact, undefined);
          assert.equal((await runtime.client.session.get({ sessionID: run.sessionID }, call())).outcome, 'interrupted');
          const response = await page.evaluate(`(async () => {
            const root = '/api/sessions/' + ${JSON.stringify(selected)};
            const { csrf } = await fetch('/api/bootstrap').then(r => r.json());
            const cancel = await fetch(root + '/cancel-turn', { method: 'POST', headers: { 'Content-Type': 'application/json',
              'X-OEP-CSRF': csrf }, body: JSON.stringify({ id: ${JSON.stringify(run.id)} }) }).then(r => r.json());
            const download = await fetch(root + '/artifacts/' + ${JSON.stringify(run.id)});
            return [cancel.state, download.status];
          })()`);
          assert.deepEqual(response, ['cancelled', 404]);
        } finally { ledger.close(); }
        await page.evaluate(String.raw`(() => {
          const data = new DataTransfer();
          data.items.add(new File(['合成文字'], 'sample.txt', { type: 'text/plain' }));
          data.items.add(new File(['# 合成標題\n- 項目'], 'sample.md', { type: 'text/markdown' }));
          data.items.add(new File(['編號,備註\r\n' + Array.from({ length: 202 }, (_, i) => (i + 1) + ',"甲,乙"').join('\r\n')], 'sample.csv', { type: 'text/csv' }));
          data.items.add(new File(['<p>合成 HTML</p><script>parent.postMessage("oep-preview-script", "*")</script>'], 'sample.html', { type: 'text/html' }));
          window.addEventListener('message', event => { if (event.data === 'oep-preview-script') window.previewScript = true; });
          document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
        })()`);
        await page.ready("document.querySelector('#attachments').textContent.includes('sample.html')");
        const previewAttachment = async (name: string) => {
          await page.evaluate(`[...document.querySelectorAll('#attachments li')].find(row => row.querySelector('label')?.textContent === ${JSON.stringify(name)})
            .querySelectorAll('button')[1].click()`);
        };
        await page.evaluate("document.querySelector('#toggle-files').click()");
        await page.ready("document.querySelector('#toggle-files').getAttribute('aria-expanded') === 'true'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        await page.ready("document.activeElement.id === 'tab-work' && document.querySelector('#panel-runs').textContent.includes('已完成')");
        await page.command('Page.reload');
        await page.ready("document.querySelector('#tab-work').getAttribute('aria-selected') === 'true'");
        await page.ready("document.querySelector('#panel-jobs').textContent.includes('BI 工作')");
        await page.evaluate(`(() => {
          const fetchAPI = window.fetch;
          window.fetch = (path, options) => {
            if (path !== '/api/jobs') return fetchAPI(path, options);
            window.fetch = fetchAPI;
            return Promise.resolve(Response.json({
              jobs: [{ completed: 1, review_status: 'pending' }, { completed: 0, expires: Date.now() + 10000 }],
              schedules: [{ state: 'paused' }],
            }));
          };
          document.querySelector('#tab-work').click();
        })()`);
        await page.ready("document.querySelector('#panel-jobs').textContent.includes('待審核 1 筆、執行中 1 筆。排程：已暫停 1 筆')");
        await page.evaluate("document.querySelector('#panel-jobs-link').click()");
        await page.ready("!document.querySelector('#jobs-view').hidden && document.activeElement.id === 'jobs-title'");
        await page.evaluate("document.querySelector('#open-jobs').click()");

        await page.evaluate("document.querySelector('#toggle-files').click()");
        await page.evaluate("document.querySelector('#tab-files').click()");
        await page.evaluate("window.addEventListener('message', event => { if (event.data === 'oep-preview-script') window.previewScript = true; })");
        await page.ready("document.querySelector('#attachments').textContent.includes('sample.html')");
        await previewAttachment('sample.html');
        await page.ready("document.querySelector('#file-preview iframe')?.getAttribute('sandbox') === ''");
        await page.evaluate("new Promise(resolve => setTimeout(resolve, 150))");
        assert.equal(await page.evaluate("!window.previewScript && !document.querySelector('#file-preview iframe').contentDocument"), true);
        await previewAttachment('sample.md');
        await page.ready("document.querySelector('#file-preview .preview-body')?.textContent.includes('合成標題')");
        await previewAttachment('sample.csv');
        await page.ready("document.querySelectorAll('#file-preview tr').length === 200");
        await page.evaluate("[...document.querySelectorAll('#file-preview button')].find(b => b.textContent === '顯示更多').click()");
        assert.equal(await page.evaluate("document.querySelectorAll('#file-preview tr').length"), 203);
        await previewAttachment('table.xlsx');
        await page.ready("document.querySelectorAll('#file-preview option').length === 2");
        await page.evaluate(`(() => {
          const select = document.querySelector('#file-preview select');
          select.value = 'Notes';
          select.dispatchEvent(new Event('change'));
        })()`);
        await page.ready("document.querySelector('#file-preview table').textContent.includes('合成資料')");
        const { root: uploadDocument } = await page.command<{ root: { nodeId: number } }>('DOM.getDocument');
        const { nodeId: uploadInput } = await page.command<{ nodeId: number }>('DOM.querySelector',
          { nodeId: uploadDocument.nodeId, selector: '#file-input' });
        await page.command('DOM.setFileInputFiles', { nodeId: uploadInput, files: [asset('marker.png'), asset('marker.pdf')] });
        await page.ready("document.querySelector('#upload-status').textContent.includes('已上傳 2')");
        await page.evaluate(`(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 240;
          canvas.height = 120;
          const context = canvas.getContext('2d');
          context.fillStyle = '#254c61';
          context.fillRect(0, 0, 240, 120);
          context.fillStyle = 'white';
          context.font = '24px sans-serif';
          context.fillText('SYN-42', 30, 65);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
          const data = new DataTransfer();
          data.items.add(new File([blob], 'sample.jpg', { type: 'image/jpeg' }));
          document.querySelector('#drop').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
        })()`);
        await page.ready("document.querySelector('#attachments').textContent.includes('sample.jpg')");
        const previews = [
          ['sample.txt', 'text', "document.querySelector('#file-preview pre')?.textContent === '合成文字'"],
          ['sample.md', 'markdown', "document.querySelector('#file-preview .preview-body')?.textContent.includes('合成標題')"],
          ['sample.csv', 'csv', "document.querySelectorAll('#file-preview tr').length === 200"],
          ['table.xlsx', 'xlsx', "document.querySelectorAll('#file-preview option').length === 2"],
          ['marker.png', 'png', "document.querySelector('#file-preview img')?.naturalWidth > 0"],
          ['sample.jpg', 'jpeg', "document.querySelector('#file-preview img')?.naturalWidth > 0"],
          ['marker.pdf', 'pdf', "document.querySelector('#file-preview').textContent.includes('目前無法預覽 PDF')"],
          ['sample.html', 'html', "document.querySelector('#file-preview iframe')?.getAttribute('sandbox') === ''"],
        ];
        for (const [name, , ready] of previews) {
          await previewAttachment(name);
          await page.ready(ready);
        }
        const panelLayouts = async (diff: boolean) => {
          for (const [width, layout] of [[1200, 'wide'], [390, 'narrow']] as const) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false });
            await page.ready(`innerWidth === ${width}`);
            for (const theme of ['light', 'dark']) {
              await page.evaluate(`(() => {
                const theme = document.querySelector('#theme');
                theme.value = ${JSON.stringify(theme)};
                theme.dispatchEvent(new Event('change'));
                window.scrollTo(0, 0);
                document.querySelectorAll('#chat-files [role=tabpanel]').forEach(panel => { panel.scrollTop = 0; });
              })()`);
              if (layout === 'narrow') {
                await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
                await page.ready("getComputedStyle(document.querySelector('#toggle-files')).display !== 'none'");
                await page.evaluate("if (!document.querySelector('#chat-files').classList.contains('sheet-open')) document.querySelector('#toggle-files').click()");
                await page.ready("document.querySelector('#chat-files').getBoundingClientRect().height > 0");
              }
              const screenshot = async (view: string) => {
                if (layout === 'narrow') {
                  await page.evaluate(`(() => {
                    const panel = document.querySelector('#chat-files');
                    if (!panel.classList.contains('sheet-open')) document.querySelector('#toggle-files').click();
                  })()`);
                  await page.ready(`(() => {
                    const bounds = document.querySelector('#chat-files').getBoundingClientRect();
                    return bounds.height > 0 && bounds.bottom <= innerHeight && bounds.top < innerHeight;
                  })()`);
                }
                await capture(`right-panel-${view}-${theme}-${layout}`);
              };
              if (diff) {
                await screenshot('diff');
                continue;
              }
              await page.evaluate("document.querySelector('#tab-files').click(); document.querySelector('#file-preview button')?.click()");
              await screenshot('files');
              await page.evaluate("document.querySelector('#tab-work').click()");
              await page.ready("document.querySelector('#panel-jobs').textContent.includes('BI 工作')");
              await screenshot('work');
              await page.evaluate("document.querySelector('#tab-files').click()");
              for (const [name, view, ready] of previews) {
                await previewAttachment(name);
                await page.ready(ready);
                await screenshot(view);
              }
            }
          }
        };
        if (process.env.OEP_CAPTURE_RIGHT_PANEL === '1') await panelLayouts(false);
        const downloaded = await page.evaluate<{ href: string; hash: string }>(`(() => {
          const row = [...document.querySelectorAll('#attachments li')].find(row => row.textContent.includes('sample.txt'));
          const link = row.querySelector('a');
          link.click();
          return { href: link.getAttribute('href'), hash: row.querySelector('button').title };
        })()`);
        const attachmentDownload = join(downloads, 'sample.txt');
        await until(async () => existsSync(attachmentDownload) || undefined, 10_000);
        assert.equal(sha256(readFileSync(attachmentDownload)), downloaded.hash);
        const foreign = downloaded.href.replace('/default/', '/secondary/').replace(selected, other);
        assert.deepEqual(await page.evaluate(`Promise.all([${JSON.stringify(foreign)}, ${JSON.stringify(foreign + '/preview')}]
          .map(url => fetch(url).then(response => response.status)))`), [404, 404]);
        const forbidden = await page.evaluate<number[]>(`(async () => {
          const { csrf } = await fetch('/api/bootstrap').then(response => response.json());
          const artifact = document.querySelector('#artifacts a').getAttribute('href')
            .replace('/default/', '/secondary/').replace(${JSON.stringify(selected)}, ${JSON.stringify(other)});
          const results = await Promise.all([
            fetch(artifact + '/preview'),
            fetch(${JSON.stringify(foreign)}, { method: 'POST', headers: {
              'Content-Type': 'application/json', 'X-OEP-CSRF': csrf
            }, body: '{}' }),
          ]);
          return results.map(response => response.status);
        })()`);
        assert.deepEqual(forbidden, [404, 404]);
        await page.evaluate(`(() => {
          window.confirm = () => true;
          [...document.querySelectorAll('#attachments li')].find(row => row.textContent.includes('sample.txt'))
            .querySelectorAll('button')[2].click();
        })()`);
        await page.ready("!document.querySelector('#attachments').textContent.includes('sample.txt')");
        assert.equal(await page.evaluate(`fetch(${JSON.stringify(downloaded.href)}).then(response => response.status)`), 404);
        await page.evaluate(`(() => {
          const checkbox = [...document.querySelectorAll('#attachments label')].find(label => label.textContent === 'table.xlsx').querySelector('input');
          for (const selected of document.querySelectorAll('#attachments input:checked')) {
            if (selected !== checkbox) selected.click();
          }
          if (!checkbox.checked) checkbox.click();
          document.querySelector('#prompt').value = ${JSON.stringify(cases[2].prompt + ' SYNTHETIC_REVISION')};
          document.querySelector('#workbook').checked = true;
          document.querySelector('#composer').requestSubmit();
        })()`);
        await page.ready("document.querySelectorAll('#artifacts a').length === 2", 130_000);
        await page.evaluate("document.querySelector('#tab-diff').click(); document.querySelector('#panel-diff button').click()");
        await page.ready("document.querySelector('#panel-diff').textContent.includes('1 個儲存格') && document.querySelectorAll('.changed-cell').length === 1");
        if (process.env.OEP_CAPTURE_RIGHT_PANEL === '1') await panelLayouts(true);
        await page.evaluate("document.querySelector('#tab-diff').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
        assert.equal(await page.evaluate("document.activeElement.id === 'toggle-files' && !document.querySelector('#chat-files').classList.contains('sheet-open')"), true);
        await page.evaluate("if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click()");
        await page.evaluate(`
          window.confirm = () => true;
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
        `);
        await page.ready(`!Array.from(document.querySelectorAll('#sessions [data-session]'))
          .some((option) => option.dataset.session === ${JSON.stringify(selected)})`);
        assert.equal(await page.evaluate(`fetch('/api/sessions/' + ${JSON.stringify(selected)} + '/state')
          .then((response) => response.status)`), 404);
        assert.equal(await page.evaluate("document.querySelectorAll('#sessions [data-session]').length"), cases.length - 1);
        assert.equal(await page.evaluate("fetch('/api/projects/secondary/sessions').then(r => r.json()).then(rows => rows.length)"), 1);
      }
      await page.evaluate("document.querySelector('#stop').click()");
      await page.ready("document.querySelector('#connection').textContent === '服務已停止'");
      await stopping.promise;
      assert.equal(passed, cases.length);
    } finally { await page.close(); }
  } finally { await web.close(); }
} finally {
  const stopped = await runtime.stop();
  console.log(JSON.stringify(stopped));
  assert.equal(stopped.orphans, 0);
}
