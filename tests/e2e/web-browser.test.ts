import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { convertWorkbook } from '../../apps/adapter/src/runs/attachments.ts';
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
const synthetic: typeof fetch = async (_target, init) => {
  const { model, messages } = JSON.parse(String(init?.body)) as WireRequest;
  const user = JSON.stringify(messages.findLast((message) => message.role === 'user')?.content);
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
    if (!messages.some((message) => message.role === 'tool')) {
      return completion(model, toolCall(0, 'call_browser_xlsx', 'write', { path, content: JSON.stringify(sheets), note: 'token: sample-hidden-value', outside: 'Z:/synthetic/private.txt' }), 'tool_calls');
    }
  } else assert.ok(user.includes(readFileSync(asset(item.name)).toString('base64')));
  return completion(model, [{ role: 'assistant', content: item.agent === 'workbook'
    ? '# 合成量測摘要\n- 讀取工作表\n- 建立合成結果\n\n| 項目 | 數值 |\n| --- | --- |\n| SYN-48B | 12.5 |\n\n```text\nSYN-48B\n```\n<script>window.injected=1</script><img src=x onerror=window.injected=1> [測試](javascript:alert(1))'
    : item.expected }], 'stop');
};

console.log(JSON.stringify({ browser: real ? 'real' : 'synthetic', audit }));
const runtime = await startRuntime(audit, real ? undefined : {
  url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-browser', fetch: synthetic, isolatedJob: true,
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
        await page.evaluate(`
          const theme = document.querySelector('#theme');
          theme.value = 'dark';
          theme.dispatchEvent(new Event('change'));
        `);
        await page.ready("!document.querySelector('#save-assistant').disabled");
        await page.evaluate(`
          document.querySelector('#assistant-name').value = '合成助理';
          document.querySelector('#assistant-introduction').value = '測試簡介';
          document.querySelector('#assistant-instructions').value = '使用繁體中文';
          document.querySelector('#assistant-settings').requestSubmit();
        `);
        await page.ready("document.querySelector('#settings-status').textContent === '已儲存'");
        await page.command('Page.reload');
        await page.ready("document.querySelector('#assistant-name').value === '合成助理'");
        assert.equal(await page.evaluate("document.querySelector('#assistant-introduction').value"), '測試簡介');
        assert.equal(await page.evaluate("document.querySelector('#assistant-instructions').value"), '使用繁體中文');
        await page.ready(`document.querySelector('[aria-current=true]')?.dataset.session === ${JSON.stringify(selected)} &&
          document.documentElement.dataset.theme === 'dark' &&
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
          const image = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(audit, name + '.png'), Buffer.from(image.data, 'base64'));
        };
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
        await captureLayouts(true);
        await page.evaluate("document.querySelector('#cancel-turn').click(); document.querySelector('#cancel-turn').click()");
        await page.ready("document.querySelector('#progress').textContent === '已停止這次處理' && !document.querySelector('#send').disabled");
        const ledger = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
        try {
          const row = ledger.prepare("SELECT record FROM runs WHERE state = 'cancelled'").get();
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
