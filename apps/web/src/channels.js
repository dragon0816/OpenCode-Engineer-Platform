import { errorText, request } from './api.js';
import { agentButton, agentName, replyLanguage } from './agents.js';
import { message, optionText, setAttribute, setText, t } from './i18n.js';

const pollLabels = {
  disabled: message('channels.poll-disabled'), polling: message('channels.poll-polling'),
  verifying: message('channels.poll-verifying'), 'poll-conflict': message('channels.poll-conflict'),
  'credential-unavailable': message('server.channel-credential-unavailable'), 'identity-changed': message('server.channel-identity-changed'),
  'account-in-use': message('channels.poll-account-in-use'), 'verification-failed': message('server.channel-verification-failed'),
};
const actionLabels = { verify: message('channels.verify'), bind: message('channels.bind'), rebind: message('channels.rebind'),
  unbind: message('channels.unbind'), 'save-language': message('channels.save-language') };
const confirms = { bind: message('channels.confirm-bind'), rebind: message('channels.confirm-rebind'), unbind: message('channels.confirm-unbind') };
const botLabels = { 'telegram-main': message('channels.telegram-main'), 'telegram-bi': message('channels.telegram-bi') };
export const channelName = ({ accountId, botName }) => botName || botLabels[accountId] || accountId;

function node(tag, text) {
  const element = document.createElement(tag);
  if (text) setText(element, text);
  return element;
}

function cell(label) {
  const value = node('td');
  value.setAttribute('role', 'cell');
  const caption = node('strong', label);
  caption.className = 'channel-cell-label';
  caption.setAttribute('aria-hidden', 'true');
  value.append(caption);
  return value;
}

export function bindChannels(getAgents, refreshAgents) {
  const table = document.getElementById('channel-accounts');
  const form = document.getElementById('channel-new');
  const status = document.getElementById('channel-status');
  const target = document.getElementById('channel-agent');
  const reference = document.getElementById('channel-reference');
  const verify = document.getElementById('channel-verify');
  const bind = document.getElementById('channel-bind');
  let verifiedRef;

  function feedback(element, error) {
    if (error.detail?.code !== 'CHANNEL_ACCOUNT_IN_USE') {
      setText(element, errorText(error));
      return;
    }
    const owner = getAgents().find(({ id }) => id === error.detail.params?.agentId);
    if (!owner) { setText(element, errorText(error)); return; }
    const label = node('strong', agentName(owner));
    if (typeof agentName(owner) === 'string') label.setAttribute('data-ui-content', '');
    setText(element, message('channels.conflict'));
    element.append(' ', label);
  }

  function agents(select, id, biOnly = false) {
    const available = getAgents().filter((agent) => agent.state === 'active' && (!biOnly || agent.id === 'bi'));
    select.replaceChildren(...available.map((agent) => {
      const option = optionText(agentName(agent), agent.id);
      option.toggleAttribute('data-ui-content', typeof agentName(agent) === 'string');
      return option;
    }));
    if (available.some((agent) => agent.id === id)) select.value = id;
  }

  function row(account) {
    const { state, pollState, botName, agentId, accountId, bindingRevision, verified, handler } = account;
    const tr = node('tr');
    tr.dataset.channel = accountId;
    tr.setAttribute('role', 'row');
    const bot = node('th', channelName(account));
    bot.scope = 'row';
    bot.setAttribute('role', 'rowheader');
    if (botName || !['telegram-main', 'telegram-bi'].includes(accountId)) bot.setAttribute('data-ui-content', '');
    const assignment = cell(message('channels.agent'));
    const select = node('select');
    setAttribute(select, 'aria-label', message('channels.agent'));
    agents(select, agentId, handler === 'bi_intake');
    const assigned = getAgents().find(({ id }) => id === agentId);
    if (state !== 'disabled') {
      const label = node('p', agentName(assigned));
      label.toggleAttribute('data-ui-content', typeof agentName(assigned) === 'string');
      assignment.append(label);
    }
    assignment.append(select);
    const language = cell(message('agents.replyLocale'));
    const locale = replyLanguage(account.replyLocale);
    setAttribute(locale, 'aria-label', message('agents.replyLocale'));
    language.append(locale);
    locale.disabled = state === 'disabled';
    const polling = cell(message('channels.poll-status'));
    polling.append(node('p', verified ? message('channels.verified') : message('channels.unverified')),
      node('p', pollLabels[pollState]));
    const actions = cell(message('channels.actions'));
    const status = node('p');
    status.setAttribute('role', 'status');
    const operation = (key, action) => agentButton(actionLabels[key], async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await action(); }
      catch (error) { feedback(status, error); }
      finally { button.disabled = false; }
    });
    const mutate = async (action) => {
      if (!window.confirm(confirms[action]())) return;
      await request('/api/settings/channels', { data: { action, accountId, agentId: action === 'unbind' ? agentId : select.value,
        confirmed: true, bindingRevision } });
      await refreshAgents();
      await load(accountId);
    };
    const change = operation(state === 'enabled' ? 'rebind' : 'bind', () => mutate(state === 'enabled' ? 'rebind' : 'bind'));
    change.dataset.channelAction = 'bind';
    const verifyRow = operation('verify', async () => {
      await request('/api/settings/channels', { data: { action: 'verify', accountId } });
      setText(status, message('channels.verified'));
    });
    actions.append(verifyRow, change);
    if (state === 'enabled') actions.append(operation('unbind', () => mutate('unbind')));
    const saveLocale = operation('save-language', async () => {
      await request('/api/agents/' + agentId, { data: { action: 'edit', revision: assigned?.revision, replyLocale: locale.value } });
      await refreshAgents();
      await load(accountId);
    });
    if (state !== 'disabled') language.append(saveLocale);
    actions.append(status);
    tr.append(bot, assignment, language, polling, actions);
    return tr;
  }

  async function load(focus) {
    try {
      const { accounts } = await request('/api/settings/channels');
      agents(target, target.value);
      table.replaceChildren(...[...accounts].sort((first, second) => Number(second.state === 'enabled') - Number(first.state === 'enabled')).map(row));
      if (focus) table.querySelector(`[data-channel="${CSS.escape(focus)}"] [data-channel-action]`)?.focus();
    } catch (error) { setText(status, errorText(error)); }
  }

  reference.addEventListener('input', () => { bind.disabled = true; verifiedRef = undefined; });
  verify.addEventListener('click', async () => {
    const credentialRef = reference.value.trim();
    verify.disabled = true;
    bind.disabled = true;
    verifiedRef = undefined;
    try {
      const result = await request('/api/settings/channels', { data: { action: 'verify', credentialRef } });
      if (reference.value.trim() !== credentialRef) return;
      verifiedRef = credentialRef;
      bind.disabled = false;
      setText(status, result.botName ? message('channels.verified-bot', { bot: result.botName }) : message('channels.verified'));
    } catch (error) { feedback(status, error); }
    finally { verify.disabled = false; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!verifiedRef || reference.value.trim() !== verifiedRef || !target.value || bind.disabled || !window.confirm(t('channels.confirm-bind'))) return;
    bind.disabled = true;
    verify.disabled = true;
    try {
      await request('/api/settings/channels', { data: { action: 'bind', agentId: target.value, credentialRef: verifiedRef, confirmed: true } });
      reference.value = '';
      verifiedRef = undefined;
      setText(status, message('chat.saved'));
      await refreshAgents();
      await load();
    } catch (error) { feedback(status, error); }
    finally { bind.disabled = !verifiedRef; verify.disabled = false; }
  });
  document.getElementById('channel-refresh').addEventListener('click', () => { void load(); });
  return load;
}
