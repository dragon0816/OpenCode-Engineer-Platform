import assert from 'node:assert/strict';
import type { chromium } from './chromium.ts';
import type { webAPI } from './web-api.ts';
import { assertWorkbenchFits, selectLocale } from './gui-locales.ts';
import type { subscriptionHelper } from '../fixtures/external-helpers/subscription.ts';

type Options = {
  page: Awaited<ReturnType<typeof chromium>>;
  api: Awaited<ReturnType<typeof webAPI>>;
  key: (key: string, code: string, windowsVirtualKeyCode: number) => Promise<void>;
  reload: (connection?: string) => Promise<void>;
  selectSetting: (section: string) => Promise<unknown>;
  signOut: () => void;
  referencePicker?: boolean;
  startSubscriptionTests: () => ReturnType<typeof subscriptionHelper>;
};

export async function verifyExternalHelpersInBrowser({ page, api, key, reload, selectSetting, signOut, referencePicker, startSubscriptionTests }: Options) {
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
  assert.deepEqual(await json(await api.get('/api/settings/external-helpers/policy')), { strictMode: false, revision: 0 });
  assert.equal((await json(await api.get('/api/settings/external-helpers')))[0].confirmEachRun, false);

  for (const locale of ['zh-TW', 'en'] as const) {
    for (const width of [1440, 390]) {
      await page.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await selectLocale(page, locale);
      const labels = locale === 'zh-TW'
        ? { enable: '確認啟用', mark: '標為公開', confirm: '確認交辦', warning: '傳送至 Codex', strict: '嚴格模式：只允許標為公開的資料' }
        : { enable: 'Confirm enable', mark: 'Mark public', confirm: 'Confirm delegation', warning: 'sent to Codex',
          strict: 'Strict mode: allow only data marked public' };
      await page.evaluate('document.querySelector("#open-settings").click()');
      await selectSetting('external-helpers');
      await page.ready('!!document.querySelector(' + JSON.stringify(settings + ' input') + ')');
      await page.ready('!!document.querySelector("#external-helper-strict")');
      assert.equal(await page.evaluate('document.querySelector("#external-helper-strict").closest("label").textContent'), labels.strict);
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
      if (!target.confirmEachRun) {
        const { provider, enabled, termsConfirmed, revision } = target;
        await json(await api.post('/api/settings/external-helpers', { provider, enabled, termsConfirmed, revision, confirmEachRun: true }));
      }
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
      const uploadRow = '#attachments > li:nth-last-child(1 of :has(> .external-classification))';
      const fileSelector = uploadRow + ' .external-classification';
      await page.ready('document.querySelector(' + JSON.stringify(uploadRow + ' label') + ')?.textContent === ' + JSON.stringify(name) +
        ' && !!document.querySelector(' + JSON.stringify(fileSelector + ' [data-classification=unclassified]') + ')');
      await activate(fileSelector + ' button');
      assert.equal(await page.evaluate('document.querySelector(' + JSON.stringify(accept) + ').textContent'), labels.mark);
      await activate(accept);
      await page.ready('!!document.querySelector(' + JSON.stringify(fileSelector + ' [data-classification=public]') + ')');
      await focus(uploadRow + ' label input');
      await key(' ', 'Space', 32);
      if (!await page.evaluate(closePanel)) {
        await escape();
        await page.ready(closePanel);
      }
      const includeReference = referencePicker && locale === 'zh-TW' && width === 1440;
      if (includeReference) {
        await activate('#reference-picker summary');
        await activate('#pick-reference-file');
        await page.ready(`document.querySelector('#attachments .reference-chip[title$="picker-reference.csv"] input:checked')`);
      }
      assert.equal(await page.evaluate('!!document.querySelector("#prepare-external-helper")'), false);
      const task = 'Synthetic public coding task ' + locale + ' ' + width;
      await page.evaluate('document.querySelector("#prompt").value = ' + JSON.stringify(task));
      await activate('#send');
      const card = '.delegation-card[data-status=awaiting_confirmation]';
      await page.ready('!!document.querySelector(' + JSON.stringify(card) + ')', 25_000);
      await activate(card + ' [data-feature-focus$="-confirm"]');
      await page.ready('!!document.querySelector(' + JSON.stringify(dialog + ' pre') + ')');
      const approval = await page.evaluate<string>('document.querySelector(' + JSON.stringify(dialog) + ').textContent');
      assert.ok(approval.includes(task) && approval.includes(labels.confirm) && approval.includes(name));
      await assertWorkbenchFits(page, 'external confirmation ' + locale + ' ' + width);
      await activate(accept);
      await page.ready('!document.querySelector(' + JSON.stringify(card) + ') && ' +
        'Array.from(document.querySelectorAll(".delegation-card")).at(-1)?.dataset.status === "succeeded"');
      const state = await json(await api.get(path + '/state'));
      const latest = state.delegations.at(-1);
      assert.equal(latest.status, 'succeeded');
      assert.equal(latest.summary, 'Synthetic external reply');
      assert.deepEqual(latest.files.map(({ name }: { name: string }) => name), ['synthetic-result.txt']);
      const delegatedOutput = await api.get('/api/delegations/' + latest.delegationId + '/files/' + latest.files[0].fileId);
      assert.equal(delegatedOutput.status, 200);
      assert.equal(await delegatedOutput.text(), 'Synthetic verified output\n');
      const receipt = await json(await api.get('/api/delegations/' + latest.delegationId));
      assert.equal(receipt.externalApproval.decision, 'confirmed');
      assert.equal(receipt.externalApproval.task, task);
      assert.deepEqual(receipt.externalApproval.inputs.map(({ name }: { name: string }) => name),
        includeReference ? [name, 'picker-reference.csv'] : [name]);
    }
  }
  const setSource = async (modelSource: string) => {
    const { agent } = await json(await api.get('/api/agents/main'));
    await json(await api.post('/api/agents/main', { revision: agent.revision, action: 'edit', modelSource }));
  };
  const { provider, enabled, termsConfirmed, revision } = (await json(await api.get('/api/settings/external-helpers')))[0];
  await json(await api.post('/api/settings/external-helpers', { provider, enabled, termsConfirmed, revision, confirmEachRun: false }));
  await setSource('codex_cli');
  await reload('Connected');
  await page.ready("document.querySelector('#session-alias').value === 'external:codex_cli'");
  if (referencePicker) {
    await activate('#reference-picker summary');
    await activate('#pick-reference-file');
    await page.ready(`document.querySelector('#attachments .reference-chip[title$="picker-reference.csv"] input:checked')`);
  }
  await page.evaluate("document.querySelector('#prompt').value = 'Synthetic direct external chat'");
  await activate('#send');
  await page.ready("document.querySelector('#messages').textContent.includes('Synthetic external reply')");
  const direct = (await json(await api.get(path + '/state'))).runs.at(-1);
  assert.equal(direct.state, 'verified');
  assert.deepEqual(direct.externalFiles.map(({ name }: { name: string }) => name), ['synthetic-result.txt']);
  const output = await api.get(path + '/external-files/' + direct.id + '/0');
  assert.equal(output.status, 200);
  assert.equal(await output.text(), 'Synthetic verified output\n');
  await setSource('gateway');
  signOut();
  await reload('Connected');
  await page.ready(`!document.querySelector('#session-alias').disabled &&
    document.querySelector('#session-alias option[value="external:codex_cli"]')?.disabled === false`);
  assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('#session-alias optgroup'), group => group.label)`),
    ['LLM Gateway', 'External coding agents']);
  assert.equal(await page.evaluate(`document.querySelector('#session-alias option[value="external:claude_code"]').textContent`),
    'Claude Code (enable in Settings)');
  await page.evaluate(`(() => {
    const menu = document.querySelector('#session-alias');
    menu.focus();
    menu.value = 'external:codex_cli';
    menu.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.ready(`Boolean(document.querySelector('${accept}'))`);
  const loginText = await page.evaluate<string>(`document.querySelector('${dialog}').textContent`);
  assert.match(loginText, /Codex sign-in/);
  assert.match(loginText, /Signed out/);
  assert.match(loginText, /Confidential data is blocked/);
  assert.match(loginText, /Strict mode allows only public data/);
  assert.equal(await page.evaluate(`document.activeElement === document.querySelector('${accept}')`), true);
  assert.equal(await page.evaluate(`document.querySelector('${accept}').textContent`), 'Sign in with ChatGPT');
  const advanced = dialog + ' details';
  assert.equal(await page.evaluate(`document.querySelector('${advanced} summary').textContent`), 'Advanced');
  assert.equal(await page.evaluate(`document.querySelector('${advanced} input').checkVisibility()`), false);
  await activate(advanced + ' summary');
  await page.ready(`document.querySelector('${advanced} input').checkVisibility()`);
  assert.equal(await page.evaluate(`document.querySelector('${advanced} input').type`), 'password');
  assert.match(await page.evaluate<string>(`document.querySelector('${advanced} label').textContent`), /OpenAI API key/);
  await assertWorkbenchFits(page, 'external sign-in en 390');
  await escape();
  await page.ready(`!document.querySelector('${dialog}') && document.activeElement.id === 'session-alias'`);
  assert.equal(await page.evaluate("document.querySelector('#send').disabled"), true);
  assert.match(await page.evaluate<string>("document.querySelector('#session-external-model-reason').textContent"), /Sign in to this provider/);
  const { agent } = await json(await api.get('/api/agents/main'));
  assert.equal(agent.modelSource, 'codex_cli');
  await json(await api.post('/api/agents/main', { revision: agent.revision, action: 'edit', modelSource: 'gateway' }));

  const helpers = '/api/settings/external-helpers';
  const manage = (provider: string) => '#external-helper-settings [data-external-login="' + provider + '"]';
  const contains = (text: string) => `document.querySelector('${dialog}')?.textContent.includes(${JSON.stringify(text)})`;
  await page.evaluate('document.querySelector("#open-settings").click()');
  await selectSetting('external-helpers');
  await activate(manage('claude_code'));
  assert.match(await page.evaluate<string>(`document.querySelector('${dialog}').textContent`), /Setup-OEPExternalHelper\.ps1/);
  assert.equal(await page.evaluate(`document.querySelector('${accept}').disabled`), true);
  await escape();
  await page.ready(`!document.querySelector('${dialog}')`);

  const fixture = startSubscriptionTests();
  const claude = (await json(await api.get(helpers)))[1];
  await json(await api.post(helpers, { provider: claude.provider, enabled: claude.enabled, confirmEachRun: claude.confirmEachRun,
    termsConfirmed: true, revision: claude.revision }));
  for (const provider of ['codex_cli', 'claude_code']) await json(await api.post(helpers + '/recheck', { provider }));
  await selectSetting('projects');
  await selectSetting('external-helpers');
  await selectLocale(page, 'zh-TW');
  await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
    value: async (value) => { window.oepSyntheticClipboard = value; }, configurable: true
  })`);
  await activate(manage('codex_cli'));
  await page.ready(contains('使用 ChatGPT 帳號登入'));
  const device = dialog + ' .settings-actions > button[type=submit] + button';
  await activate(device);
  const prompt = dialog + ' .external-login-prompt';
  const link = prompt + ' a[href]';
  await page.ready(`document.querySelector('${prompt} code').textContent === 'ABCD-EFGH'`);
  assert.deepEqual(await page.evaluate(`(() => {
    const link = document.querySelector('${link}');
    return [link.textContent, link.href, link.target, link.rel];
  })()`), ['開啟登入頁面', 'https://auth.openai.com/codex/device', '_blank', 'noopener noreferrer']);
  await activate(prompt + ' div:has(> code) button');
  assert.equal(await page.evaluate('window.oepSyntheticClipboard'), 'ABCD-EFGH');
  fixture.approveDevice();
  await page.ready(contains('已使用供應商帳號登入'));
  await activate(device + ' + button');
  await page.ready(contains('尚未登入'));
  await page.evaluate(`window.oepPriorLoginControl = document.querySelector(${JSON.stringify(manage('codex_cli'))})`);
  await escape();
  await page.ready(`!document.querySelector('${dialog}') &&
    document.querySelector(${JSON.stringify(manage('codex_cli'))}) !== window.oepPriorLoginControl`);

  await selectLocale(page, 'en');
  await activate(manage('claude_code'));
  await page.ready(contains('Sign in with a Claude subscription'));
  await activate(accept);
  await page.ready(`document.querySelector('${prompt} input').checkVisibility()`);
  await focus(prompt + ' input');
  await page.evaluate(`document.activeElement.value = ${JSON.stringify(fixture.code)}`);
  await enter();
  await page.ready(contains('Signed in (owner@example.test)'));
  await activate(device + ' + button');
  await page.ready(contains('Signed out'));
  await activate(accept);
  await page.ready(`document.querySelector('${link}')?.checkVisibility()`);
  await activate(dialog + ' [data-login-cancel]');
  await page.ready(contains('Sign-in cancelled.'));
  await escape();
  await page.ready(`!document.querySelector('${dialog}') && document.activeElement === document.querySelector(${JSON.stringify(manage('claude_code'))})`);
  await selectLocale(page, 'zh-TW');
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate('document.querySelector("#close-settings").click()');
  console.log('External helper settings, confirmation, model source and sign-in passed in Chromium.');
}
