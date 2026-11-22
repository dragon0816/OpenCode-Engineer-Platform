import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from '../../scripts/phase0/probe-http.ts';
import { assertContrastInThemes } from './gui-contrast.ts';
import { assertUiTextInThemes, inThemes } from './forbidden-shell-text.ts';
import { assertWorkbenchFits, inLocales } from './gui-locales.ts';
import { mappingChecks } from './gui-mapping.ts';
import type { chromium } from './chromium.ts';
import type { webAPI } from './web-api.ts';

export const delegationExport = 'Synthetic delegation output\nThe checked measurements agree.';
export const delegationSource = 'Synthetic evidence identifies zircon as the calibration material.';

type Options = {
  page: Awaited<ReturnType<typeof chromium>>;
  api: Awaited<ReturnType<typeof webAPI>>;
  targets: string[];
  fileId: (id: string) => void;
  click: (selector: string) => Promise<void>;
  key: (key: string, code: string, windowsVirtualKeyCode: number) => Promise<void>;
  reload: () => Promise<void>;
  captures: boolean;
};

export async function verifyDelegationWorkbench({ page, api, targets, fileId, click, key, reload, captures }: Options) {
  const json = async (response: Response, status = 200) => {
    assert.equal(response.status, status);
    return response.json();
  };
  for (const name of ['量測核對', '資料整理']) {
    const { revision } = await json(await api.get('/api/agents'));
    const created = await json(await api.post('/api/agents', { revision, name }), 201);
    targets.push(created.agent.id);
  }
  const session = await json(await api.post('/api/sessions', { agent: 'inspector' }), 201);
  const path = '/api/sessions/' + session.id;
  await page.evaluate(`localStorage.setItem('oep.activeSession', ${JSON.stringify(session.id)}); localStorage.setItem('oep.locale','zh-TW')`);
  await reload();
  await page.evaluate("document.querySelector('#open-chat').click()");

  await page.evaluate(`(() => {
    window.delegationHints = 0;
    const source = new EventSource(${JSON.stringify(path + '/events')});
    source.addEventListener('activity', event => { if (JSON.parse(event.data).kind === 'delegation') window.delegationHints++; });
    window.delegationEventProbe = source;
  })()`);
  const send = (text: string) => page.evaluate(`document.querySelector('#prompt').value = ${JSON.stringify(text)};
    document.querySelector('#composer').requestSubmit();`);
  const wide = () => page.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrow = () => page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const escape = () => key('Escape', 'Escape', 27);
  const closePanel = () => page.ready("document.querySelector('#chat-files').hidden");
  const snapshot = async (screen: string, width: string) => {
    if (!captures) return;
    await inLocales(page, (locale) => inThemes(page, async (theme) => {
      const { data } = await page.command<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join('docs', 'validation', 'gui', `slice6-${screen}-${locale}-${width}-${theme}.png`), Buffer.from(data, 'base64'));
    }));
  };

  await wide();
  await send('SYNTHETIC_DELEGATION_RESULTS');
  const cards = '.delegation-card';
  await page.ready(`document.querySelectorAll('${cards}').length === 2 &&
    document.querySelector('.message.assistant:has(${cards})')?.textContent.includes('已交辦') &&
    document.querySelector('${cards}[data-status="succeeded"]') &&
    document.querySelector('${cards}[data-status="running"]') && !document.querySelector('#send').disabled`, 25_000);
  const state = await json(await api.get(path + '/state'));
  const [finished, running] = state.delegations;
  assert.equal(finished.status, 'succeeded');
  assert.equal(running.status, 'running');
  assert.equal(finished.unread, true);
  const selector = (id: string) => `[data-delegation="${id}"]`;
  const first = selector(finished.delegationId);
  const second = selector(running.delegationId);
  const [file] = finished.files;
  const resultUrl = '/api/delegations/' + finished.delegationId + '/files/' + file.fileId;
  const download = await api.get(resultUrl);
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.equal(download.status, 200);
  assert.equal(downloaded.toString(), delegationExport);
  assert.equal(download.headers.get('x-oep-sha256'), createHash('sha256').update(downloaded).digest('hex'));
  assert.equal(await (await api.get(resultUrl + '/preview')).text(), delegationExport);
  const mapping = mappingChecks(page, 'delegation');
  await mapping.check('delegation-card', first, { selectors: ['.delegation-status', '.delegation-unread', '.delegation-files a[download]'],
    labels: ['查看執行紀錄', '標為已讀', '預覽', '下載'] });
  await mapping.check('delegation-cancel', second, { labels: ['取消交辦'] });
  await assertUiTextInThemes(page, cards);
  await assertContrastInThemes(page, [{ selector: first + ' .delegation-status' }, { selector: first + ' .delegation-unread' }]);
  await page.evaluate(`document.querySelector('${second}').scrollIntoView({ block: 'end' })`);
  await snapshot('cards', 'wide');

  const openFirst = first + ' [data-feature-focus$="-run"]';
  const openSecond = second + ' [data-feature-focus$="-run"]';
  await click(openFirst);
  await page.ready("document.querySelector('#file-preview [role=tabpanel]:not([hidden])')?.textContent.includes('執行與效果時間線')");
  await mapping.check('delegation-run', '#file-preview [role=tabpanel]:not([hidden])', {
    selectors: ['.delegation-timeline', '.delegation-transcript', '.tool-card', '.delegation-files a[download]'], labels: ['預覽', '下載'],
  });
  await assertUiTextInThemes(page, '#chat-files');
  await assertContrastInThemes(page, [{ selector: '.delegation-timeline li span' }]);
  await snapshot('run', 'wide');
  await click(openSecond);
  await page.ready("document.querySelectorAll('#panel-tabs [role=tab]').length === 2");
  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.match(await page.evaluate<string>('document.activeElement.textContent'), /量測核對/);
  await escape();
  await closePanel();

  await narrow();
  await assertWorkbenchFits(page, 'delegation cards narrow');
  await page.evaluate(`document.querySelector('${first}').scrollIntoView({ block: 'start' })`);
  await snapshot('cards', 'narrow');
  if (captures) {
    await page.evaluate(`document.querySelector('${second}').scrollIntoView({ block: 'start' })`);
    await snapshot('running', 'narrow');
  }
  await page.evaluate(`document.querySelector('${openFirst}').focus()`);
  await key('Enter', 'Enter', 13);
  await page.ready(`document.querySelector('#chat-files').getAttribute('aria-modal') === 'true' &&
    document.querySelector('.delegation-timeline')?.checkVisibility()`);
  assert.equal(await page.evaluate(`document.querySelector('#chat-files').getBoundingClientRect().width === innerWidth &&
    document.querySelector('#work-area').inert`), true);
  await assertWorkbenchFits(page, 'delegation run narrow');
  await snapshot('run', 'narrow');
  await escape();
  await closePanel();
  assert.equal(await page.evaluate(`document.activeElement === document.querySelector('${openFirst}')`), true);
  await page.ready(`!document.querySelector('${first} .delegation-unread')`);

  await send('SYNTHETIC_DELEGATION_FOLLOWUP');
  await until(async () => (await json(await api.get(path + '/state'))).runs.length === 2 || undefined, 10_000);
  const cancel = second + ' [data-feature-focus$="-cancel"]';
  const confirmCancel = (confirmed: boolean) => page.evaluate(`(() => {
    const original = window.confirm;
    let prompt;
    window.confirm = (text) => { prompt = text; return ${confirmed}; };
    try {
      document.querySelector(${JSON.stringify(cancel)}).click();
      return prompt;
    } finally { window.confirm = original; }
  })()`);
  const cancelPrompt = '確定取消交辦給「資料整理」的工作？';
  assert.equal(await confirmCancel(false), cancelPrompt);
  assert.equal((await json(await api.get('/api/delegations/' + running.delegationId))).receipt.status, 'running');
  assert.equal(await confirmCancel(true), cancelPrompt);
  await page.ready(`document.querySelector('${second}[data-status="cancelled"]') &&
    document.querySelector('#messages').textContent.includes('已核對交辦結果')`, 20_000);
  const events = await page.evaluate<number>('window.delegationHints');
  assert.ok(events >= 3, 'Expected independent delegation SSE invalidations');
  await reload();
  await page.ready(`document.querySelector('${first}[data-status="succeeded"]') &&
    !document.querySelector('${first} .delegation-unread') && document.querySelector('${second}[data-status="cancelled"] .delegation-unread')`);

  await wide();
  const attachment = await json(await api.upload(path + '/attachments', 'calibration.txt', delegationSource), 201);
  fileId(attachment.id);
  const runId = 'd17cf068-522c-4762-89d0-6aeec93402ed';
  await json(await api.post(path + '/turns', { id: runId, text: '做成 BI 卡片', attachments: [attachment.id], workbook: false }), 202);
  const bi = await until(async () => (await json(await api.get(path + '/state'))).delegations
    .find((item: { parentRunId: string; reviewRef?: object }) => item.parentRunId === runId && item.reviewRef), 20_000);
  const third = selector(bi.delegationId);
  await page.ready(`document.querySelector('${third}')?.textContent.includes('已送審')`);
  await mapping.check('delegation-bi', third, { labels: ['查看審核'] });
  await click(third + ' [data-feature-focus$="-review"]');
  await page.ready("document.querySelector('#file-preview [role=tabpanel]:not([hidden]) .review-agent-source')?.textContent.includes('BI 資料處理')");
  assert.equal(await page.evaluate("document.querySelector('#chat-view').hidden"), false);
  const reviewPath = '/api/knowledge/reviews';
  const { reviews } = await json(await api.get(reviewPath));
  const review = reviews.find((row: { id: string }) => row.id === bi.reviewRef.reviewId);
  assert.equal(review.status, 'pending');
  assert.equal(await (await api.post(reviewPath, { action: 'publish', id: review.id })).status, 422);
  await json(await api.post(reviewPath, { action: 'approve', id: review.id, edit: review.edit }));
  await json(await api.post(reviewPath, { action: 'publish', id: review.id }));
  await page.ready(`document.querySelector('${third}')?.textContent.includes('BI 審核已發布。')`);
  await json(await api.post(reviewPath, { action: 'publish', id: review.id }));
  await reload();
  await page.ready(`[...document.querySelectorAll('${third} [role=status]')].filter(element =>
    element.textContent === 'BI 審核已發布。').length === 1`);
  mapping.finish();
  await page.command('Emulation.clearDeviceMetricsOverride');
}
