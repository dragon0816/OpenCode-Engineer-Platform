import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { assertNativeDialogTextInThemes, assertUiTextInThemes } from './forbidden-shell-text.ts';
import { assertContrastInThemes } from './gui-contrast.ts';
import { mappingChecks } from './gui-mapping.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const real = process.argv.includes('--real');
const captureGallery = process.env.OEP_CAPTURE_GUI_POLISH === '1';
assert.ok(!(real && captureGallery), 'The GUI gallery requires synthetic data');
const screenshotViewports = [[1440, 900, 'wide'], [390, 844, 'narrow']] as const;
const capturePanels = captureGallery || process.env.OEP_CAPTURE_RIGHT_PANEL === '1';
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
let syntheticReadOnlyFile: string | undefined;
const pinged: string[] = [];
const aliases = ['synthetic-browser', gatewayAliases[1]] as const;
const settingsPages = [
  ['assistant', '助理', ['#assistant-name', '#assistant-introduction', '#assistant-instructions', '#save-assistant', '#settings-status', '#assistant-delegation']],
  ['appearance', '外觀', ['#theme', '#density', '#avatar-file', '#avatar-reset', '#save-appearance', '#appearance-status']],
  ['model', '模型', ['#default-alias', '#save-model', '#recheck-model', '#model-settings-status', '#model-credentials', '#model-health li']],
  ['limits', '回合限制', ['#limit-recentMessages', '#limit-historyBytes', '#limit-toolCalls', '#limit-timeoutSeconds', '#limit-fields small', '#save-limits', '#limits-status']],
  ['projects', '專案與資料夾', ['#folder-project option', '#project-working-root', '#project-folder-list', '#project-folder', '#project-folder-form button[type=submit]', '#project-folder-status']],
  ['integrations', '整合', ['#knowledge-toolbox', '#atlas-url', '#knowledge-settings button[type=submit]', '#open-atlas', '#knowledge-settings-status', '#knowledge-configured', '#telegram-main-status', '#telegram-bi-status', '#telegram-configured', '.settings-advanced li']],
  ['input', '輸入', ['#enable-microphone', '#microphone-settings-status']],
  ['mcp', '外部工具', ['#mcp-knowledge-status', '#mcp-knowledge-tools', '#mcp-open-knowledge-settings', '#mcp-add', '#mcp-servers', '#mcp-restart-bar #mcp-restart', '#mcp-status']],
  ['runtime', '執行環境', ['#runtime-status', '#runtime-details dd:nth-of-type(2)', '#runtime-agent', '#runtime-fingerprints dd:nth-of-type(4)']],
  ['about', '關於', ['#about-details dd:nth-of-type(4)', '#about-details dd:nth-of-type(5) a', '#about-details dd:nth-of-type(6) a', '#about-status']],
] as const;
const settingsRows: Record<string, Record<string, string[]>> = {
  assistant: {
    assistant: ['#assistant-name', '#assistant-introduction', '#assistant-instructions', '#save-assistant', '#settings-status'],
    'assistant-advanced': ['details #assistant-delegation:disabled', 'details small'],
  },
  appearance: {
    'appearance-theme': ['#theme [value=system]', '#theme [value=light]', '#theme [value=dark]', '#density [value=comfortable]', '#density [value=compact]'],
    'appearance-avatar': ['#avatar-file', '#avatar-reset', '#save-appearance', '#appearance-status'],
  },
  model: {
    'model-controls': ['#default-alias option', '#save-model', '#recheck-model', '#model-settings-status'],
    'model-status': ['#model-credentials', '#model-health li'],
    'model-advanced': ['details summary', 'details p'],
  },
  limits: { limits: ['#limit-recentMessages', '#limit-historyBytes', '#limit-toolCalls', '#limit-timeoutSeconds', '#limit-fields small', '#save-limits', '#limits-status'] },
  projects: { projects: ['#folder-project option', '#project-working-root', '#project-folder-list'] },
  integrations: {
    integration: ['#knowledge-toolbox', '#atlas-url', '#knowledge-settings button[type=submit]', '#open-atlas', '#knowledge-settings-status'],
    'integration-advanced': ['details summary', 'details li:nth-of-type(4)'],
    'integration-status': ['#knowledge-configured', '#telegram-main-status', '#telegram-bi-status', 'details #telegram-configured'],
  },
  input: { input: ['#enable-microphone', '#microphone-settings-status'] },
  mcp: { 'mcp-knowledge': ['#mcp-knowledge-status', '#mcp-knowledge-tools', '#mcp-open-knowledge-settings'] },
  runtime: {
    runtime: ['#runtime-status', '#runtime-details dd:nth-of-type(2)', '#runtime-agent'],
    'runtime-advanced': ['details #runtime-fingerprints dd:nth-of-type(4)'],
  },
  about: { about: ['#about-details dd:nth-of-type(4)', '#about-details dd:nth-of-type(5) a', '#about-details dd:nth-of-type(6) a'] },
};
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
  if (user.includes('SYNTHETIC_FOLDER_WRITE')) {
    const path = syntheticReadOnlyFile;
    assert.ok(path);
    if (messages.at(-1)?.role !== 'tool') {
      return completion(model, toolCall(0, 'call_folder_write', 'write', { path, content: 'SYNTHETIC_SHOULD_NOT_WRITE' }), 'tool_calls');
    }
    return completion(model, [{ role: 'assistant', content: '合成寫入檢查結束' }], 'stop');
  }
  if (user.includes('SYNTHETIC_REPLY_CONTEXT')) {
    assert.match(user, /BEGIN QUOTED MESSAGE/);
    assert.match(user, /合成量測摘要/);
    assert.match(user, /END QUOTED MESSAGE/);
    return completion(model, [{ role: 'assistant', content: '已核對合成引用' }], 'stop');
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
      async function key(key: string, code: string, windowsVirtualKeyCode: number) {
        const text = key === 'Enter' ? '\r' : undefined;
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, text });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
      }
      const tab = () => key('Tab', 'Tab', 9);
      const enter = () => key('Enter', 'Enter', 13);
      const escape = () => key('Escape', 'Escape', 27);
      const reload = async () => {
        await page.evaluate('window.__beforeReload = true');
        await page.command('Page.reload');
        await page.ready("window.__beforeReload !== true && document.querySelector('#connection').textContent === '已連線'");
      };
      const click = async (selector: string) => {
        const point = await page.evaluate<{ x: number; y: number }>(`(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          element.scrollIntoView({ block: 'nearest' });
          const { left, top, width, height } = element.getBoundingClientRect();
          return { x: left + width / 2, y: top + height / 2 };
        })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        }
      };
      const selectSetting = (section: string) => page.evaluate(`(() => {
        const picker = document.querySelector('#settings-section');
        if (picker.checkVisibility()) {
          picker.value = ${JSON.stringify(section)};
          picker.dispatchEvent(new Event('change', { bubbles: true }));
          picker.focus();
        } else {
          const button = document.querySelector('#settings-nav [data-section="${section}"]');
          button.click();
          button.focus();
        }
        window.scrollTo(0, 0);
      })()`);
      const openPanel = (id: string) => page.evaluate(`(() => {
        const menu = document.querySelector('#top-menu');
        if (!menu.open) document.querySelector('#top-menu-trigger').click();
        document.querySelector(${JSON.stringify('#' + id)}).click();
      })()`);
      const capture = async (name: string) => {
        await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const image = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const png = Buffer.from(image.data, 'base64');
        writeFileSync(join(audit, name + '.png'), png);
        if (captureGallery) writeFileSync(join('docs', 'validation', 'gui', name + '.png'), png);
      };
      await page.command('Page.navigate', { url: web.pairURL() });
      await page.ready("!document.querySelector('#new-session')?.disabled && location.hash === ''");
      assert.equal(await page.evaluate("document.cookie.includes('oep_session')"), false);
      await page.ready("document.querySelector('#connection').textContent === '已連線'");
      await assertUiTextInThemes(page);
      if (!real) {
        const sections = ['rail-functions', 'rail-sessions', 'rail-assistants'];
        const collapsed = `[${sections.map((id) => JSON.stringify(id)).join(',')}].every(id => !document.getElementById(id).open)`;
        for (const id of sections) {
          await tab();
          await page.ready(`document.activeElement === document.querySelector('#${id} > summary')`);
          await enter();
          await page.ready(`!document.getElementById('${id}').open`);
        }
        await page.ready(sections.map((id) => `localStorage.getItem('oep.${id}.open') === 'false'`).join(' && '));
        await reload();
        await page.ready("window.__beforeReload !== true && document.querySelector('#connection').textContent === '已連線'");
        assert.equal(await page.evaluate(collapsed), true);
        await tab();
        await page.ready("document.activeElement === document.querySelector('#rail-functions > summary')");
        await enter();
        await tab();
        await page.ready("document.activeElement.id === 'open-chat'");
        const reached = new Set<string>();
        for (let index = 0; index < 20 && !reached.has('agent'); index++) {
          await tab();
          const focus = await page.evaluate<string>("document.activeElement.id || document.activeElement.parentElement.id");
          reached.add(focus);
          if (focus === 'rail-sessions' || focus === 'rail-assistants') await enter();
        }
        for (const id of ['open-jobs', 'open-settings', 'session-search', 'new-session', 'agent']) assert.ok(reached.has(id), id);
        if (await page.evaluate("!document.querySelector('#open-review').hidden")) {
          assert.ok(reached.has('open-knowledge') && reached.has('open-review'));
        }
        const audit = async (selector: string, scope = 'body') => {
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
          await assertUiTextInThemes(page, scope);
        };
        await assertContrastInThemes(page, [
          { selector: '#connection' }, { selector: '#session-title' }, { selector: '#messages .empty' },
          { selector: '#prompt' }, { selector: '#prompt', property: 'borderTopColor', against: '#drop' },
          { selector: '#top-menu-trigger', property: 'borderTopColor', against: '.top' },
        ]);
        await audit('#top-menu-trigger', '#top-menu');
        await assertContrastInThemes(page, [{ selector: '#stop' }, { selector: '#toggle-files' }]);
        await page.evaluate("document.querySelector('#toggle-files').focus()");
        await escape();
        await page.ready("!document.querySelector('#top-menu').open && document.activeElement.id === 'top-menu-trigger'");
        await assertContrastInThemes(page, [{ selector: '#top-menu-trigger', property: 'outlineColor', against: '.top' }]);
        await audit('#open-settings', '#settings-view');
        await selectSetting('mcp');
        await audit('#mcp-add', '#mcp-editor');
        await assertContrastInThemes(page, [
          { selector: '#mcp-editor-title' }, { selector: '#mcp-editor [name=name]' },
          { selector: '#mcp-editor [name=name]', property: 'borderTopColor', against: '#mcp-editor' },
        ]);
        await audit('#mcp-add-credential', '#mcp-editor');
        await audit('#mcp-editor details > summary', '#mcp-editor');
        await audit('#mcp-cancel', '#settings-view');
        await audit('#mcp-add', '#mcp-editor');
        await escape();
        await page.ready("!document.querySelector('#mcp-editor').open && document.activeElement.id === 'mcp-add'");
        // Restore the first settings section for the later navigation and reload checks.
        await selectSetting('assistant');
        await audit('#close-settings', '#chat-view');
        await audit('#shortcuts summary', '#shortcuts');
        await page.evaluate("document.querySelector('#shortcuts').open = false");
        const noOverflow = async (label: string) => {
          const size = await page.evaluate<{ scroll: number; client: number }>(`({
            scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
          })`);
          assert.ok(size.scroll <= size.client, `${label}: ${size.scroll} > ${size.client}`);
        };
        for (const [width, height] of [[390, 844], [768, 1024], [1440, 900]]) {
          const narrow = width < 800;
          await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          await page.ready(`innerWidth === ${width} && document.querySelector('#session-sidebar').hidden === ${narrow}`);
          for (const view of ['chat', 'settings', 'knowledge', 'jobs', 'review']) {
            await page.evaluate(`(() => {
              if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click();
              document.querySelector('#open-${view}').click();
            })()`);
            await page.ready(`!document.querySelector('#${view}-view').hidden`);
            assert.equal(await page.evaluate("document.querySelector('#session-sidebar').hidden"), narrow);
            await noOverflow(`${width} ${view}`);
            await assertUiTextInThemes(page, `#${view}-view`);
            if (view === 'settings') {
              assert.equal(await page.evaluate("document.querySelector('#settings-section').checkVisibility()"), narrow);
              for (const [section] of settingsPages) {
                await selectSetting(section);
                await noOverflow(`${width} ${section}`);
              }
              await selectSetting('assistant');
            }
            if (view === 'knowledge') {
              for (const name of ['overview', 'ask', 'quality', 'build']) {
                await page.evaluate(`document.querySelector('#knowledge-tab-${name}').click()`);
                await noOverflow(`${width} knowledge ${name}`);
              }
              await page.evaluate("document.querySelector('#knowledge-tab-overview').click()");
            }
          }
          await page.evaluate("document.querySelector('#open-chat').click()");
          if (narrow) {
            const targets = ['#toggle-sidebar', '#top-menu-trigger', '#pick', '#session-alias', '#send', '#shortcuts summary'];
            assert.deepEqual(await page.evaluate(`${JSON.stringify(targets)}.filter(selector => {
              const box = document.querySelector(selector).getBoundingClientRect();
              return box.width < 40 || box.height < 40 || box.left < 0 || box.right > innerWidth;
            })`), [], `${width} touch targets`);
            await openPanel('toggle-files');
            await page.ready(`document.querySelector('#chat-files').offsetWidth === ${width} &&
              document.querySelector('#chat-files').getAttribute('aria-modal') === 'true'`);
            await noOverflow(`${width} preview overlay`);
            await page.evaluate("document.querySelector('#close-files').click()");
          }
        }
        await page.command('Emulation.clearDeviceMetricsOverride');
      }
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
        await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 1, mobile: false });
        await page.ready('innerWidth === 390 && innerHeight === 420');
        await page.evaluate("document.querySelector('#prompt').focus()");
        assert.equal(await page.evaluate(`['#prompt', '#send'].every(selector => {
          const control = document.querySelector(selector);
          const { top, bottom, left, right } = control.getBoundingClientRect();
          return !control.disabled && top >= 0 && bottom <= innerHeight && left >= 0 && right <= innerWidth;
        })`), true, 'The composer fits the remaining viewport');
        await page.command('Emulation.clearDeviceMetricsOverride');
        await page.ready('innerWidth > 900');
        const artifactButton = "#chat-resources button[data-file*='/artifacts/']";
        const artifactTab = "#panel-tabs [role=tab][aria-selected=true]";
        const visiblePreview = "#file-preview [role=tabpanel]:not([hidden])";
        const clickArtifact = () => page.evaluate(`document.querySelector(${JSON.stringify(artifactButton)}).click()`);
        assert.equal(await page.evaluate("document.querySelector('#chat-files').hidden && getComputedStyle(document.querySelector('#chat-files')).display === 'none'"), true);
        const wideContent = await page.evaluate<number>("document.querySelector('#work-area').getBoundingClientRect().width");
        await clickArtifact();
        await page.ready(`document.activeElement.matches('${artifactTab}') && document.querySelector('#file-preview table')`);
        await assertContrastInThemes(page, [
          { selector: artifactTab }, { selector: `${visiblePreview} td` },
          { selector: `${visiblePreview} td`, property: 'borderTopColor', against: visiblePreview },
        ]);
        assert.ok(await page.evaluate<number>("document.querySelector('#work-area').getBoundingClientRect().width") < wideContent);
        assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('${visiblePreview} .file-actions a')].map(link => [link.textContent, link.target, Boolean(link.download)])`),
          [['在瀏覽器開啟', '_blank', false], ['下載', '', true]]);
        await tab();
        await page.ready("document.activeElement.matches('.close-tab')");
        await enter();
        await page.ready(`document.querySelector('#chat-files').hidden && document.activeElement.matches(${JSON.stringify(artifactButton)})`);
        await enter();
        await page.ready("!document.querySelector('#chat-files').hidden");
        await escape();
        assert.equal(await page.evaluate(`document.querySelector('#chat-files').hidden && document.activeElement.matches(${JSON.stringify(artifactButton)})`), true);
        assert.equal(await page.evaluate("document.querySelector('#work-area').getBoundingClientRect().width"), wideContent);

        await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 840, deviceScaleFactor: 1, mobile: false });
        await page.ready('innerWidth === 390');
        await clickArtifact();
        await page.ready(`(() => {
          const panel = document.querySelector('#chat-files');
          const bounds = panel.getBoundingClientRect();
          return panel.getAttribute('aria-modal') === 'true' && bounds.left === 0 && bounds.top === 0 &&
            bounds.width === innerWidth && bounds.height === innerHeight &&
            document.querySelector('#work-area').inert && document.querySelector('.navigation').inert;
        })()`);
        assert.equal(await page.evaluate("document.querySelector('#close-files').textContent"), '返回對話');
        await escape();
        assert.equal(await page.evaluate(`document.activeElement.matches(${JSON.stringify(artifactButton)}) && !document.querySelector('#work-area').inert`), true);
        if (capturePanels) {
          const originalTheme = await page.evaluate<string>('document.documentElement.dataset.theme');
          for (const [width, height, layout] of screenshotViewports) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await page.ready(`innerWidth === ${width}`);
            for (const theme of ['light', 'dark']) {
              await page.evaluate(`(() => {
                document.documentElement.dataset.theme = '${theme}';
                document.activeElement.blur();
                const messages = document.querySelector('#messages');
                messages.scrollTop = messages.scrollHeight;
              })()`);
              await capture(`conversation-${theme}-${layout}`);
              await clickArtifact();
              await page.ready(`document.querySelector('${visiblePreview} table')`);
              await capture(`conversation-artifact-${theme}-${layout}`);
              await escape();
            }
          }
          await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}`);
        }
        await page.command('Emulation.clearDeviceMetricsOverride');
        await page.ready("!matchMedia('(max-width: 800px)').matches");
        await assertUiTextInThemes(page);
        assert.equal(await page.evaluate("document.querySelectorAll('.tool-card').length"), 1);
        await page.evaluate("document.querySelector('.tool-card summary').click()");
        assert.equal(await page.evaluate("document.querySelector('.tool-card').open"), true);
        assert.equal(await page.evaluate("/sample-hidden-value|Z:\\/synthetic/.test(document.querySelector('.tool-details').textContent)"), false);
        assert.equal(await page.evaluate("!!document.querySelector('#messages table') && !!document.querySelector('#messages pre code')"), true);
        await assertContrastInThemes(page, [
          { selector: '.message > div pre code' }, { selector: '.message td' },
          { selector: '.message td', property: 'borderTopColor' },
        ]);
        assert.equal(await page.evaluate("!window.injected && !document.querySelector('#messages script, #messages img, #messages a[href^=javascript]')"), true);
        await page.evaluate(`
          document.querySelector('.tool-card summary').click();
          document.documentElement.dataset.beforeToolReload = 'true';
        `);
        await reload();
        await page.ready("!document.documentElement.dataset.beforeToolReload && document.querySelectorAll('.tool-card').length === 1");
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
        await assertUiTextInThemes(page, '.session-list details[open]');
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.dataset.action === 'remove'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.ready("document.activeElement.tagName === 'SUMMARY' && !document.activeElement.parentElement.open");
        await assertNativeDialogTextInThemes(page, '.session-list [aria-current=true] + details [data-action=rename]', 'prompt');
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
        await reload();
        await page.ready(`!document.documentElement.dataset.beforeSettingsReload &&
          document.querySelector('#assistant-name')?.value === '合成助理'`);
        assert.equal(await page.evaluate("document.querySelector('#assistant-introduction').value"), '測試簡介');
        assert.equal(await page.evaluate("document.querySelector('#assistant-instructions').value"), '使用繁體中文');
        await page.ready(`document.querySelector('[aria-current=true]')?.dataset.session === ${JSON.stringify(selected)} &&
          document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.density === 'compact' &&
          document.querySelector('#session-title').textContent === '合成會話'`);
        await page.evaluate(`
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
        `);
        await assertUiTextInThemes(page, '#remove-session-card');
        await assertContrastInThemes(page, [{ selector: '#remove-session-question' }, { selector: '#remove-session-card [value=accept]' }]);
        await escape();
        await page.ready("!document.querySelector('#remove-session-card').open && document.activeElement.matches('.session-list summary')");
        await page.evaluate(`
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
          document.querySelector('#remove-session-card [value=reject]').click();
        `);
        assert.equal(await page.evaluate("document.querySelector('[aria-current=true]')?.dataset.session"), selected);
        await page.ready(`fetch('/api/sessions/' + ${JSON.stringify(selected)} + '/action-decisions')
          .then(response => response.json()).then(rows => rows.some(row => row.decision === 'reject'))`);
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
        await reload();
        await page.ready("document.querySelector('.sidebar-assistant img')?.naturalWidth > 0 && document.querySelector('#messages .assistant-avatar img')?.naturalWidth > 0");
        await page.evaluate("document.querySelector('#avatar-reset').click(); document.querySelector('#appearance-settings').requestSubmit()");
        await page.ready("document.querySelector('#appearance-status').textContent === '已儲存' && !document.querySelector('.sidebar-assistant img')");
        await page.evaluate("document.querySelector('#recheck-model').click()");
        await page.ready("document.querySelector('#model-settings-status').textContent === '已重新檢查'");
        await assertUiTextInThemes(page);
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
        await reload();
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
        await page.evaluate("document.querySelector('#assistant-name').value = '未儲存的名稱'");
        await assertNativeDialogTextInThemes(page, '[data-section=appearance]', 'confirm');
        await page.evaluate(`
          window.confirm = () => false;
          document.querySelector('#assistant-name').value = '未儲存的名稱';
          document.querySelector('[data-section=appearance]').click();
        `);
        assert.equal(await page.evaluate("document.querySelector('#settings-appearance').hidden"), true);
        await escape();
        assert.equal(await page.evaluate(`!document.querySelector('#settings-view').hidden &&
          !document.querySelector('#settings-assistant').hidden &&
          document.querySelector('#assistant-name').value === '未儲存的名稱'`), true);
        await page.evaluate("window.confirm = () => true");
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.ready("document.activeElement.dataset.section === 'appearance'");
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
        await page.ready("!document.querySelector('#settings-appearance').hidden");
        assert.equal(await page.evaluate("document.querySelector('#assistant-name').value"), '合成助理');

        assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#settings-nav button')]
          .map(button => [button.dataset.section, button.textContent])`), settingsPages.map(([section, title]) => [section, title]));
        const expectSetting = async (section: string, title: string) => {
          assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.settings-content > section:not([hidden])')]
            .map(panel => [panel.id, panel.querySelector('h2').textContent])`), [[`settings-${section}`, title]]);
          assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#settings-nav [aria-current="page"], #settings-section option[aria-current="page"]')]
            .map(entry => entry.dataset.section ?? entry.value)`), [section, section]);
        };
        await assertUiTextInThemes(page, '#settings-view');
        const mapping = mappingChecks(page, 'settings');
        for (const [section, title, controls] of settingsPages) {
          await click(`#settings-nav [data-section="${section}"]`);
          await expectSetting(section, title);
          if (section === 'integrations') {
            await page.ready(`[...document.querySelectorAll('#telegram-main-status, #telegram-bi-status')]
              .every(status => /^(已設定|未設定)$/.test(status.textContent))`);
          }
          if (section === 'mcp') await page.ready("document.querySelector('#mcp-servers').children.length > 0");
          await assertUiTextInThemes(page, `#settings-${section}`);
          await assertContrastInThemes(page, [
            { selector: `#settings-${section} h2` }, { selector: `#settings-${section} .settings-help` },
            { selector: '#close-settings', property: 'borderTopColor', against: '#settings-view' },
          ]);
          const disclosures = `#settings-${section} > details.settings-advanced`;
          await page.evaluate(`document.querySelectorAll('${disclosures}').forEach(details => { details.open = true; })`);
          await assertUiTextInThemes(page, `#settings-${section}`);
          for (const [row, selectors] of Object.entries(settingsRows[section])) {
            await mapping.check('settings-' + row, `#settings-${section}`, { selectors });
          }
          await page.evaluate(`document.querySelectorAll('${disclosures}').forEach(details => { details.open = false; })`);
          for (const control of controls) {
            assert.equal(await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(`#settings-${section} ${control}`)}))`), true, control);
          }
        }
        await page.evaluate("document.querySelector('#close-settings').focus()");
        for (const [section, title] of settingsPages) {
          await tab();
          await page.ready(`document.activeElement.dataset.section === ${JSON.stringify(section)}`);
          await enter();
          await expectSetting(section, title);
        }
        assert.equal(await page.evaluate(`document.querySelector('.settings-heading').parentElement
          === document.querySelector('#work-area > #settings-view') &&
          document.querySelector('#chat-view').hidden && document.querySelector('#chat-files').hidden`), true);

        const settingFolder = realpathSync(mkdtempSync(join(dataDirectory(), 'setting-folder-')));
        await click('#settings-nav [data-section="projects"]');
        await page.evaluate(`document.querySelector('#project-folder').value = ${JSON.stringify(settingFolder)}`);
        await click('#project-folder-form button[type=submit]');
        await page.ready("document.querySelector('#project-folder-status').textContent === '已加入唯讀資料夾。'");
        await page.ready("document.querySelector('#project-folder-list li button')?.textContent === '移除'");
        await mapping.check('settings-project-folders', '#settings-projects', {
          selectors: ['#project-folder', '#project-folder-status'], labels: ['加入唯讀資料夾', '移除'],
        });
        await reload();
        await page.ready("document.querySelector('#connection').textContent === '已連線'");
        await click('#open-settings');
        await expectSetting('projects', '專案與資料夾');
        await page.ready("document.querySelector('#project-folder-list li button')?.textContent === '移除'");
        assert.equal(await page.evaluate(`document.querySelector('#project-read-folder option').value === ${JSON.stringify(settingFolder)}`), true);
        await click('#project-folder-list li button');
        await page.ready("document.querySelector('#project-folder-status').textContent === '已移除唯讀資料夾。'");
        await page.ready("!document.querySelector('#project-read-folder option')");
        mapping.finish();

        await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 960, deviceScaleFactor: 1, mobile: false });
        assert.deepEqual(await page.evaluate(`[...document.querySelector('#settings-section').options]
          .map(option => [option.value, option.label])`), settingsPages.map(([section, title]) => [section, title]));
        assert.equal(await page.evaluate(`document.querySelector('#settings-section').checkVisibility() &&
          !document.querySelector('#settings-nav button').checkVisibility() &&
          document.querySelector('#settings-section').value === 'projects'`), true);
        await page.evaluate("document.querySelector('#close-settings').focus()");
        await tab();
        await page.ready("document.activeElement.id === 'settings-section'");
        await key('ArrowDown', 'ArrowDown', 40);
        await expectSetting('integrations', '整合');
        await assertUiTextInThemes(page, '#settings-view');
        await page.command('Emulation.clearDeviceMetricsOverride');
        await click('#settings-nav [data-section="appearance"]');

        const saveSettingsShots = captureGallery || process.env.OEP_CAPTURE_SETTINGS_PAGE === '1';
        const settingsPaths = ['#project-working-root', '#about-details dd:nth-of-type(2)'];
        const originalPaths = saveSettingsShots ? await page.evaluate<string[]>(`(() => {
          const syntheticPaths = ['工作資料夾 · C:/OEP/合成工作區', 'C:/OEP/合成資料'];
          return ${JSON.stringify(settingsPaths)}.map((selector, index) => {
            const element = document.querySelector(selector);
            const original = element.textContent;
            element.textContent = syntheticPaths[index];
            return original;
          });
        })()`) : [];
        const capturedSections = saveSettingsShots ? settingsPages.map(([section]) => section)
          : ['assistant', 'appearance', 'model', 'limits', 'runtime', 'integrations'];
        for (const [width, height, layout] of screenshotViewports) {
          await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
          for (const theme of ['light', 'dark']) {
            await page.evaluate(`
              document.querySelector('#appearance-status').textContent = '';
              document.querySelector('#theme').value = ${JSON.stringify(theme)};
              document.querySelector('#appearance-settings').requestSubmit();
            `);
            await page.ready("document.querySelector('#appearance-status').textContent === '已儲存'");
            for (const section of capturedSections) {
              await selectSetting(section);
              assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
              const name = `settings-${section}-${theme}-${layout}`;
              await capture(name);
              if (saveSettingsShots && !captureGallery) copyFileSync(join(audit, name + '.png'), join('docs', 'validation', 'gui', name + '.png'));
            }
          }
        }
        if (saveSettingsShots) await page.evaluate(`${JSON.stringify(settingsPaths)}.forEach((selector, index) => {
          document.querySelector(selector).textContent = ${JSON.stringify(originalPaths)}[index];
        })`);
        await page.evaluate("document.querySelector('#open-chat').click()");
        await page.command('Emulation.clearDeviceMetricsOverride');
        const captureLayouts = async (running: boolean) => {
          for (const [width, height, layout] of screenshotViewports) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
            if (layout === 'narrow') await page.ready("matchMedia('(max-width: 800px)').matches && document.querySelector('#session-sidebar').hidden");
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
                if (!capturePanels) await capture(`conversation-${theme}-${layout}`);
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
          await page.evaluate(`(() => {
            document.querySelector('#panel-tabs [id^="tab-preview-"][aria-selected=true]')?.parentElement.querySelector('.close-tab').click();
            const row = [...document.querySelectorAll('#attachments li')].find(row => row.querySelector('label')?.textContent === ${JSON.stringify(name)});
            row.querySelector('button[aria-label^="預覽"]').click();
          })()`);
        };
        await openPanel('toggle-files');
        await openPanel('open-work');
        await page.evaluate("document.querySelector('#tab-files').click()");
        await page.ready("document.querySelector('#toggle-files').getAttribute('aria-expanded') === 'true'");
        await assertUiTextInThemes(page);
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
        await page.ready("document.activeElement.id === 'tab-work' && document.querySelector('#panel-runs').textContent.includes('已完成')");
        await assertUiTextInThemes(page, '#chat-files');
        await reload();
        await page.ready("document.querySelector('#connection').textContent === '已連線' && document.querySelector('#chat-files').hidden && !document.querySelector('#panel-tabs').children.length");
        await openPanel('open-work');
        await page.ready("document.querySelector('#tab-work').getAttribute('aria-selected') === 'true'");
        await page.ready("document.querySelector('#panel-jobs').textContent.includes('知識庫工作')");
        await assertUiTextInThemes(page);
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

        await openPanel('toggle-files');
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
          for (const [width, height, layout] of screenshotViewports) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await page.ready(`innerWidth === ${width}`);
            for (const theme of ['light', 'dark']) {
              await page.evaluate(`(() => {
                const theme = document.querySelector('#theme');
                theme.value = ${JSON.stringify(theme)};
                theme.dispatchEvent(new Event('change'));
                window.scrollTo(0, 0);
                document.querySelector('#chat-files').scrollTop = 0;
              })()`);
              if (layout === 'narrow') {
                await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
                await page.ready("document.querySelector('#chat-files').getAttribute('aria-modal') === 'true'");
              }
              const screenshot = async (view: string) => {
                if (layout === 'narrow') {
                  await page.ready(`(() => {
                    const bounds = document.querySelector('#chat-files').getBoundingClientRect();
                    return bounds.height === innerHeight && bounds.width === innerWidth && bounds.top === 0 && bounds.left === 0;
                  })()`);
                }
                await capture(`right-panel-${view}-${theme}-${layout}`);
              };
              if (diff) {
                await screenshot('diff');
                continue;
              }
              await page.evaluate("document.querySelector('#panel-tabs [id^=tab-preview-]')?.parentElement.querySelector('.close-tab').click(); document.querySelector('#tab-files').click()");
              await screenshot('files');
              await openPanel('open-work');
              await page.ready("document.querySelector('#panel-jobs').textContent.includes('知識庫工作')");
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
        if (capturePanels) await panelLayouts(false);
        const downloaded = await page.evaluate<{ href: string; hash: string }>(`(() => {
          const row = [...document.querySelectorAll('#attachments li')].find(row => row.textContent.includes('sample.txt'));
          const link = row.querySelector('a');
          link.click();
          return { href: link.getAttribute('href'), hash: row.querySelector('details button').title };
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
        await assertNativeDialogTextInThemes(page, '#attachments', 'confirm', '移除');
        await page.evaluate(`(() => {
          window.confirm = () => true;
          [...document.querySelectorAll('#attachments li')].find(row => row.textContent.includes('sample.txt'))
            .querySelectorAll('.file-actions button')[1].click();
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
        await openPanel('open-diff');
        await page.evaluate("document.querySelector('#panel-diff button').click()");
        await page.ready("document.querySelector('#panel-diff').textContent.includes('1 個儲存格') && document.querySelectorAll('.changed-cell').length === 1");
        await assertContrastInThemes(page, [
          { selector: '#tab-diff' }, { selector: '.changed-cell del' }, { selector: '.changed-cell ins' },
          { selector: '#tab-diff', property: 'borderTopColor', against: '.panel-header' },
        ]);
        await assertUiTextInThemes(page);
        if (capturePanels) await panelLayouts(true);
        await page.evaluate("document.querySelector('#tab-diff').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
        assert.equal(await page.evaluate("document.activeElement.id === 'top-menu-trigger' && document.querySelector('#chat-files').hidden"), true);
        await page.evaluate(`
          const prompt = document.querySelector('#prompt');
          prompt.focus();
          prompt.value = '/';
          prompt.dispatchEvent(new Event('input'));
        `);
        await page.ready("!document.querySelector('#slash-palette').hidden && document.querySelectorAll('#slash-palette [role=option]').length === 8");
        await assertUiTextInThemes(page, '#slash-palette');
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
        await page.ready("document.querySelector('#slash-palette [aria-selected=true]').textContent.includes('/help')");
        await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await page.ready("document.querySelector('#command-toast').textContent.includes('/clear-search')");
        await assertUiTextInThemes(page, '#command-toast');
        await page.evaluate(`
          document.querySelector('#prompt').value = '/unknown';
          document.querySelector('#composer').requestSubmit();
        `);
        await page.ready("document.querySelector('#error').textContent.includes('無法辨識')");
        await assertUiTextInThemes(page, '#error');
        await page.evaluate("document.querySelector('.message.assistant .message-actions > summary').click()");
        await assertUiTextInThemes(page, '.message.assistant .message-actions[open]');
        for (const label of ['讚', '倒讚', '新增或編輯筆記']) {
          await assertNativeDialogTextInThemes(page, '.message.assistant .message-actions', 'prompt', label);
        }
        await page.evaluate(`
          const menu = [...document.querySelectorAll('.message.assistant')].find(message => message.textContent.includes('合成量測摘要')).querySelector('.message-actions');
          window.prompt = () => '合成筆記';
          [...menu.querySelectorAll('button')].find(button => button.textContent === '新增或編輯筆記').click();
        `);
        await openPanel('open-notes');
        await page.ready("document.querySelector('#session-notes').textContent.includes('合成筆記')");
        await assertUiTextInThemes(page, '#panel-notes');
        await page.evaluate(`(() => {
          window.prompt = () => '未選取的合成筆記';
          [...document.querySelector('.message.user .message-actions').querySelectorAll('button')]
            .find(button => button.textContent === '新增或編輯筆記').click();
        })()`);
        await page.ready("document.querySelectorAll('#session-notes input').length === 2");
        await page.evaluate(`
          [...document.querySelectorAll('#session-notes label')].find(label => label.textContent === '合成筆記').querySelector('input').click();
          document.querySelector('#export-notes').click();
          document.querySelector('#notes-filter').value = 'rated';
          document.querySelector('#notes-filter').dispatchEvent(new Event('change'));
        `);
        assert.equal(await page.evaluate("document.querySelectorAll('#session-notes li:not(.empty)').length"), 0);
        await until(async () => existsSync(join(downloads, 'notes.md')) || undefined, 8_000);
        const exportedNotes = readFileSync(join(downloads, 'notes.md'), 'utf8');
        assert.match(exportedNotes, /合成筆記/);
        assert.doesNotMatch(exportedNotes, /未選取的合成筆記/);
        await page.evaluate(`(() => {
          const actions = [...[...document.querySelectorAll('.message.assistant')].find(message => message.textContent.includes('合成量測摘要')).querySelector('.message-actions').querySelectorAll('button')];
          window.prompt = () => '合成原因';
          actions.find(button => button.textContent === '讚').click();
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: async text => { window.syntheticClipboard = text; },
          } });
          actions.find(button => button.textContent === '複製文字').click();
        })()`);
        await page.ready("window.syntheticClipboard?.includes('合成量測摘要') && document.querySelector('#session-notes').textContent.includes('合成原因')");

        await page.evaluate(`
          var reference = [...document.querySelectorAll('.message.assistant')].find(message => message.textContent.includes('合成量測摘要'));
          [...reference.querySelectorAll('.message-actions button')].find(button => button.textContent === '回覆這則訊息').click();
          document.querySelector('#prompt').value = 'SYNTHETIC_REPLY_CONTEXT';
          document.querySelector('#workbook').checked = false;
          document.querySelector('#composer').requestSubmit();
        `);
        await page.ready("document.querySelector('#messages').textContent.includes('已核對合成引用') && document.querySelector('.message-quote')?.textContent.includes('合成量測摘要')", 30_000);
        await reload();
        await page.ready("document.querySelector('.message-quote')?.textContent.includes('合成量測摘要') && document.querySelector('#session-notes').textContent.includes('合成筆記')");
        const folder = mkdtempSync(resolve('.phase0/synthetic-folder-'));
        syntheticReadOnlyFile = join(folder, 'sample.txt');
        writeFileSync(syntheticReadOnlyFile, 'SYNTHETIC_READ_ONLY');
        const linked = join(mkdtempSync(resolve('.phase0/synthetic-folder-link-')), 'junction');
        symlinkSync(folder, linked, process.platform === 'win32' ? 'junction' : 'dir');
        const folderChecks = await page.evaluate<number[]>(`(async () => {
          const csrf = (await fetch('/api/bootstrap').then(response => response.json())).csrf;
          const post = (path, data) => fetch(path, { method: 'POST', headers: {
            'X-OEP-CSRF': csrf, 'Content-Type': 'application/json',
          }, body: JSON.stringify(data) }).then(response => response.status);
          const settings = '/api/settings/projects';
          const folder = ${JSON.stringify(folder)};
          const results = [];
          for (const candidate of ['relative', folder + '/missing', folder + '/sample.txt', ${JSON.stringify(linked)}, ${JSON.stringify('\\example.invalid\public')}, ${JSON.stringify(process.env.SystemRoot)}]) {
            results.push(await post(settings, { project: 'default', action: 'add', folder: candidate }));
          }
          results.push(await post(settings, { project: 'default', action: 'add', folder }));
          results.push(await post(settings, { project: 'secondary', action: 'add', folder }));
          results.push(await post('/api/projects/default/sessions/' + ${JSON.stringify(selected)} + '/read-project-file', { folder, file: 'sample.txt' }));
          results.push(await post('/api/projects/secondary/sessions/' + ${JSON.stringify(other)} + '/read-project-file', { folder, file: 'sample.txt' }));
          return results;
        })()`);
        assert.deepEqual(folderChecks, [400, 400, 400, 400, 400, 400, 200, 409, 201, 404]);
        await page.evaluate(`
          document.querySelector('#prompt').value = 'SYNTHETIC_FOLDER_WRITE';
          document.querySelector('#composer').requestSubmit();
        `);
        await page.ready("document.querySelector('#messages').textContent.includes('SYNTHETIC_FOLDER_WRITE') && ['已完成','這次處理未完成'].includes(document.querySelector('#progress').textContent) && !document.querySelector('#send').disabled", 30_000);
        assert.equal(readFileSync(join(folder, 'sample.txt'), 'utf8'), 'SYNTHETIC_READ_ONLY');
        await reload();
        await page.ready("document.querySelector('#project-read-folder option') && document.querySelector('.message-quote')");
        await page.evaluate("document.querySelector('#project-read').open = true");
        await assertUiTextInThemes(page, '#project-read');
        await page.evaluate("document.querySelector('#project-read').open = false");


        await page.evaluate(`
          document.querySelector('#open-settings').click();
          document.querySelector('[data-section=input]').click();
          document.querySelector('#enable-microphone').click();
          document.querySelector('[data-section=about]').click();
        `);
        await page.ready("document.querySelector('#about-details').textContent.includes('MIT')");
        await page.evaluate(`
          document.querySelector('#close-settings').click();
          window.SpeechRecognition = class {
            start() {
              queueMicrotask(() => {
                if (window.syntheticSpeechError) this.onerror({ error: window.syntheticSpeechError });
                else this.onresult({ resultIndex: 0, results: [[{ transcript: '合成語音' }]] });
                this.onend();
              });
            }
            abort() {}
          };
          document.querySelector('#microphone').click();
        `);
        await page.ready("document.querySelector('#prompt').value === '合成語音'");
        for (const [error, label] of [['not-allowed', '請在瀏覽器允許麥克風權限'], ['network', '無法完成聽寫']]) {
          await page.evaluate(`window.syntheticSpeechError = ${JSON.stringify(error)}; document.querySelector('#microphone').click()`);
          await page.ready(`document.querySelector('#error').textContent.includes(${JSON.stringify(label)})`);
        }
        const annotationIsolation = await page.evaluate<number[]>(`(async () => {
          const first = '/api/projects/default/sessions/' + ${JSON.stringify(selected)};
          const second = '/api/projects/secondary/sessions/' + ${JSON.stringify(other)};
          const state = await fetch(first + '/state').then(response => response.json());
          const csrf = (await fetch('/api/bootstrap').then(response => response.json())).csrf;
          const messageID = state.annotations.find(row => row.note === '合成筆記').messageID;
          const post = (path, data) => fetch(path + '/annotation', { method: 'POST', headers: {
            'X-OEP-CSRF': csrf, 'Content-Type': 'application/json',
          }, body: JSON.stringify({ messageID, ...data }) });
          const foreign = await post(second, { field: 'note', value: '合成跨專案' });
          const edit = await post(first, { field: 'note', value: '合成修改' }).then(response => response.json());
          const removed = await post(first, { field: 'rating', value: null }).then(response => response.json());
          await post(first, { field: 'rating', value: 'up', reason: '合成原因' });
          const deleted = await post(first, { field: 'note', value: null }).then(response => response.json());
          await post(first, { field: 'note', value: '合成筆記' });
          return [foreign.status, Number(edit.annotations.some(row => row.note === '合成修改')),
            Number(removed.annotations.some(row => row.messageID === messageID && row.rating === null)),
            Number(deleted.annotations.some(row => row.messageID === messageID && row.note === null))];
        })()`);
        assert.deepEqual(annotationIsolation, [404, 1, 1, 1]);
        await page.ready("document.querySelector('#session-notes').textContent.includes('合成筆記')");
        if (captureGallery || process.env.OEP_CAPTURE_SLICE2D === '1') {
          const shots = resolve('docs/validation/gui');
          const shot = async (view: string, theme: string, layout: string) => {
            const name = `slice2d-${view}-${theme}-${layout}`;
            await capture(name);
            if (!captureGallery) writeFileSync(join(shots, name + '.png'), readFileSync(join(audit, name + '.png')));
          };
          for (const [width, height, layout] of screenshotViewports) {
            await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            for (const theme of ['light', 'dark']) {
              await page.evaluate(`(() => {
                document.documentElement.dataset.theme = ${JSON.stringify(theme)};
                document.querySelector('#error').hidden = true;
                const prompt = document.querySelector('#prompt');
                prompt.focus();
                prompt.value = '/';
                prompt.dispatchEvent(new Event('input'));
                document.querySelector('#composer').scrollIntoView({ block: 'end' });
              })()`);
              await shot('slash', theme, layout);
              await page.evaluate(`(() => {
                const prompt = document.querySelector('#prompt');
                prompt.value = '';
                prompt.dispatchEvent(new Event('input'));
                const menu = [...document.querySelectorAll('.message.assistant')].find(message => message.textContent.includes('合成量測摘要')).querySelector('.message-actions');
                menu.open = true;
                menu.querySelector('summary').focus();
                menu.scrollIntoView({ block: 'center' });
              })()`);
              await shot('message-menu', theme, layout);
              await page.evaluate(`(() => {
                [...document.querySelectorAll('.message.assistant')].find(message => message.textContent.includes('合成量測摘要')).querySelector('.message-actions').open = false;
                document.querySelector('.message-quote').scrollIntoView({ block: 'center' });
              })()`);
              await shot('reply', theme, layout);
              await openPanel('open-notes');
              await shot('notes', theme, layout);
              await page.evaluate(`
                if (!document.querySelector('#chat-files').hidden) document.querySelector('#close-files').click();
                if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click();
                document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
              `);
              await shot('action', theme, layout);
              await page.evaluate(`
                document.querySelector('#remove-session-card [value=reject]').click();
                document.querySelector('#open-settings').click();
                document.querySelector('#project-working-root').textContent = '工作資料夾 · C:/OEP/合成工作區';
                var folderRow = document.querySelector('#project-folder-list li');
                if (folderRow?.firstChild) folderRow.firstChild.textContent = 'C:/OEP/合成唯讀資料';
                var aboutPath = document.querySelector('#about-details dd:nth-of-type(2)');
                if (aboutPath) aboutPath.textContent = 'C:/OEP/合成資料';
              `);
              for (const section of ['input', 'projects', 'about']) {
                await selectSetting(section);
                assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
                await shot(section, theme, layout);
              }
              await page.evaluate("document.querySelector('#close-settings').click()");
            }
          }
          await page.command('Emulation.clearDeviceMetricsOverride');
        }
        await page.evaluate("if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click()");
        await page.evaluate(`
          document.querySelector('[aria-current=true]').nextElementSibling.querySelector('[data-action=remove]').click();
          document.querySelector('#remove-session-card [value=accept]').click();
        `);
        await page.ready(`!Array.from(document.querySelectorAll('#sessions [data-session]'))
          .some((option) => option.dataset.session === ${JSON.stringify(selected)})`);
        assert.equal(await page.evaluate(`fetch('/api/sessions/' + ${JSON.stringify(selected)} + '/state')
          .then((response) => response.status)`), 404);
        assert.equal(await page.evaluate("document.querySelectorAll('#sessions [data-session]').length"), cases.length - 1);
        assert.equal(await page.evaluate("fetch('/api/projects/secondary/sessions').then(r => r.json()).then(rows => rows.length)"), 1);
        const decisions = new DatabaseSync(join(root, 'web.sqlite'), { readOnly: true });
        try {
          const rows = decisions.prepare('SELECT decision FROM web_action_decisions WHERE session_id = ? ORDER BY id').all(selected);
          assert.equal(rows[0]?.decision, 'reject');
          assert.equal(rows.at(-1)?.decision, 'accept');
        } finally { decisions.close(); }
        async function slash(command: string) {
          await page.evaluate(`
            document.querySelector('#prompt').value = ${JSON.stringify(command)};
            document.querySelector('#composer').requestSubmit();
          `);
        }
        await slash('/new');
        await page.ready("document.querySelector('#command-toast').textContent.includes('已新增會話')");
        await page.evaluate(`
          document.querySelector('#file-input').click = () => { window.syntheticPicker = true; };
        `);
        await slash('/attach');
        await page.ready('window.syntheticPicker === true');
        await slash('/theme light');
        await page.ready("document.documentElement.dataset.theme === 'light'");
        await page.evaluate("document.querySelector('#command-toast button')?.click()");
        await page.ready("document.querySelector('#command-toast').textContent.includes('已復原')");
        await slash('/model ' + gatewayAliases[1]);
        await page.ready(`document.querySelector('#command-toast').textContent.includes('已切換模型') && document.querySelector('#model').textContent.includes(${JSON.stringify(gatewayAliases[1])})`);
        await page.evaluate(`
          document.querySelector('#session-search').value = '合成搜尋';
          document.querySelector('#session-search').dispatchEvent(new Event('input'));
        `);
        await slash('/clear-search');
        await page.ready("document.querySelector('#session-search').value === ''");
        await page.evaluate("document.querySelector('#command-toast button')?.click()");
        await page.ready("document.querySelector('#session-search').value === '合成搜尋'");
        slowStarted = false;
        await page.evaluate(`
          document.querySelector('#prompt').value = 'SYNTHETIC_SLOW_TURN';
          document.querySelector('#composer').requestSubmit();
        `);
        await until(async () => slowStarted || undefined, 8_000);
        await slash('/stop');
        await page.ready("document.querySelector('#command-toast').textContent.includes('已送出停止要求') && document.querySelector('#progress').textContent.includes('已停止')");

      }
      await page.evaluate("document.querySelector('#top-menu-trigger').click(); document.querySelector('#stop').click()");
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
