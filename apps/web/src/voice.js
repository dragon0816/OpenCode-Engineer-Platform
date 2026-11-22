import { message, setText } from './i18n.js';
export function bindVoice(enabled, button, status, composer, getContext, report) {
  let recognition;
  enabled.checked = localStorage.getItem('oep.microphone') === 'on';

  function update() {
    button.hidden = !enabled.checked;
    button.disabled = composer.disabled;
    if (!enabled.checked || composer.disabled) cancel();
  }

  function cancel() {
    const prior = recognition;
    recognition = undefined;
    prior?.abort();
    button.setAttribute('aria-pressed', 'false');
    setText(button, message('ui.start-dictation'));
  }

  enabled.addEventListener('change', () => {
    localStorage.setItem('oep.microphone', enabled.checked ? 'on' : 'off');
    setText(status, enabled.checked ? message('voice.start-dictation-in-the-message-box') : message('voice.voice-input-is-off'));
    update();
  });
  button.addEventListener('click', () => {
    if (recognition) { cancel(); return; }
    const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Speech) { report(message('voice.this-browser-doesnt-support-dictation-enter-the')); return; }
    const context = getContext();
    try {
      const capture = new Speech();
      recognition = capture;
      capture.lang = 'zh-TW';
      capture.interimResults = false;
      capture.onresult = (event) => {
        if (recognition !== capture || context !== getContext() || composer.disabled) return;
        const text = event.results[event.resultIndex]?.[0]?.transcript?.trim();
        if (!text) { report(message('voice.no-speech-detected-try-again-or-type')); return; }
        composer.value = (composer.value ? composer.value + ' ' + text : text).slice(0, composer.maxLength);
        composer.focus();
        report();
      };
      capture.onerror = (event) => {
        if (recognition !== capture) return;
        report(['not-allowed', 'service-not-allowed'].includes(event.error) ? message('voice.could-not-access-the-microphone-allow-microphone') : message('voice.could-not-complete-dictation-try-again'));
        cancel();
      };
      capture.onend = () => { if (recognition === capture) cancel(); };
      capture.start();
      button.setAttribute('aria-pressed', 'true');
      setText(button, message('voice.cancel-dictation'));
    } catch (error) {
      cancel();
      report(error.name === 'NotAllowedError' ? message('voice.could-not-access-the-microphone-allow-microphone') : message('voice.could-not-complete-dictation-try-again'));
    }
  });
  update();
  return { update, cancel };
}
