import assert from 'node:assert/strict';
import type { chromium } from './chromium.ts';
import { selectLocale } from './gui-locales.ts';

export async function verifyDictation(page: Awaited<ReturnType<typeof chromium>>, reload: () => Promise<void>) {
  assert.deepEqual(await page.evaluate(`({ secure: isSecureContext, top: window === window.top,
    microphone: document.featurePolicy.allowsFeature('microphone'), media: typeof navigator.mediaDevices?.getUserMedia })`),
    { secure: true, top: true, microphone: true, media: 'function' }, 'OEP loopback permits a microphone request');
  const click = (id: string) => page.evaluate("document.getElementById(" + JSON.stringify(id) + ").click()");
  const text = (id: string, value: string) => page.ready("document.getElementById(" + JSON.stringify(id) + ").textContent.includes(" + JSON.stringify(value) + ")");
  const error = (value: string) => text('error', value);
  const events = () => page.evaluate<string[]>('dictation.events.splice(0)');
  const set = (state: object) => page.evaluate('Object.assign(dictation, ' + JSON.stringify(state) + '); undefined');
  const focus = () => page.evaluate<string>('document.activeElement.id');
  const dialog = () => page.evaluate<boolean>("document.querySelector('#microphone-permission').open");
  const press = async (key: 'Tab' | 'Escape' | 'Enter', windowsVirtualKeyCode: number) => {
    await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, text: key === 'Enter' ? '\r' : undefined });
    await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
  };

  await page.evaluate(`
    window.dictation = { events: [], permission: 'prompt', brands: ['Chromium', 'Microsoft Edge'], transcript: '合成語音' };
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Synthetic Chromium' });
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => ({
      brands: dictation.brands.map(brand => ({ brand, version: '1' })),
    }) });
    navigator.permissions.query = async ({ name }) => {
      dictation.events.push('query:' + name);
      if (dictation.queryFails) throw new TypeError('Unsupported permission');
      return { state: dictation.permission };
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      dictation.events.push('media:' + JSON.stringify(constraints));
      if (dictation.mediaError) throw new DOMException('', dictation.mediaError);
      if (dictation.deferMedia) await new Promise(resolve => { dictation.releaseMedia = resolve; });
      return { getTracks: () => [{ stop() { dictation.events.push('track:stop'); } }] };
    };
    navigator.clipboard.writeText = async (url) => {
      dictation.clipboard = url;
      if (dictation.copyFails) throw new DOMException('', 'NotAllowedError');
    };
    window.SpeechRecognition = class {
      start() {
        dictation.events.push('speech:start');
        if (dictation.startError) throw new DOMException('', dictation.startError);
        queueMicrotask(() => {
          if (dictation.speechError) this.onerror({ error: dictation.speechError });
          else this.onresult({ resultIndex: 0, results: [[{ transcript: dictation.transcript }]] });
          this.onend();
        });
      }
      abort() { dictation.events.push('speech:abort'); }
    };
    window.webkitSpeechRecognition = window.SpeechRecognition;
  `);

  await click('microphone');
  await page.ready("document.querySelector('#prompt').value === '合成語音'");
  const captureOrder = ['media:{"audio":true}', 'track:stop', 'speech:start'];
  assert.deepEqual(await events(), captureOrder);

  await set({ mediaError: 'NotAllowedError', permission: 'denied' });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: false });
  await page.evaluate("document.querySelector('#microphone').focus()");
  await press('Enter', 13);
  await text('microphone-permission-title', '開啟麥克風權限');
  await text('microphone-permission-status', '麥克風權限已封鎖');
  await error('請在瀏覽器允許麥克風權限');
  assert.equal(await dialog(), true);
  assert.deepEqual(await events(), [captureOrder[0], 'query:microphone']);
  assert.equal(await focus(), 'recheck-microphone');
  assert.equal(await page.evaluate(`(() => {
    const dialog = document.querySelector('#microphone-permission');
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth;
  })()`), true, 'permission help fits a narrow viewport');
  await text('microphone-copy-help', '貼到瀏覽器的網址列');
  await press('Tab', 9);
  assert.equal(await focus(), 'copy-microphone-settings');
  await press('Enter', 13);
  const site = encodeURIComponent(await page.evaluate<string>('location.origin'));
  assert.equal(await page.evaluate('dictation.clipboard'), 'edge://settings/content/siteDetails?site=' + site);
  await text('microphone-copy-status', '已複製設定網址');
  await press('Tab', 9);
  assert.equal(await focus(), 'close-microphone-permission');
  await press('Escape', 27);
  assert.equal(await dialog(), false);
  assert.equal(await focus(), 'microphone');
  await page.command('Emulation.clearDeviceMetricsOverride');

  await selectLocale(page, 'en');
  await set({ brands: ['Chromium', 'Google Chrome'], queryFails: true });
  await click('microphone');
  await text('microphone-permission-title', 'Enable microphone access');
  await text('microphone-permission-status', 'couldn’t report the microphone permission');
  await text('microphone-copy-help', 'paste it into the browser’s address bar');
  for (const instruction of ['In Edge or Chrome', 'Set Microphone to Allow', 'Reload the OEP page']) {
    await text('microphone-permission', instruction);
  }
  await click('copy-microphone-settings');
  const chromeURL = 'chrome://settings/content/siteDetails?site=' + site;
  assert.equal(await page.evaluate('dictation.clipboard'), chromeURL);
  await text('microphone-copy-status', 'Settings URL copied');
  await set({ copyFails: true });
  await click('copy-microphone-settings');
  await text('microphone-copy-status', 'Copy the selected address');
  assert.deepEqual(await page.evaluate(`(() => {
    const input = document.querySelector('#microphone-settings-url');
    return [input.value, input.value.slice(input.selectionStart, input.selectionEnd), input.hidden];
  })()`), [chromeURL, chromeURL, false]);

  await events();
  await set({ queryFails: false, permission: 'prompt' });
  await click('recheck-microphone');
  await text('microphone-permission-status', 'The browser can ask for microphone access.');
  assert.equal(await dialog(), true);
  assert.deepEqual(await events(), ['query:microphone', captureOrder[0], 'query:microphone']);
  await set({ permission: 'granted', mediaError: '', transcript: 'English dictation' });
  await click('recheck-microphone');
  await page.ready("document.querySelector('#prompt').value === '合成語音 English dictation'");
  assert.equal(await dialog(), false);
  assert.deepEqual(await events(), ['query:microphone', ...captureOrder]);
  assert.equal(await focus(), 'prompt');
  assert.equal(await page.evaluate("document.querySelector('#error').hidden"), true);

  await selectLocale(page, 'zh-TW');
  for (const [mediaError, label] of [
    ['NotFoundError', '找不到麥克風'], ['NotReadableError', '無法啟用麥克風'], ['AbortError', '無法完成聽寫'],
  ]) {
    await set({ mediaError });
    await click('microphone');
    await error(label);
    assert.deepEqual(await events(), [captureOrder[0]]);
    assert.equal(await dialog(), false);
  }
  await set({ mediaError: '' });
  for (const [speechError, label] of [
    ['not-allowed', '請在瀏覽器允許麥克風權限'], ['audio-capture', '聽寫無法使用麥克風'],
    ['no-speech', '沒有聽到語音'], ['network', '無法完成聽寫'],
  ]) {
    await set({ speechError });
    await click('microphone');
    await error(label);
    if (speechError === 'not-allowed') {
      assert.equal(await dialog(), true);
      await text('microphone-permission-status', '麥克風權限已允許');
      await click('close-microphone-permission');
      assert.deepEqual(await events(), [...captureOrder, 'query:microphone']);
    } else {
      assert.equal(await dialog(), false);
      assert.deepEqual(await events(), captureOrder);
    }
  }

  await set({ speechError: '', transcript: '  ' });
  await click('microphone');
  await error('沒有聽到語音');
  assert.deepEqual(await events(), captureOrder);
  await set({ speechError: 'aborted' });
  await click('microphone');
  await page.ready("dictation.events.includes('speech:start') && document.querySelector('#microphone').getAttribute('aria-pressed') === 'false'");
  assert.deepEqual(await events(), captureOrder);
  assert.equal(await page.evaluate("document.querySelector('#error').hidden"), true);
  await set({ deferMedia: true });
  await click('microphone');
  assert.equal(await page.evaluate("document.querySelector('#microphone').getAttribute('aria-pressed')"), 'true');
  await click('microphone');
  await page.evaluate('dictation.releaseMedia()');
  await page.ready("dictation.events.includes('track:stop')");
  assert.deepEqual(await events(), captureOrder.slice(0, 2));
  assert.equal(await page.evaluate("document.querySelector('#microphone').getAttribute('aria-pressed')"), 'false');

  await selectLocale(page, 'en');
  await page.evaluate('dictation.Speech = window.SpeechRecognition; window.SpeechRecognition = window.webkitSpeechRecognition = undefined');
  await click('microphone');
  await error('This browser doesn’t support dictation');
  assert.deepEqual(await events(), []);
  await page.evaluate('window.webkitSpeechRecognition = dictation.Speech');
  await set({ deferMedia: false, speechError: '', startError: 'NotAllowedError' });
  await click('microphone');
  await error('The browser blocked microphone access for dictation');
  assert.equal(await dialog(), true);
  await text('microphone-permission-status', 'Microphone access is allowed.');
  await click('close-microphone-permission');
  assert.deepEqual(await events(), [...captureOrder, 'query:microphone']);

  await set({ startError: '', speechError: 'service-not-allowed' });
  await click('microphone');
  await error('Your browser’s speech service is unavailable on this computer');
  await error('You can still type your message.');
  assert.equal(await dialog(), false);
  assert.deepEqual(await events(), captureOrder);
  const disabled = "document.querySelector('#microphone').getAttribute('aria-disabled') === 'true'";
  assert.equal(await page.evaluate(disabled), true);
  const tooltip = "document.querySelector('#microphone').title";
  assert.match(await page.evaluate<string>(tooltip), /organization may have turned it off/);
  await selectLocale(page, 'zh-TW');
  assert.match(await page.evaluate<string>(tooltip), /公司政策/);
  await page.evaluate("document.querySelector('#error').hidden = true; document.querySelector('#microphone').focus()");
  await press('Enter', 13);
  await click('microphone');
  assert.deepEqual(await events(), []);
  assert.equal(await page.evaluate("document.querySelector('#error').hidden && !document.querySelector('#prompt').disabled"), true);

  await reload();
  assert.equal(await page.evaluate(disabled), true, 'the service stays disabled in the same tab after reload');
  await page.evaluate("sessionStorage.removeItem('oep.speech-service-unavailable')");
  await reload();
  assert.equal(await page.evaluate(disabled), false);
  console.log('Dictation: loopback policy, permission dialog, capture and recognition paths passed.');
}
