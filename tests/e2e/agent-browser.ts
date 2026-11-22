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
};

const reference = 'OEP_TELEGRAM_SAMPLE_BOT_TOKEN';
const duplicate = 'OEP_TELEGRAM_DUPLICATE_BOT_TOKEN';
const name = '資料查核';
const reviewID = 'sample-agent-review';

export async function verifyAgentWorkbench({ page, runtime, click, key, reload, selectSetting, captures }: Options) {
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
    await visible('#channel-accounts tr');
  };

  await page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.ready('innerWidth === 1440');
  await rail();
  const initialCount = await page.evaluate<number>("document.querySelectorAll('#agent-list [data-agent]').length");
  await mapping.check('agent-rail', '#rail-assistants', { selectors: ['#new-agent', '[data-agent=main] .agent-row-start', '[data-agent=bi]', '[data-agent=main] summary'] });
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
  await setValue('#agent-channel-reference', reference);
  await click('#agent-channel-reference + button');
  await page.ready("document.querySelector('#agent-channel').selectedOptions[0]?.textContent === '@SampleDataBot'");
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
    '#agent-tab-channel', '#agent-tab-trigger', '#agent-tab-ability', '#agent-model', '#agent-reply-locale', '#save-assistant'] });
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
  await setValue('#channel-reference', duplicate);
  await click('#channel-verify');
  await page.ready("document.querySelector('#channel-status').textContent.includes('此 Telegram 帳號已綁定') && document.querySelector('#channel-bind').disabled");
  await setValue('#channel-reference', '');
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
    if (!captures) return;
    const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(join('docs', 'validation', 'gui', `slice4-${label}-${locale}-${viewport}-${theme}.png`), Buffer.from(data, 'base64'));
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
    for (const locale of captures ? ['zh-TW', 'en'] as const : ['zh-TW'] as const) {
      await selectLocale(page, locale);
      for (const theme of captures ? ['light', 'dark'] : ['light']) {
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
          await check('#settings-channels', '#channel-refresh', viewport + ' channels');
          assert.equal(await page.evaluate("document.querySelector('#channel-accounts .channel-cell-label').checkVisibility()"), width < 800);
        }
        await shot('channels', theme, viewport, locale);
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
  const binding = await page.evaluate<string>(`[...document.querySelectorAll('#channel-accounts tr')]
    .find(row => row.querySelector('th').textContent === '@SampleDataBot').dataset.channel`);
  await page.evaluate('window.confirm = () => true');
  const channelRow = `[data-channel="${binding}"]`;
  await setValue(`${channelRow} td:first-of-type select`, 'main');
  await click(`${channelRow} [data-channel-action=bind]`);
  await page.ready(`document.querySelector('${channelRow} td:first-of-type p')?.textContent === '合成助理'`);
  await setValue(`${channelRow} td:first-of-type select`, specialist);
  await click(`${channelRow} [data-channel-action=bind]`);
  await page.ready(`document.querySelector('${channelRow} td:first-of-type p')?.textContent === ${JSON.stringify(name)}`);
  await page.evaluate(`document.querySelector('${channelRow} td:last-child button:nth-of-type(3)').click()`);
  await page.ready(`document.querySelector('${channelRow} [data-channel-action=bind]')?.textContent === '綁定'`);
  await rail();
  await page.evaluate(`document.querySelector('${specialistRow} summary').click()`);
  await click(`${specialistRow} .menu-actions button:nth-child(2)`);
  await page.ready(`!document.querySelector('#agent-list ${specialistRow}') && document.querySelector('[data-session="${specialistSession}"]')`);
  await activate('#archived-agents > summary');
  await page.ready(`document.querySelector('#archived-agent-list ${specialistRow} .agent-row-open')?.textContent.includes('已封存') &&
    document.querySelector('#archived-agent-list ${specialistRow} .agent-row-start').hidden`);
  await click(`[data-session="${specialistSession}"]`);
  await page.ready("document.querySelector('#prompt').disabled && document.querySelector('#messages .message.assistant')");
  mapping.finish();
  console.log(JSON.stringify({ agentWorkbench: 'passed', viewports: matrix.length, locales: 2, themes: 2 }));
}
