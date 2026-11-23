import { message, setAttribute, setText } from './i18n.js';

const unavailableKey = 'oep.speech-service-unavailable';
const unavailableMessage = message('voice.speech-service-unavailable');
const permissionDenied = message('voice.microphone-access-denied');
const genericError = message('voice.could-not-complete-dictation-try-again');
const noSpeech = message('voice.no-speech-detected-try-again-or-type');
const mediaErrors = new Map([
  ['NotAllowedError', permissionDenied],
  ['NotFoundError', message('voice.microphone-not-found')],
  ['NotReadableError', message('voice.microphone-not-readable')],
]);
const speechErrors = new Map([
  ['not-allowed', permissionDenied],
  ['service-not-allowed', unavailableMessage],
  ['audio-capture', message('voice.microphone-capture-failed')],
  ['no-speech', noSpeech],
]);
const permissionMessages = new Map([
  ['denied', message('voice.microphone-status-denied')],
  ['granted', message('voice.microphone-status-granted')],
  ['prompt', message('voice.microphone-status-prompt')],
]);

function settingsURL() {
  const brands = navigator.userAgentData?.brands?.map(({ brand }) => brand) ?? [];
  let browser;
  if (brands.includes('Microsoft Edge') || /\bEdg\//.test(navigator.userAgent)) browser = 'edge';
  else if (brands.includes('Google Chrome') || brands.includes('Chromium') || /\bChrome\//.test(navigator.userAgent)) browser = 'chrome';
  return browser && `${browser}://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
}

async function microphonePermission() {
  try { return (await navigator.permissions?.query({ name: 'microphone' }))?.state; }
  catch { return undefined; }
}

export function bindVoice(enabled, button, status, composer, getContext, report) {
  const dialog = document.getElementById('microphone-permission');
  const permissionStatus = document.getElementById('microphone-permission-status');
  const copyHelp = document.getElementById('microphone-copy-help');
  const copy = document.getElementById('copy-microphone-settings');
  const copyStatus = document.getElementById('microphone-copy-status');
  const urlInput = document.getElementById('microphone-settings-url');
  const recheck = document.getElementById('recheck-microphone');
  const close = document.getElementById('close-microphone-permission');
  let attempt;
  let permissionCheck;
  let url;
  let serviceUnavailable = sessionStorage.getItem(unavailableKey) === '1';
  enabled.checked = localStorage.getItem('oep.microphone') === 'on';

  function update() {
    button.hidden = !enabled.checked;
    button.disabled = composer.disabled;
    if (!enabled.checked || composer.disabled) cancel();
  }

  function disableDictation() {
    button.setAttribute('aria-disabled', 'true');
    setAttribute(button, 'title', unavailableMessage);
    setAttribute(button, 'aria-description', unavailableMessage);
  }

  function finish() {
    attempt = undefined;
    recheck.removeAttribute('aria-disabled');
    button.setAttribute('aria-pressed', 'false');
    setText(button, message('ui.start-dictation'));
  }

  function cancel() {
    const prior = attempt;
    if (prior) {
      finish();
      prior.recognition?.abort();
    }
    if (dialog.open) dialog.close();
  }

  async function refreshPermission() {
    const check = microphonePermission();
    permissionCheck = check;
    const state = await check;
    if (permissionCheck === check && dialog.open) {
      setText(permissionStatus, permissionMessages.get(state) ?? message('voice.microphone-status-unknown'));
    }
  }

  function showPermissionHelp() {
    if (!dialog.open) {
      url = settingsURL();
      copyHelp.hidden = copy.hidden = !url;
      copyStatus.hidden = urlInput.hidden = true;
      setText(permissionStatus, '');
      dialog.showModal();
    }
    void refreshPermission();
  }

  function fail(reason) {
    finish();
    if (reason === permissionDenied) {
      showPermissionHelp();
    } else if (dialog.open) {
      dialog.close();
    }
    if (reason === unavailableMessage) {
      serviceUnavailable = true;
      sessionStorage.setItem(unavailableKey, '1');
      disableDictation();
    }
    if (reason) report(reason);
  }

  async function start() {
    if (attempt || !enabled.checked || composer.disabled || serviceUnavailable) return;
    const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Speech || !navigator.mediaDevices?.getUserMedia) {
      fail(message('voice.this-browser-doesnt-support-dictation-enter-the'));
      return;
    }
    const current = { context: getContext(), recognition: undefined };
    attempt = current;
    recheck.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-pressed', 'true');
    setText(button, message('voice.cancel-dictation'));
    if (dialog.open) void refreshPermission();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (error) {
      if (attempt === current) fail(mediaErrors.get(error.name) ?? genericError);
      return;
    }
    if (attempt !== current) return;
    if (dialog.open) dialog.close();

    try {
      const capture = new Speech();
      current.recognition = capture;
      capture.lang = 'zh-TW';
      capture.interimResults = false;
      capture.onresult = (event) => {
        if (attempt !== current || current.context !== getContext() || composer.disabled) return;
        const text = event.results[event.resultIndex]?.[0]?.transcript?.trim();
        if (!text) { report(noSpeech); return; }
        composer.value = (composer.value ? composer.value + ' ' + text : text).slice(0, composer.maxLength);
        composer.focus();
        report();
      };
      capture.onerror = (event) => {
        if (attempt === current) fail(event.error === 'aborted' ? undefined : speechErrors.get(event.error) ?? genericError);
      };
      capture.onend = () => { if (attempt === current) finish(); };
      report();
      capture.start();
    } catch (error) {
      if (attempt === current) fail(mediaErrors.get(error.name) ?? genericError);
    }
  }

  enabled.addEventListener('change', () => {
    localStorage.setItem('oep.microphone', enabled.checked ? 'on' : 'off');
    setText(status, enabled.checked ? message('voice.start-dictation-in-the-message-box') : message('voice.voice-input-is-off'));
    update();
  });
  button.addEventListener('click', () => {
    if (attempt) cancel();
    else void start();
  });
  recheck.addEventListener('click', start);
  close.addEventListener('click', cancel);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancel();
  });
  copy.addEventListener('click', async () => {
    const address = url;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      if (!dialog.open) return;
      urlInput.hidden = true;
      setText(copyStatus, message('voice.settings-url-copied'));
    } catch {
      if (!dialog.open) return;
      urlInput.value = address;
      urlInput.hidden = false;
      urlInput.focus();
      urlInput.select();
      setText(copyStatus, message('voice.copy-failed'));
    }
    copyStatus.hidden = false;
  });
  if (serviceUnavailable) disableDictation();
  update();
  return { update, cancel };
}
