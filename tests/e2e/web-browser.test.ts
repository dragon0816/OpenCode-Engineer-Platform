import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { convertWorkbook } from '../../apps/adapter/src/runs/attachments.ts';
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
const synthetic: typeof fetch = async (_target, init) => {
  const { model, messages } = JSON.parse(String(init?.body)) as WireRequest;
  const user = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
  const item = cases.find((item) => user.includes(item.prompt));
  assert.ok(item);
  if (item.agent === 'workbook') {
    assert.match(user, /Row 2,SYN-48B,12.5,TRUE/);
    const path = user.match(/generated\/[a-f\d-]+\.json/)?.[0];
    assert.ok(path);
    if (!messages.some((message) => message.role === 'tool')) {
      return completion(model, toolCall(0, 'call_browser_xlsx', 'write', { path, content: JSON.stringify(sheets) }), 'tool_calls');
    }
  } else assert.ok(user.includes(readFileSync(asset(item.name)).toString('base64')));
  return completion(model, [{ role: 'assistant', content: item.expected }], 'stop');
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
        const selected = await page.evaluate<string>("document.querySelector('[aria-current=true]')?.dataset.session");
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
        for (const [width, layout] of [[1200, 'wide'], [390, 'narrow']] as const) {
          await page.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
          assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
          if (layout === 'narrow') {
            await page.ready("document.querySelector('#session-sidebar').hidden");
            await page.evaluate("document.querySelector('#toggle-sidebar').click()");
            assert.equal(await page.evaluate("document.querySelector('#session-sidebar').hidden"), false);
          }
          for (const theme of ['light', 'dark']) {
            await page.evaluate(`(() => {
              const theme = document.querySelector('#theme');
              theme.value = ${JSON.stringify(theme)};
              theme.dispatchEvent(new Event('change'));
            })()`);
            const screenshot = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
            writeFileSync(join(audit, `workbench-${theme}-${layout}.png`), Buffer.from(screenshot.data, 'base64'));
          }
        }
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
