import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { samplePlugin } from '../fixtures/plugins/package.ts';
import type { chromium } from './chromium.ts';
import { assertWorkbenchFits, inLocales } from './gui-locales.ts';
import { mappingChecks } from './gui-mapping.ts';

export async function verifyCapabilityWorkbench(page: Awaited<ReturnType<typeof chromium>>, root: string) {
  const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const putFile = async (selector: string, filename: string) => {
    const { root: documentRoot } = await page.command<{ root: { nodeId: number } }>('DOM.getDocument');
    const { nodeId } = await page.command<{ nodeId: number }>('DOM.querySelector', { nodeId: documentRoot.nodeId, selector });
    await page.command('DOM.setFileInputFiles', { nodeId, files: [filename] });
  };
  const acceptPlugin = async () => {
    await page.ready('document.querySelector("#plugin-dialog").open');
    await page.evaluate(`{
      const dialog = document.querySelector('#plugin-dialog');
      for (const box of dialog.querySelectorAll('input[type=checkbox]')) box.click();
      dialog.querySelector('button:last-child').click();
    }`);
    await page.ready('!document.querySelector("#plugin-dialog").open');
  };
  const mapping = mappingChecks(page, 'capabilities');
  await click('#open-capabilities');
  await page.ready("document.activeElement.id === 'capabilities-title' && document.querySelector('#capability-plugins').getAttribute('aria-selected') === 'true'");
  await mapping.check('capabilities-navigation', '#main-features', { selectors: ['#open-capabilities'] });
  await mapping.check('capabilities-plugins', '#capability-plugin-panel', { selectors: ['#install-plugin.button-primary', '#plugins-list', '#plugins-status'] });
  const plugin = join(root, 'capability-fixture.oepplugin');
  writeFileSync(plugin, samplePlugin());
  await page.evaluate(`document.querySelector('#plugin-file').addEventListener('click', (event) => {
    event.preventDefault(); window.syntheticPluginPicker = true;
  }, { once: true })`);
  await click('#install-plugin');
  assert.equal(await page.evaluate('window.syntheticPluginPicker'), true);
  await putFile('#plugin-file', plugin);
  await acceptPlugin();
  await page.ready("document.querySelector('#plugins-list').textContent.includes('1.0.0')");

  await click('#capability-skills');
  await page.ready("document.querySelector('#skills-list').textContent.includes('hermes-test-driven-development')");
  await mapping.check('capabilities-skills', '#capability-skill-panel', { selectors: ['#install-skill', '#pick-skill-folder', '#skill-assistant', '#skills-list input:checked'] });
  const encoded = Buffer.from(samplePlugin({ version: '1.1.0' })).toString('base64');
  await page.evaluate(`{
    const files = new DataTransfer();
    files.items.add(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}), char => char.charCodeAt(0))], 'update.oepplugin'));
    document.querySelector('#capabilities-view').dispatchEvent(new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true }));
  }`);
  await acceptPlugin();
  await page.ready("document.querySelector('#capability-plugins').getAttribute('aria-selected') === 'true' && document.querySelector('#plugins-list').textContent.includes('1.1.0')");
  await click('#plugins-list .plugin-actions button:last-child');
  await acceptPlugin();
  await page.ready("!document.querySelector('#plugins-list .plugin-row')");

  await click('#capability-workflows');
  const workflow = join(root, 'capability-workflow.json');
  writeFileSync(workflow, JSON.stringify({ metadata: { identity: { namespace: 'synthetic', name: 'browser-preview', version: '1.0.0' } },
    description: 'A synthetic workflow preview.', parameters: [{ name: 'fixture-unit', type: 'text' }],
    steps: [{ capability: 'synthetic/catalog@1.0.0', inputs: {} }] }));
  await putFile('#workflow-file', workflow);
  await page.ready("document.querySelector('#workflows-list summary')?.textContent.includes('browser-preview')");
  await click('#workflows-list summary');
  assert.match(await page.evaluate<string>("document.querySelector('#workflows-list').innerText"), /fixture-unit[\s\S]*synthetic\/catalog/u);
  await mapping.check('capabilities-workflows', '#capability-workflow-panel', { selectors: ['#import-workflow', '#workflows-list details pre', '#workflows-status'] });
  await mapping.check('capabilities-knowledge', '#capability-knowledge-panel', { selectors: ['#import-published-knowledge', '#pick-published-knowledge-folder', '#published-knowledge-consent', '#published-knowledge-list'] });
  await mapping.check('capabilities-mcp', '#capability-mcp-panel', { selectors: ['#mcp-add', '#mcp-import', '#mcp-servers', '#mcp-restart-bar #mcp-restart', '#mcp-status'] });

  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await page.ready('innerWidth === 390 && document.querySelector("#session-sidebar").hidden');
  await page.evaluate("document.querySelector('#capability-workflows').focus()");
  await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await page.ready("document.activeElement.id === 'capability-knowledge' && !document.querySelector('#capability-knowledge-panel').hidden");
  await inLocales(page, async (locale) => {
    assert.equal(await page.evaluate("document.querySelector('#capabilities-title').textContent"), locale === 'en' ? 'Capabilities' : '能力');
    assert.equal(await page.evaluate("document.querySelector('#capability-knowledge-panel h2').textContent"),
      locale === 'en' ? 'Import a knowledge base' : '知識庫匯入');
  });
  await assertWorkbenchFits(page, 'Capabilities narrow');
  await page.command('Emulation.clearDeviceMetricsOverride');
  await page.ready('!document.querySelector("#session-sidebar").hidden');
  await click('#open-chat');
  mapping.finish();
}
