import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import type { chromium } from './chromium.ts';
import { assertUiTextInThemes } from './forbidden-shell-text.ts';
import { assertContrastInThemes } from './gui-contrast.ts';
import { assertWorkbenchFits, selectLocale } from './gui-locales.ts';
import { mappingChecks } from './gui-mapping.ts';

type Options = {
  page: Awaited<ReturnType<typeof chromium>>;
  runtime: Runtime;
  click: (selector: string) => Promise<void>;
  key: (key: string, code: string, windowsVirtualKeyCode: number) => Promise<void>;
  reload: (connection?: string) => Promise<void>;
  selectSetting: (section: string) => Promise<unknown>;
  captures: boolean;
  captureAgentManagement: boolean;
  syntheticBotToken: string;
  secondBotToken: string;
  startTelegramSetup(chat: string): void;
  seedLegacyBudget(): void;
};

const name = '資料查核';
const reviewID = 'sample-agent-review';

export async function verifyAgentWorkbench({ page, runtime, click, key, reload, selectSetting, captures, captureAgentManagement,
  syntheticBotToken, secondBotToken, startTelegramSetup, seedLegacyBudget }: Options) {
  const mapping = mappingChecks(page, 'agent');
  const press = () => key('Enter', 'Enter', 13);
  const type = (text: string) => page.command('Input.insertText', { text });
  const visible = (selector: string) => page.ready(`Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility())`);
  const activate = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setValue = (selector: string, value: string) => page.evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const rail = () => page.evaluate("if (document.querySelector('#session-sidebar').hidden) document.querySelector('#toggle-sidebar').click()");
  const createWizard = async (keyboard = false) => {
    await rail();
    if (keyboard) {
      await page.evaluate("document.querySelector('#new-agent').focus()");
      await press();
    } else await click('#new-agent');
    await visible('#assistant-name');
  };
  const step = async (index: number, useKeyboard = false) => {
    if (useKeyboard) {
      await page.evaluate("document.querySelector('#agent-next').focus()");
      await press();
    } else await click('#agent-next');
    await page.ready(`document.querySelector('.agent-steps li:nth-child(${index})')?.getAttribute('aria-current') === 'step' &&
      document.activeElement.id === 'agent-step-title'`);
  };
  const sessionID = () => page.evaluate<string>("document.querySelector('#sessions [aria-current=true]')?.dataset.session");
  const openChannels = async () => {
    await rail();
    await activate('#open-settings');
    await selectSetting('channels');
    await visible('#channel-accounts li button');
  };

  await page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.ready('innerWidth === 1440');
  await rail();
  const initialCount = await page.evaluate<number>("document.querySelectorAll('#agent-list [data-agent]').length");
  await mapping.check('agent-rail', '#rail-assistants', { selectors: ['#new-agent', '[data-agent=main] .agent-row-start', '[data-agent=bi]', '[data-agent=main] summary'] });
  for (const id of ['main', 'bi']) {
    assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-agent=${id}] [data-delete-agent]'))`), false);
    await click(`[data-agent=${id}] .agent-row-open`);
    await visible('#builtin-agent-help');
    assert.equal(await page.evaluate("Boolean(document.querySelector('#delete-agent'))"), false);
    await click('#close-agent');
  }
  await createWizard(true);
  await page.evaluate("document.querySelector('#assistant-name').focus()");
  await type('放棄草稿');
  await step(2, true);
  await page.evaluate("document.querySelector('#agent-cancel').focus()");
  await press();
  await page.ready("document.querySelector('#agent-view').hidden && document.activeElement.id === 'new-agent'");
  assert.equal(await page.evaluate("document.querySelectorAll('#agent-list [data-agent]').length"), initialCount);

  await createWizard();
  await setValue('#assistant-name', name);
  await setValue('#assistant-introduction', '核對合成資料');
  await setValue('#assistant-instructions', '列出可核對的來源');
  await step(2);
  const model = await page.evaluate<string>("document.querySelector('#agent-model option:nth-child(2)').value");
  await setValue('#agent-model', model);
  await step(3);
  await step(4);
  await mapping.check('agent-wizard', '#agent-view', { selectors: ['.agent-steps [aria-current=step]', '.agent-choices', '#agent-next', '#agent-cancel'],
    labels: ['上一步', '下一步', '取消'] });
  assert.match(await page.evaluate<string>("document.querySelector('#agent-fields').textContent"), /Skill 即將開放/);
  await step(5);
  await setValue('#agent-reply-locale', 'en');
  await setValue('#agent-channel-token', syntheticBotToken);
  assert.equal(await page.evaluate("document.querySelector('#agent-channel-token').type"), 'password');
  await page.evaluate("document.querySelector('#agent-channel-token').focus()");
  await press();
  await page.ready("document.querySelector('.telegram-setup').textContent.includes('找到 @SampleDataBot') && document.querySelector('.telegram-setup').textContent.includes('/start')");
  startTelegramSetup('group');
  await click('#agent-next');
  await page.ready("document.querySelector('#settings-status').textContent.includes('請先確認')");
  assert.equal(await page.evaluate("Boolean(document.querySelector('#agent-channel-owner-confirm'))"), false);
  startTelegramSetup('private');
  await visible('#agent-channel-owner-confirm');
  assert.match(await page.evaluate<string>("document.querySelector('.telegram-setup').textContent"), /@SampleOwner/);
  await click('#agent-next');
  await page.ready("document.querySelector('#settings-status').textContent.includes('請先確認')");
  await click('#agent-channel-owner-confirm');
  await mapping.check('agent-wizard', '#agent-view', { selectors: ['#agent-channel-token[type=password]', '#agent-channel-owner-confirm'] });
  await step(6);
  await step(7);
  assert.match(await page.evaluate<string>("document.querySelector('.agent-summary').textContent"), /@SampleDataBot/);
  await click('#agent-next');
  await page.ready(`document.querySelector('#agent-title').textContent === ${JSON.stringify(name)} &&
    document.querySelector('#settings-status').textContent === '已儲存' && [...document.querySelectorAll('.agent-row-open strong')]
      .some(entry => entry.textContent === ${JSON.stringify(name)})`);
  const specialist = await page.evaluate<string>(`[...document.querySelectorAll('.agent-row-open strong')]
    .find(entry => entry.textContent === ${JSON.stringify(name)}).closest('[data-agent]').dataset.agent`);
  const specialistRow = `[data-agent="${specialist}"]`;
  assert.equal(await page.evaluate(`document.querySelector('${specialistRow}').textContent.includes('@SampleDataBot')`), true);
  await mapping.check('agent-detail', '#agent-view', { selectors: ['#agent-tab-basic', '#agent-tab-model', '#agent-tab-knowledge',
    '#agent-tab-channel', '#agent-tab-trigger', '#agent-tab-ability', '#agent-model', '#agent-reply-locale', '#save-assistant', '#delete-agent', '.agent-channel-token button'] });
  await click('#agent-tab-channel');
  assert.match(await page.evaluate<string>("document.querySelector('.agent-channel-token').textContent"), /已設定 token（@SampleDataBot）.*更換 token/);
  assert.equal(await page.evaluate("Boolean(document.querySelector('#agent-panel-channel input[type=password]'))"), false);
  await click('#agent-tab-basic');
  await key('ArrowRight', 'ArrowRight', 39);
  await page.ready("document.activeElement.id === 'agent-tab-model' && !document.querySelector('#agent-panel-model').hidden");
  assert.equal(await page.evaluate("document.querySelector('#agent-model').value"), model);
  await key('Home', 'Home', 36);
  await setValue('#assistant-instructions', '保留來源引用');
  await click('#save-assistant');
  await page.ready("document.querySelector('#settings-status').textContent === '已儲存'");
  await reload();
  await visible(`${specialistRow} .agent-row-open`);
  await click(`${specialistRow} .agent-row-open`);
  await page.ready("document.querySelector('#assistant-instructions')?.value === '保留來源引用'");
  await click('#close-agent');

  const priorSession = await sessionID();
  await click('[data-agent=main] .agent-row-start');
  await page.ready(`document.querySelector('#sessions [aria-current=true]')?.dataset.session &&
    document.querySelector('#sessions [aria-current=true]').dataset.session !== ${JSON.stringify(priorSession)} &&
    !document.querySelector('#prompt').disabled`);
  const mainSession = await sessionID();
  await click(`${specialistRow} .agent-row-start`);
  await page.ready(`document.querySelector('#top-agent').textContent === ${JSON.stringify(name)} &&
    document.querySelector('#sessions [aria-current=true]').dataset.session !== ${JSON.stringify(mainSession)}`);
  const specialistSession = await sessionID();
  await setValue('#prompt', 'SYNTHETIC_SPECIALIST_CHAT');
  await click('#send');
  await page.ready("document.querySelector('#messages .message.assistant')?.textContent.includes('已核對合成資料') && !document.querySelector('#send').disabled", 30_000);
  await reload();
  await page.ready(`document.querySelector('#sessions [aria-current=true]')?.dataset.session === ${JSON.stringify(specialistSession)}`);
  await click(`[data-session="${mainSession}"]`);
  await page.ready(`document.querySelector('#top-agent').textContent !== ${JSON.stringify(name)}`);
  await click(`[data-session="${specialistSession}"]`);
  await page.ready(`document.querySelector('#top-agent').textContent === ${JSON.stringify(name)} && document.querySelector('#messages .message.assistant')`);

  await page.evaluate(`document.querySelector('${specialistRow} summary').focus()`);
  await press();
  await page.ready(`document.activeElement.closest('${specialistRow}') && document.activeElement.tagName === 'BUTTON'`);
  await press();
  await page.ready(`document.querySelector('#assistant-name')?.value === ${JSON.stringify(name + ' 副本')}`);
  for (let index = 2; index <= 7; index++) {
    await step(index, true);
    if (index === 2) assert.equal(await page.evaluate("document.querySelector('#agent-model').value"), model);
    if (index === 5) assert.equal(await page.evaluate("document.querySelector('#agent-channel').value"), '');
  }
  await page.evaluate("document.querySelector('#agent-next').focus()");
  await press();
  await page.ready(`document.querySelector('#agent-title').textContent === ${JSON.stringify(name + ' 副本')} &&
    document.querySelector('#settings-status').textContent === '已儲存'`);

  await openChannels();
  await page.ready("document.querySelector('#channel-accounts').textContent.includes('正常運作') && document.querySelector('#channel-accounts').textContent.includes('需要重新設定 token')");
  assert.equal(await page.evaluate("[...document.querySelectorAll('#channel-accounts li')].every(row => row.querySelectorAll('button').length === 1)"), true);
  await page.evaluate("document.querySelector('#channel-add').focus()");
  await press();
  await visible('#channel-token');
  await setValue('#channel-token', syntheticBotToken);
  await click('#channel-token-continue');
  await page.ready("document.querySelector('#channel-dialog .telegram-setup').textContent.includes('這個機器人已在清單中') && document.querySelector('#channel-save').disabled");
  await setValue('#channel-token', secondBotToken);
  await click('#channel-token-continue');
  await visible('#channel-agent');
  await page.ready("document.querySelector('#channel-dialog').textContent.includes('@SampleAlertsBot')");
  assert.equal(await page.evaluate("Boolean(document.querySelector('#channel-owner-confirm'))"), false);
  await setValue('#channel-agent', 'main');
  await click('#channel-save');
  await page.ready("!document.querySelector('#channel-dialog').open && document.querySelector('#channel-accounts').textContent.includes('@SampleAlertsBot')");
  for (const [preset, expected] of [
    ['lean', [2, 3, 6, 18, 12, 36, 5]], ['relaxed', [5, 10, 20, 60, 100, 300, 20]],
    ['standard', [3, 5, 10, 30, 30, 90, 10]],
  ] as const) {
    await click('#delegation-preset-' + preset);
    await click('#save-delegation-budgets');
    await page.ready("document.querySelector('#delegation-budget-status').textContent === '已儲存'");
    await reload();
    await openChannels();
    await page.ready(`document.querySelector('#delegation-preset-${preset}')?.checked`);
    assert.equal(await page.evaluate("document.querySelector('#delegation-budget-advanced').open"), false);
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#delegation-budget-fields input')].map(input => input.valueAsNumber)"), expected);
  }
  seedLegacyBudget();
  await reload();
  await openChannels();
  await page.ready("!document.querySelector('#delegation-budget-current').hidden && document.querySelector('#delegation-budget-current').textContent === '自訂'");
  assert.equal(await page.evaluate("document.querySelector('#budget-queueMs').valueAsNumber"), 720123 / 60000);
  await activate('#delegation-budget-advanced > summary');
  assert.match(await page.evaluate<string>("document.querySelector('label[for=budget-queueMs]').textContent"), /分鐘/);
  await click('#save-delegation-budgets');
  await page.ready("document.querySelector('#delegation-budget-status').textContent === '已儲存'");
  await reload();
  await openChannels();
  await page.ready("document.querySelector('#budget-queueMs')?.valueAsNumber === 720123 / 60000");
  const reviewStore = runtime.knowledge!.reviewStore;
  const schema = reviewStore.installReviewSchema('sample-agent-bi', 'sample-agent-bi', '1', ['setting']);
  reviewStore.stage(reviewID, {
    vault: { id: 'sample-agent-bi', kind: 'bi', title: '資料核對' }, schema: schema.sha256,
    sources: [{ id: 'source', ref: 'sample.md', original: 'Amber', markdown: 'Amber' }],
    cards: [{ id: 'card', key: 'card', type: 'record', title: '來源核對', version: '1', fields: { setting: 'Amber' } }],
    relationships: [], evidence: [{ sourceId: 'source', cardId: 'card', field: 'setting', start: 0, end: 5 }],
  }, { origin: 'telegram', sourceKey: reviewID,
    destination: { accountId: 'telegram-bi', conversationKey: 'topic:7', bindingRevision: 1, agentId: 'bi' } });
  await rail();
  await activate('#open-review');
  await page.ready("document.querySelector('.review-agent-source')?.textContent.includes('BI 資料處理')");
  await selectLocale(page, 'en');
  await page.ready("document.querySelector('.review-agent-source')?.textContent.includes('BI Data Processing')");
  await selectLocale(page, 'zh-TW');
  await mapping.check('agent-review-source', '#review-view', { selectors: ['.review-agent-source'] });

  const shot = async (label: string, theme: string, viewport: string, locale: string) => {
    const changed = ['detail', 'wizard-channel', 'channels', 'channel-manage', 'delete', 'budget'];
    const currentGallery = captureAgentManagement && changed.includes(label) &&
      (theme === 'light' && viewport === 'wide' && locale === 'zh-TW' || theme === 'dark' && viewport === 'narrow' && locale === 'en');
    if (!captures && !currentGallery) return;
    const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(join('docs', 'validation', 'gui', `${currentGallery ? 'ux-agent' : 'slice4'}-${label}-${locale}-${viewport}-${theme}.png`), Buffer.from(data, 'base64'));
  };
  const check = async (selector: string, contrast: string, context: string) => {
    await assertUiTextInThemes(page, selector);
    await assertContrastInThemes(page, [{ selector: contrast }]);
    await assertWorkbenchFits(page, context);
  };
  const matrix = [[1440, 900, 'wide'], [390, 844, 'narrow']] as const;
  for (const [width, height, viewport] of matrix) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.ready(`innerWidth === ${width} && document.querySelector('#session-sidebar').hidden === ${width < 800}`);
    for (const locale of captures || captureAgentManagement ? ['zh-TW', 'en'] as const : ['zh-TW'] as const) {
      await selectLocale(page, locale);
      for (const theme of captures || captureAgentManagement ? ['light', 'dark'] : ['light']) {
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.scrollTo(0, 0)`);
        await rail();
        await page.evaluate("document.querySelector('#rail-assistants').open = true; document.querySelector('#rail-assistants').scrollIntoView({block:'center'})");
        if (locale === 'zh-TW' && theme === 'light') await check('#rail-assistants', '#new-agent', viewport + ' agent rail');
        await shot('rail', theme, viewport, locale);

        await activate(`${specialistRow} .agent-row-open`);
        await visible('#assistant-name');
        await page.evaluate('window.scrollTo(0, 0)');
        if (locale === 'zh-TW' && theme === 'light') await check('#agent-view', '#save-assistant', viewport + ' agent details');
        await shot('detail', theme, viewport, locale);
        if (captureAgentManagement) {
          await activate('#delete-agent');
          await visible('#delete-agent-dialog[open]');
          await shot('delete', theme, viewport, locale);
          await key('Escape', 'Escape', 27);
        }

        await rail();
        await activate('#new-agent');
        await visible('#assistant-name');
        await setValue('#assistant-name', name);
        for (const [index, wizardStep] of ['basic', 'model', 'knowledge', 'ability', 'channel', 'trigger', 'confirm'].entries()) {
          if (index) await step(index + 1, true);
          await page.evaluate('window.scrollTo(0, 0)');
          if (locale === 'zh-TW' && theme === 'light') await check('#agent-view', '#agent-next', `${viewport} wizard ${wizardStep}`);
          await shot('wizard-' + wizardStep, theme, viewport, locale);
        }
        await activate('#agent-cancel');
        await openChannels();
        await page.evaluate('window.scrollTo(0, 0)');
        if (locale === 'zh-TW' && theme === 'light') {
          await check('#settings-channels', '#channel-add', viewport + ' channels');
          assert.equal(await page.evaluate("getComputedStyle(document.querySelector('#channel-accounts li')).gridTemplateColumns.split(' ').length"), width < 800 ? 1 : 3);
        }
        await shot('channels', theme, viewport, locale);
        if (captureAgentManagement) {
          const selector = `[data-channel] button[aria-label$="@SampleDataBot"]`;
          await activate(selector);
          await visible('#channel-dialog[open]');
          await shot('channel-manage', theme, viewport, locale);
          await key('Escape', 'Escape', 27);
          await page.evaluate("document.querySelector('#delegation-budget-presets').scrollIntoView({ block: 'start' })");
          await shot('budget', theme, viewport, locale);
        }
        await rail();
        await activate('#open-review');
        await visible('.review-agent-source');
        await page.evaluate("document.querySelector('.review-agent-source').scrollIntoView({block:'center'})");
        if (locale === 'zh-TW' && theme === 'light') await check('#review-view', '.review-agent-source', viewport + ' review');
        await shot('review', theme, viewport, locale);
      }
    }
  }
  await page.command('Emulation.clearDeviceMetricsOverride');
  await page.ready("!matchMedia('(max-width: 800px)').matches && !document.querySelector('#session-sidebar').hidden");
  await selectLocale(page, 'zh-TW');
  await openChannels();
  const binding = await page.evaluate<string>(`[...document.querySelectorAll('#channel-accounts li')]
    .find(row => row.querySelector('strong').textContent === '@SampleDataBot').dataset.channel`);
  await page.evaluate('window.confirm = () => true');
  const channelRow = `[data-channel="${binding}"]`;
  const manage = `${channelRow} [data-channel-action=manage]`;
  await page.evaluate(`document.querySelector('${manage}').focus()`);
  await press();
  await visible('#channel-dialog[open]');
  assert.match(await page.evaluate<string>("document.querySelector('#channel-dialog').textContent"), /已設定 token（@SampleDataBot）/);
  assert.equal(await page.evaluate("document.querySelector('#channel-dialog details code').textContent"), '');
  await click('#channel-dialog details summary');
  await page.ready("/^OEP_TELEGRAM_BOT_[A-F0-9]{32}_BOT_TOKEN$/.test(document.querySelector('#channel-dialog details code').textContent)");
  await click('#channel-recheck');
  await page.ready("document.querySelector('#channel-dialog-status').textContent.includes('已向 Telegram 檢查')");
  await key('Escape', 'Escape', 27);
  await page.ready(`!document.querySelector('#channel-dialog').open && !document.querySelector('#channel-dialog').firstElementChild &&
    document.activeElement.matches('${manage}')`);
  for (const [agentId, assignment] of [['main', '合成助理'], [specialist, name], ['', '尚未指定助理'], [specialist, name]]) {
    await click(manage);
    await visible('#channel-agent');
    await setValue('#channel-agent', agentId);
    assert.equal(await page.evaluate("document.querySelector('#channel-save').disabled"), true);
    await click('#channel-confirm-assignment');
    await click('#channel-save');
    await page.ready(`!document.querySelector('#channel-dialog').open && !document.querySelector('#channel-dialog').firstElementChild &&
      document.querySelector('${channelRow} p')?.textContent === ${JSON.stringify(assignment)}`);
  }
  const alerts = `[data-channel] button[aria-label$="@SampleAlertsBot"]`;
  await click(alerts);
  await click('#channel-remove');
  await page.ready(`!document.querySelector('#channel-dialog').open && !document.querySelector(${JSON.stringify(alerts)})`);
  await rail();
  await click(`${specialistRow} .agent-row-open`);
  await visible('#delete-agent');
  await click('#delete-agent');
  await page.ready("document.querySelector('#delete-agent-dialog').open && document.activeElement.id === 'cancel-delete-agent'");
  assert.match(await page.evaluate<string>("document.querySelector('#delete-agent-help').textContent"), /解除綁定.*過去的會話.*還原助理/);
  await key('Escape', 'Escape', 27);
  await page.ready("!document.querySelector('#delete-agent-dialog').open && document.activeElement.id === 'delete-agent'");
  await click('#delete-agent');
  await visible('#delete-agent-dialog[open] #confirm-delete-agent');
  await click('#confirm-delete-agent');
  await page.ready("!document.querySelector('#delete-agent-dialog').open || document.querySelector('#delete-agent-status').textContent");
  assert.equal(await page.evaluate("document.querySelector('#delete-agent-status').textContent"), '');
  await visible('#restore-agent');
  await page.ready(`!document.querySelector('#agent-list ${specialistRow}') && !document.querySelector('#archived-agents').open`);
  await openChannels();
  await page.ready(`document.querySelector('${channelRow} p')?.textContent === '尚未指定助理'`);
  await rail();
  await activate('#archived-agents > summary');
  await page.ready(`document.querySelector('#archived-agent-list ${specialistRow} .agent-row-open')?.textContent.includes('已刪除') &&
    document.querySelector('#archived-agent-list ${specialistRow} .agent-row-start').hidden &&
    !document.querySelector('#sessions [data-session="${specialistSession}"]')`);
  await click(`#archived-agent-list [data-session="${specialistSession}"]`);
  await page.ready("document.querySelector('#prompt').disabled && document.querySelector('#messages .message.assistant')");
  await click(`#archived-agent-list ${specialistRow} .agent-row-open`);
  await visible('#restore-agent');
  await click('#restore-agent');
  await page.ready(`document.querySelector('#agent-list ${specialistRow}') && document.querySelector('#settings-status').textContent === '已還原助理。'`);
  await click('#close-agent');
  await click(`#sessions [data-session="${specialistSession}"]`);
  await page.ready("!document.querySelector('#prompt').disabled && document.querySelector('#messages .message.assistant')");
  await page.evaluate(`document.querySelector('${specialistRow} summary').focus()`);
  await press();
  await key('ArrowDown', 'ArrowDown', 40);
  await press();
  await visible('#delete-agent-dialog[open]');
  await click('#confirm-delete-agent');
  await page.ready(`!document.querySelector('#agent-list ${specialistRow}') && document.querySelector('#archived-agent-list [data-session="${specialistSession}"]')`);
  mapping.finish();
  console.log(JSON.stringify({ agentWorkbench: 'passed', viewports: matrix.length, locales: 2, themes: 2 }));
}
