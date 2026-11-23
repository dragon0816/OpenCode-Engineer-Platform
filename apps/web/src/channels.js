import { errorText, request } from './api.js';
import { agentButton, agentName } from './agents.js';
import { message, optionText, setAttribute, setText, t } from './i18n.js';
import { cancelTelegramSetup, channelErrorText, channelNode as node, channelRequest, setupReady, telegramSetup } from './telegram-setup.js';

const botLabels = { 'telegram-main': message('channels.telegram-main'), 'telegram-bi': message('channels.telegram-bi') };
export const channelName = ({ accountId, botName }) => botName || botLabels[accountId] || message('channels.bot');

const channelStates = {
  unassigned: [null, message('channels.hint-unassigned')],
  'working': [message('channels.status-working'), message('channels.hint-working')],
  'checking': [message('channels.status-checking'), message('channels.hint-checking')],
  'paused': [message('channels.status-paused'), message('channels.hint-paused')],
  'other-app': [message('channels.status-other-app'), message('channels.hint-other-app')],
  'needs-token': [message('channels.status-needs-token'), message('channels.hint-needs-token')],
  'duplicate': [message('channels.status-duplicate'), message('channels.hint-duplicate')],
};

function channelState(account) {
  if (account.state === 'disabled') return 'unassigned';
  return {
    disabled: 'paused', polling: 'working', verifying: 'checking', 'poll-conflict': 'other-app',
    'credential-unavailable': 'needs-token', 'identity-changed': 'needs-token', 'account-in-use': 'duplicate',
    'verification-failed': 'needs-token',
  }[account.pollState];
}

function credentialDetails(accountId) {
  const details = node('details');
  const reference = node('code');
  reference.setAttribute('data-ui-content', '');
  details.append(node('summary', message('ui.advanced')), node('p', message('channels.advanced-reference')), reference);
  details.addEventListener('toggle', async () => {
    if (!details.open || reference.textContent) return;
    const bytes = new TextEncoder().encode(accountId);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    reference.textContent = 'OEP_TELEGRAM_BOT_' + hex.toUpperCase() + '_BOT_TOKEN';
  });
  return details;
}

function bindDelegationBudgets() {
  const path = '/api/settings/delegation-budgets';
  const form = document.getElementById('delegation-budgets');
  const options = document.getElementById('delegation-budget-options');
  const fields = document.getElementById('delegation-budget-fields');
  const custom = document.getElementById('delegation-budget-current');
  const save = document.getElementById('save-delegation-budgets');
  const status = document.getElementById('delegation-budget-status');
  const labels = {
    delegationsPerMessage: message('delegations.delegationsPerMessage'),
    executionMsPerDelegation: message('delegations.executionMsPerDelegation'),
    modelRequestsPerDelegation: message('delegations.modelRequestsPerDelegation'),
    toolCallsPerDelegation: message('delegations.toolCallsPerDelegation'),
    modelRequestsPerMessage: message('delegations.modelRequestsPerMessage'),
    toolCallsPerMessage: message('delegations.toolCallsPerMessage'),
    queueMs: message('delegations.queueMs'),
  };
  const presetLabels = {
    lean: message('delegations.lean'),
    standard: message('delegations.standard'),
    relaxed: message('delegations.relaxed'),
  };
  const toMinutes = (key) => key === 'executionMsPerDelegation' || key === 'queueMs' ? 60_000 : 1;
  let current;
  let loading;

  function select(preset, values) {
    current = preset;
    custom.hidden = preset !== 'custom';
    for (const input of options.querySelectorAll('input')) input.checked = input.value === current;
    if (values) for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value / toMinutes(key);
  }

  function render({ values, fields: limits, preset, presets }) {
    for (const [key, label] of Object.entries(presetLabels)) {
      const item = node('label');
      const input = node('input');
      Object.assign(input, { type: 'radio', name: 'preset', value: key, id: 'delegation-preset-' + key });
      const summary = node('span');
      summary.append(node('strong', label), node('small', message('delegations.preset-description', {
        count: presets[key].delegationsPerMessage, minutes: presets[key].executionMsPerDelegation / 60_000,
      })));
      input.addEventListener('change', () => { select(key, presets[key]); setText(status, ''); });
      item.append(input, summary);
      options.append(item);
    }
    for (const [key, { min, max }] of Object.entries(limits)) {
      const input = node('input');
      const unit = toMinutes(key);
      Object.assign(input, { type: 'number', required: true, name: key, id: 'budget-' + key, min: min / unit, max: max / unit,
        step: unit === 1 ? '1' : 'any' });
      const label = node('label', labels[key]);
      label.htmlFor = input.id;
      const row = node('div');
      row.append(label, input);
      fields.append(row);
    }
    select(preset, values);
    save.disabled = false;
  }

  fields.addEventListener('input', () => { select('custom'); setText(status, ''); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const data = current === 'custom' ? Object.fromEntries([...fields.querySelectorAll('input')].map(({ name, valueAsNumber }) =>
      [name, Math.round(valueAsNumber * toMinutes(name))])) : { preset: current };
    try {
      const { preset, values } = await request(path, { data });
      select(preset, values);
      setText(status, message('chat.saved'));
    } catch (error) { setText(status, errorText(error)); }
    finally { save.disabled = false; }
  });
  return async () => {
    if (fields.childElementCount || loading) return;
    loading = true;
    try { render(await request(path)); }
    catch (error) { setText(status, errorText(error)); }
    finally { loading = false; }
  };
}

export function bindChannels(getAgents, refreshAgents) {
  const list = document.getElementById('channel-accounts');
  const add = document.getElementById('channel-add');
  const dialog = document.getElementById('channel-dialog');
  const status = document.getElementById('channel-status');
  const loadBudgets = bindDelegationBudgets();
  let entries = [];
  let rendered;
  let loadVersion = 0;

  function row(account) {
    const item = node('li');
    item.dataset.channel = account.accountId;
    const assigned = account.state === 'disabled' ? undefined : getAgents().find(({ id }) => id === account.agentId);
    const bot = node('strong', channelName(account));
    const assignment = node('p', assigned ? agentName(assigned) : message('channels.no-assistant'));
    bot.toggleAttribute('data-ui-content', Boolean(account.botName));
    assignment.toggleAttribute('data-ui-content', Boolean(assigned && typeof agentName(assigned) === 'string'));
    const identity = node('div');
    identity.append(bot, assignment);
    const info = node('div');
    const state = channelState(account);
    const [label, hint] = channelStates[state];
    if (label) info.append(node('strong', label));
    info.append(node('p', hint));
    const manage = agentButton(message('channels.manage'), () => open(account, false, manage));
    setAttribute(manage, 'aria-label', message('channels.manage-bot', { bot: channelName(account) }));
    manage.dataset.channelAction = 'manage';
    item.append(identity, info, manage);
    return item;
  }

  async function load() {
    const version = ++loadVersion;
    try {
      const { accounts } = await channelRequest();
      if (version !== loadVersion) return;
      entries = accounts;
      const key = JSON.stringify([accounts, getAgents().map(({ id, name, state }) => [id, name, state])]);
      if (key === rendered) return;
      rendered = key;
      const focused = document.activeElement.closest('[data-channel]')?.dataset.channel;
      list.replaceChildren(...entries.map(row));
      if (focused) manageButton(focused)?.focus();
      if (!entries.length) list.append(node('li', message('channels.no-bots')));
    } catch (error) {
      if (version === loadVersion) setText(status, errorText(error));
    }
  }

  function manageButton(id) {
    return list.querySelector(`[data-channel="${CSS.escape(id)}"] button`);
  }

  function open(account, replace, opener) {
    if (dialog.open) return;
    const heading = node('h2', account ? message('channels.manage-bot', { bot: channelName(account) }) : message('channels.add-bot'));
    heading.id = 'channel-dialog-title';
    const form = node('form');
    const feedback = node('p');
    feedback.id = 'channel-dialog-status';
    feedback.setAttribute('role', 'status');
    const tokenPanel = node('div');
    const assignment = node('div');
    const label = node('label', message('channels.agent'));
    const select = node('select');
    select.id = 'channel-agent';
    label.htmlFor = select.id;
    const original = account?.state === 'disabled' ? '' : account?.agentId ?? '';
    const active = getAgents().filter(({ id, state }) => state === 'active' && (account?.handler !== 'bi_intake' || id === 'bi'));
    select.append(optionText(message('channels.no-assistant'), ''), ...active.map((agent) => {
      const option = optionText(agentName(agent), agent.id);
      option.toggleAttribute('data-ui-content', typeof agentName(agent) === 'string');
      return option;
    }));
    select.value = original;
    const confirm = node('input');
    confirm.id = 'channel-confirm-assignment';
    confirm.type = 'checkbox';
    const confirmLabel = node('label');
    confirmLabel.append(confirm, node('span', message('channels.confirm-assignment')));
    assignment.append(label, select, confirmLabel);
    let setup;
    let editingToken = !account;
    let busy = false;
    let removed = false;
    const save = node('button', message('channels.save-bot'));
    save.id = 'channel-save';
    save.type = 'submit';
    const close = agentButton(message('agents.cancel'), () => dialog.close());
    close.id = 'channel-close';
    const actions = node('div');
    actions.className = 'settings-actions';
    actions.append(save, close);

    function sync() {
      const ready = Boolean(setupReady(setup));
      const change = Boolean(account && select.value !== original);
      assignment.hidden = !account && !ready;
      confirmLabel.hidden = !change;
      close.disabled = busy;
      save.disabled = busy || change && !confirm.checked || (editingToken ? !ready || !account && !select.value : !change);
    }

    function editToken() {
      editingToken = true;
      const editor = telegramSetup('channel', { account, onChange(next) { setup = next; sync(); } });
      tokenPanel.replaceChildren(editor);
      sync();
      editor.querySelector('input').focus();
    }

    async function perform(button, work) {
      if (busy) return;
      busy = true;
      sync();
      button.disabled = true;
      setText(feedback, message('chat.saving'));
      try { await work(); }
      catch (error) { setText(feedback, channelErrorText(error)); }
      finally { busy = false; button.disabled = false; sync(); }
    }

    const target = account && { accountId: account.accountId, bindingRevision: account.bindingRevision };
    if (account) {
      const current = node('p', account.verified ? (account.botName ? message('channels.token-configured-bot', { bot: account.botName }) :
        message('channels.token-configured')) : message('channels.status-needs-token'));
      const replaceButton = agentButton(message('channels.replace-token'), editToken);
      replaceButton.id = 'channel-replace-token';
      tokenPanel.append(current, replaceButton);
      const recheck = agentButton(message('channels.recheck'), () => perform(recheck, async () => {
        await channelRequest({ action: 'recheck', ...target });
        setText(feedback, message('channels.rechecked'));
        await load();
      }));
      recheck.className = 'channel-text-button';
      recheck.id = 'channel-recheck';
      const remove = agentButton(message('channels.remove-bot'), () => {
        if (busy) return;
        if (!window.confirm(t('channels.confirm-remove'))) return;
        void perform(remove, async () => {
          await channelRequest({ action: 'remove', ...target, confirmed: true });
          removed = true;
          await updated();
        });
      });
      remove.className = 'danger-action';
      remove.id = 'channel-remove';
      actions.append(recheck, remove);
    } else editToken();

    async function updated() {
      const focus = account?.accountId;
      dialog.close();
      await refreshAgents().catch(() => {});
      await load();
      if (!dialog.open) (focus && manageButton(focus) || add).focus();
      setText(status, removed ? message('channels.removed') : message('chat.saved'));
    }

    select.addEventListener('change', () => { confirm.checked = false; sync(); });
    confirm.addEventListener('change', sync);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (save.disabled) return;
      void perform(save, async () => {
        if (editingToken) {
          await channelRequest({ action: 'setup-save', setupId: setup.setupId, ownerConfirmed: setup.ownerConfirmed === true,
            agentId: select.value || null, confirmed: true });
          setup = undefined;
        } else {
          const action = !select.value ? 'unbind' : account.state === 'enabled' ? 'rebind' : 'bind';
          await channelRequest({ action, ...target, ...(select.value && { agentId: select.value }), confirmed: true });
        }
        await updated();
      });
    });
    dialog.oncancel = (event) => { if (busy) event.preventDefault(); };
    dialog.addEventListener('close', () => {
      cancelTelegramSetup(setup);
      dialog.replaceChildren();
      if (opener?.isConnected) opener.focus();
    }, { once: true });
    form.append(tokenPanel, assignment, actions, feedback);
    if (account?.managedToken) form.append(credentialDetails(account.accountId));
    dialog.replaceChildren(heading, form);
    sync();
    dialog.showModal();
    if (replace) editToken();
    else if (!account) form.querySelector('input').focus();
  }

  add.addEventListener('click', () => open(undefined, false, add));
  setInterval(() => {
    if (!list.closest('[hidden]') && !dialog.open) void load();
  }, 5000);

  return async (replaceAccountId) => {
    await Promise.all([load(), loadBudgets()]);
    if (replaceAccountId) {
      const account = entries.find(({ accountId }) => accountId === replaceAccountId);
      if (account) open(account, true, manageButton(replaceAccountId));
    }
  };
}
