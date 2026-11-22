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
    button.textContent = '開始聽寫';
  }

  enabled.addEventListener('change', () => {
    localStorage.setItem('oep.microphone', enabled.checked ? 'on' : 'off');
    status.textContent = enabled.checked ? '可在輸入框啟動聽寫。' : '語音輸入已關閉。';
    update();
  });
  button.addEventListener('click', () => {
    if (recognition) { cancel(); return; }
    const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Speech) { report('這個瀏覽器無法使用聽寫。請直接輸入訊息。'); return; }
    const context = getContext();
    try {
      const capture = new Speech();
      recognition = capture;
      capture.lang = 'zh-TW';
      capture.interimResults = false;
      capture.onresult = (event) => {
        if (recognition !== capture || context !== getContext() || composer.disabled) return;
        const text = event.results[event.resultIndex]?.[0]?.transcript?.trim();
        if (!text) { report('沒有聽到語音。請再試一次，或直接輸入。'); return; }
        composer.value = (composer.value ? composer.value + ' ' + text : text).slice(0, composer.maxLength);
        composer.focus();
        report();
      };
      capture.onerror = (event) => {
        if (recognition !== capture) return;
        report(['not-allowed', 'service-not-allowed'].includes(event.error) ? '無法使用麥克風。請在瀏覽器允許麥克風權限。' : '無法完成聽寫。請再試一次。');
        cancel();
      };
      capture.onend = () => { if (recognition === capture) cancel(); };
      capture.start();
      button.setAttribute('aria-pressed', 'true');
      button.textContent = '取消聽寫';
    } catch (error) {
      cancel();
      report(error.name === 'NotAllowedError' ? '無法使用麥克風。請在瀏覽器允許麥克風權限。' : '無法完成聽寫。請再試一次。');
    }
  });
  update();
  return { update, cancel };
}
