import { errorText, request } from './api.js';
import { message, setText } from './i18n.js';

export const channelRequest = (data) => request('/api/settings/channels', { data });
export const channelErrorText = (error) => error.detail?.code === 'CHANNEL_ACCOUNT_IN_USE' ? message('channels.already-added') : errorText(error);

export function cancelTelegramSetup(setup) {
  if (setup?.setupId) void channelRequest({ action: 'setup-cancel', setupId: setup.setupId }).catch(() => {});
}

export function setupReady(setup) {
  return setup?.setupId && (!setup.ownerRequired || setup.ownerConfirmed);
}

export function channelNode(tag, text) {
  const element = document.createElement(tag);
  if (text) setText(element, text);
  return element;
}

export function telegramSetup(prefix, { account, initial, onChange }) {
  const box = channelNode('div');
  box.className = 'telegram-setup';
  const input = channelNode('input');
  Object.assign(input, { id: prefix + '-token', type: 'password', autocomplete: 'off', spellcheck: false, maxLength: 256 });
  const label = channelNode('label', message('channels.token'));
  label.htmlFor = input.id;
  const start = channelNode('button', message('channels.token-continue'));
  start.type = 'button';
  start.id = prefix + '-token-continue';
  const status = channelNode('p');
  status.setAttribute('role', 'status');
  const owner = channelNode('div');
  let setup = initial;
  let checking = false;
  let timer;

  function update(next) {
    setup = next;
    onChange(setup);
  }

  function show() {
    owner.replaceChildren();
    if (!setup) return;
    setText(status, setup.botName ? message('channels.found-bot', { bot: setup.botName }) : message('channels.bot-found'));
    if (!setup.ownerRequired) return;
    if (!setup.ownerName) {
      owner.append(channelNode('p', message('channels.send-start')));
      schedule();
      return;
    }
    const confirm = channelNode('input');
    confirm.id = prefix + '-owner-confirm';
    confirm.type = 'checkbox';
    confirm.checked = setup.ownerConfirmed === true;
    const confirmation = channelNode('label');
    confirmation.append(confirm, channelNode('span', message('channels.owner-confirm', { name: setup.ownerName })));
    confirm.addEventListener('change', () => update({ ...setup, ownerConfirmed: confirm.checked }));
    owner.append(confirmation);
  }

  function schedule() {
    clearTimeout(timer);
    const id = setup.setupId;
    timer = setTimeout(async () => {
      if (!box.isConnected || setup?.setupId !== id) return;
      try {
        const next = await channelRequest({ action: 'setup-check', setupId: id });
        if (!box.isConnected || setup?.setupId !== id) return;
        update(next);
        show();
      } catch (error) {
        if (!box.isConnected || setup?.setupId !== id) return;
        setText(status, channelErrorText(error));
        if (error.detail?.code === 'channel-setup-expired') {
          owner.replaceChildren();
          update(undefined);
        } else schedule();
      }
    }, 1200);
  }

  start.addEventListener('click', async () => {
    if (checking) return;
    const token = input.value.trim();
    if (!token) { input.focus(); return; }
    input.value = '';
    checking = true;
    start.disabled = true;
    cancelTelegramSetup(setup);
    update({ checking: true });
    owner.replaceChildren();
    setText(status, message('channels.checking-token'));
    try {
      const next = await channelRequest({ action: 'setup-start', token, ...(account && {
        accountId: account.accountId, bindingRevision: account.bindingRevision,
      }) });
      if (!box.isConnected) { cancelTelegramSetup(next); return; }
      update(next);
      show();
    } catch (error) { if (box.isConnected) { update(undefined); setText(status, channelErrorText(error)); } }
    finally { checking = false; start.disabled = false; }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      start.click();
    }
  });
  box.append(label, input, start, status, owner);
  show();
  return box;
}
