import assert from 'node:assert/strict';
import type { chromium } from './chromium.ts';
import type { webAPI } from './web-api.ts';
import { assertWorkbenchFits, selectLocale } from './gui-locales.ts';

type Options = {
  page: Awaited<ReturnType<typeof chromium>>;
  api: Awaited<ReturnType<typeof webAPI>>;
  key: (key: string, code: string, windowsVirtualKeyCode: number) => Promise<void>;
  reload: () => Promise<void>;
  selectSetting: (section: string) => Promise<unknown>;
};

export async function verifyExternalHelpersInBrowser({ page, api, key, reload, selectSetting }: Options) {
  const enter = () => key('Enter', 'Enter', 13);
  const escape = () => key('Escape', 'Escape', 27);
  const focus = async (selector: string) => {
    const target = 'document.querySelector(' + JSON.stringify(selector) + ')';
    await page.ready(target + '?.checkVisibility() && !' + target + '.disabled');
    await page.evaluate(target + '.focus()');
  };
  const activate = async (selector: string) => { await focus(selector); await enter(); };
  const dialog = 'dialog.external-dialog[open]';
  const accept = dialog + ' button[type=submit]';
  const closePanel = 'document.querySelector("#chat-files").hidden';
  const settings = '#external-helper-settings fieldset:first-child';
  const json = async (response: Response, status = 200) => {
    assert.equal(response.status, status);
    return response.json();
  };
  const session = await json(await api.post('/api/sessions', { agent: 'inspector' }), 201);
  const path = '/api/sessions/' + session.id;
  await page.evaluate('localStorage.setItem("oep.activeSession", ' + JSON.stringify(session.id) + ')');
  await reload();
  await page.evaluate('document.querySelector("#open-settings").click()');
  await selectSetting('projects');
  await page.ready('!!document.querySelector("#project-classification button")');
  await activate('#project-classification button');
  await page.ready('!!document.querySelector(' + JSON.stringify(dialog) + ')');
  await activate(accept);
  await page.ready('!!document.querySelector("#project-classification [data-classification=public]")');

  for (const locale of ['zh-TW', 'en'] as const) {
    for (const width of [1440, 390]) {
      await page.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await selectLocale(page, locale);
      const labels = locale === 'zh-TW'
        ? { enable: '確認啟用', mark: '標為公開', confirm: '確認交辦', warning: '傳送至 Codex' }
        : { enable: 'Confirm enable', mark: 'Mark public', confirm: 'Confirm delegation', warning: 'sent to Codex' };
      await page.evaluate('document.querySelector("#open-settings").click()');
      await selectSetting('external-helpers');
      await page.ready('!!document.querySelector(' + JSON.stringify(settings + ' input') + ')');
      const verified = locale === 'zh-TW' ? '已驗證 Windows 隔離' : 'Windows isolation verified';
      const unavailable = locale === 'zh-TW' ? '尚未驗證 Windows 隔離' : 'Windows isolation is unverified';
      const helperStatus = await page.evaluate<string[]>('Array.from(document.querySelectorAll("#external-helper-settings fieldset"), group => group.textContent)');
      assert.ok(helperStatus[0].includes(verified) && helperStatus[0].includes('1.2.3'));
      assert.ok(helperStatus[1].includes(unavailable));
      const enabled = (await json(await api.get('/api/settings/external-helpers')))[0];
      if (enabled.enabled) {
        const { provider, confirmEachRun, termsConfirmed, revision } = enabled;
        await json(await api.post('/api/settings/external-helpers', { provider, enabled: false, confirmEachRun, termsConfirmed, revision }));
        await selectSetting('projects');
        await selectSetting('external-helpers');
        await page.ready('document.querySelector(' + JSON.stringify(settings + ' input') + ')?.checked === false');
      }
      await focus(settings + ' input');
      await key(' ', 'Space', 32);
      await page.ready('!!document.querySelector(' + JSON.stringify(dialog) + ')');
      const warning = await page.evaluate<string>('document.querySelector(' + JSON.stringify(dialog) + ').textContent');
      assert.ok(warning.includes(labels.warning) && warning.includes(labels.enable));
      await escape();
      await page.ready('!document.querySelector("dialog.external-dialog")');
      await page.ready('document.activeElement === document.querySelector(' + JSON.stringify(settings + ' input') + ')');
      assert.equal(await page.evaluate('document.activeElement.checked'), false);
      assert.equal((await json(await api.get('/api/settings/external-helpers')))[0].enabled, false);
      await key(' ', 'Space', 32);
      await activate(accept);
      await page.ready('!!document.querySelector(' + JSON.stringify(settings + ' [data-classification]') + ')');
      const target = (await json(await api.get('/api/settings/external-helpers')))[0];
      if (target.classification !== 'public') {
        await activate(settings + ' .external-classification button');
        await activate(accept);
        await page.ready('!!document.querySelector(' + JSON.stringify(settings + ' [data-classification=public]') + ')');
      }
      const name = 'public-' + locale + '-' + width + '.txt';
      await json(await api.upload(path + '/attachments', name, 'Synthetic selected public text'), 201);
      await page.evaluate('document.querySelector("#close-settings").click()');
      await page.ready('!document.querySelector("#manage-attachments").hidden');
      await activate('#manage-attachments');
      const fileSelector = '#attachments li:last-child .external-classification';
      await page.ready('!!document.querySelector(' + JSON.stringify(fileSelector + ' button') + ')');
      await activate(fileSelector + ' button');
      assert.equal(await page.evaluate('document.querySelector(' + JSON.stringify(accept) + ').textContent'), labels.mark);
      await activate(accept);
      await page.ready('!!document.querySelector(' + JSON.stringify(fileSelector + ' [data-classification=public]') + ')');
      if (!await page.evaluate(closePanel)) {
        await escape();
        await page.ready(closePanel);
      }
      await activate('#prepare-external-helper');
      await page.ready('!!document.querySelector(' + JSON.stringify(dialog + ' textarea') + ')');
      const task = 'Synthetic public coding task ' + locale + ' ' + width;
      await page.evaluate('document.querySelector(' + JSON.stringify(dialog + ' textarea') + ').value = ' + JSON.stringify(task));
      await focus(dialog + ' input[required][type=checkbox]');
      await key(' ', 'Space', 32);
      await page.evaluate('Array.from(document.querySelectorAll(' + JSON.stringify(dialog + ' fieldset label') +
        ')).find(label => label.textContent === ' + JSON.stringify(name) + ').querySelector("input").focus()');
      await key(' ', 'Space', 32);
      await activate(accept);
      const card = '.delegation-card[data-status=awaiting_confirmation]';
      await page.ready('!!document.querySelector(' + JSON.stringify(card) + ')', 25_000);
      await activate(card + ' [data-feature-focus$="-confirm"]');
      await page.ready('!!document.querySelector(' + JSON.stringify(dialog + ' pre') + ')');
      const approval = await page.evaluate<string>('document.querySelector(' + JSON.stringify(dialog) + ').textContent');
      assert.ok(approval.includes(task) && approval.includes(labels.confirm) && approval.includes(name));
      await assertWorkbenchFits(page, 'external confirmation ' + locale + ' ' + width);
      await activate(accept);
      await page.ready('!document.querySelector(' + JSON.stringify(card) + ')');
      const state = await json(await api.get(path + '/state'));
      const latest = state.delegations.at(-1);
      assert.equal(latest.status, 'queued');
      const receipt = await json(await api.get('/api/delegations/' + latest.delegationId));
      assert.equal(receipt.externalApproval.decision, 'confirmed');
      assert.equal(receipt.externalApproval.task, task);
      assert.deepEqual(receipt.externalApproval.inputs.map(({ name }: { name: string }) => name), [name]);
    }
  }
  await selectLocale(page, 'zh-TW');
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
