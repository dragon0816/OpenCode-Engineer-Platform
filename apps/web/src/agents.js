import { bindFilePicker, message, optionText, resolveText, setAttribute, setText, t } from './i18n.js';
import { errorText, projectLabel, request } from './api.js';
import { classificationControl } from './external-helpers.js';
import { cancelTelegramSetup, setupReady, telegramSetup } from './telegram-setup.js';

const steps = ['basic', 'model', 'knowledge', 'ability', 'channel', 'trigger', 'confirm'];
const detailTabs = ['basic', 'model', 'knowledge', 'channel', 'trigger', 'ability'];
const detailFields = ['name', 'introduction', 'instructions', 'avatar', 'defaultModel', 'replyLocale', 'knowledgeReads', 'mcpGrants'];
const stepLabels = { basic: message('agents.step-basic'), model: message('agents.tab-model'), knowledge: message('agents.tab-knowledge'),
  ability: message('agents.tab-ability'), channel: message('agents.tab-channel'), trigger: message('agents.tab-trigger'), confirm: message('agents.step-confirm') };
const tabLabels = { ...stepLabels, basic: message('agents.tab-basic') };
const fieldLabels = { defaultModel: message('agents.defaultModel'), replyLocale: message('agents.replyLocale') };
export const newAgentValues = () => ({ name: '', introduction: '', instructions: '', defaultModel: null,
  replyLocale: 'zh-TW', knowledgeReads: [], mcpGrants: [] });

function builtinText(agent, field, label, original = '') {
  return agent?.builtin && (!agent[field] || agent[field] === original) ? label : agent?.[field] || '';
}

export function agentName(agent) {
  if (!agent) return message('agents.main');
  return agent.builtin === 'bi' ? builtinText(agent, 'name', message('agents.bi'), 'BI 資料處理') :
    builtinText(agent, 'name', message('agents.main'));
}

export function agentIntroduction(agent) {
  return agent?.builtin === 'bi' ? builtinText(agent, 'introduction', message('agents.bi-intro'), '接收使用者傳來的資料，處理成 BI 卡片並送審') :
    agent?.introduction || (agent?.builtin === 'main' ? message('ui.local-engineering-assistant') : '');
}

export function agentAvatar(element, agent) {
  element.toggleAttribute('data-ui-content', typeof agentName(agent) === 'string');
  if (!agent?.hasAvatar) {
    element.textContent = agent?.builtin === 'main' ? 'O' : Array.from(resolveText(agentName(agent)))[0] || 'O';
    return;
  }
  const image = document.createElement('img');
  image.alt = '';
  image.src = `/api/agents/${agent.id}/avatar`;
  element.replaceChildren(image);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) setText(element, text);
  if (className) element.className = className;
  return element;
}

export function agentButton(text, action) {
  const button = node('button', text);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

export function replyLanguage(value) {
  const select = node('select');
  select.append(optionText(message('ui.traditional-chinese'), 'zh-TW'), optionText(message('ui.english'), 'en'));
  select.value = value;
  return select;
}

export const workspaceName = (workspace) => workspace.layout === 'managed' ? message('agents.managed-folder') :
  projectLabel({ id: workspace.layout === 'legacy_secondary' ? 'secondary' : 'default' });

async function encodeAvatar(file) {
  if (file.size > 90 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error();
  return btoa(Array.from(new Uint8Array(await file.arrayBuffer()), (byte) => String.fromCharCode(byte)).join(''));
}

export function bindAgents({ onChange, close, openChannels, openMcp, deleteAgent, restoreAgent }) {
  const view = document.getElementById('agent-view');
  const title = document.getElementById('agent-title');
  const tabs = document.getElementById('agent-tabs');
  const form = document.getElementById('assistant-settings');
  const panes = document.getElementById('agent-fields');
  const actions = document.getElementById('agent-actions');
  const status = document.getElementById('settings-status');
  let snapshot;
  let entry;
  let draft;
  let original;
  let panels;
  let tab = 0;
  let step = 0;
  let wizard = false;
  let busy = false;
  let generation = 0;
  let channel;
  let tokenSetup;
  let connections = [];
  const controls = new Map();
  let avatarReset;

  function field(parent, key, control, id, label = fieldLabels[key]) {
    control.id = id;
    const caption = node('label', label);
    caption.htmlFor = id;
    parent.append(caption, control);
    controls.set(key, control);
    return control;
  }

  function basic(parent) {
    for (const [key, limit] of [['name', 80], ['introduction', 500], ['instructions', 4000]]) {
      const labels = { name: message('ui.assistant-name'), introduction: message('ui.introduction'), instructions: message('ui.assistant-instructions') };
      const control = field(parent, key, node(key === 'name' ? 'input' : 'textarea'), 'assistant-' + key, labels[key]);
      control.maxLength = limit;
      control.value = draft[key];
      if (key === 'name') control.required = entry?.builtin !== 'main';
    }
    const help = node('small', message('ui.png-or-jpeg-up-to-90-kib'));
    help.id = 'avatar-help';
    const avatar = field(parent, 'avatar', node('input'), 'avatar-file', message('ui.assistant-avatar'));
    avatar.type = 'file';
    avatar.accept = 'image/png,image/jpeg';
    avatar.setAttribute('aria-describedby', help.id);
    const refresh = bindFilePicker(avatar);
    avatarReset = false;
    const reset = agentButton(message('ui.restore-default-avatar'), () => {
      avatarReset = true;
      avatar.value = '';
      refresh();
      setText(status, message('chat.saving-will-restore-the-default-avatar'));
    });
    reset.id = 'avatar-reset';
    avatar.addEventListener('change', () => { avatarReset = false; });
    parent.append(help, reset);
    if (!entry) return;
    const managed = node('ul');
    for (const workspace of entry.workspaces) {
      const folder = node('li', workspaceName(workspace));
      const path = node('code', workspace.relativeRoot);
      path.setAttribute('data-ui-content', '');
      folder.append(' ', path);
      const classification = node('div', undefined, 'external-classification');
      const name = resolveText(workspaceName(workspace));
      classificationControl(classification, workspace.classification, name, async () => {
        await request('/api/classification/workspace', { data: { workspaceId: workspace.id, classification: 'public' } });
        workspace.classification = 'public';
      }, () => classificationControl(classification, 'public', name));
      folder.append(classification);
      if (workspace.folders.length) {
        const reads = node('ul');
        for (const read of workspace.folders) {
          const item = node('li', read);
          item.setAttribute('data-ui-content', '');
          reads.append(item);
        }
        folder.append(reads);
      }
      managed.append(folder);
    }
    parent.append(node('small', message('ui.new-sessions-use-the-latest-instructions-existing')),
      node('h3', message('agents.folders')), managed);
    if (entry.builtin === 'main') {
      const advanced = node('details', undefined, 'settings-advanced');
      const delegation = node('input');
      delegation.id = 'assistant-delegation';
      delegation.type = 'checkbox';
      delegation.disabled = true;
      delegation.checked = true;
      const label = node('label');
      label.append(delegation, ' ', node('span', message('ui.multi-assistant-delegation')));
      advanced.append(node('summary', message('ui.advanced')), label, node('small', message('agents.delegation-settings')));
      parent.append(advanced);
    }
  }

  function model(parent) {
    const select = field(parent, 'defaultModel', node('select'), 'agent-model');
    select.append(optionText(message('agents.follow-global'), ''));
    for (const alias of snapshot.models) select.append(optionText(snapshot.appliedModels.includes(alias) ? alias :
      message('agents.model-pending', { model: alias }), alias));
    if (draft.defaultModel && !snapshot.models.includes(draft.defaultModel)) {
      select.append(optionText(message('agents.model-unavailable', { model: draft.defaultModel }), draft.defaultModel));
    }
    select.value = draft.defaultModel || '';
    parent.append(node('small', message('agents.model-help')));
  }

  function selections(parent, key, values, label, empty) {
    const group = node('fieldset', undefined, 'agent-choices');
    group.append(node('legend', label));
    const inputs = [];
    for (const { id, name, disabled, note } of values) {
      const input = node('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = draft[key].includes(id);
      input.disabled = Boolean(disabled);
      const row = node('label');
      const text = node('span', name);
      text.setAttribute('data-ui-content', '');
      row.append(input, text);
      if (note) row.append(node('small', note));
      group.append(row);
      if (!disabled) inputs.push(input);
    }
    if (!values.length) group.append(node('p', empty));
    controls.set(key, inputs);
    parent.append(group);
  }

  function knowledge(parent) {
    selections(parent, 'knowledgeReads', snapshot.vaults.map(({ id, title }) => ({ id, name: title })),
      message('agents.read-vaults'), message('agents.no-vaults'));
    if (entry?.writeTargets.length) {
      parent.append(node('p', message('agents.proposal-only', { vaults: entry.writeTargets.map(({ id }) =>
        snapshot.vaults.find((vault) => vault.id === id)?.title ?? id).join(', ') })));
    }
  }

  function ability(parent) {
    selections(parent, 'mcpGrants', snapshot.tools.map((tool) => {
      const eligibleProject = entry?.builtin === 'main' ? tool.projects.length : tool.projects.includes('default');
      const note = tool.paused ? message('agents.tool-paused') : !tool.enabled || !eligibleProject ? message('agents.tool-unavailable') :
        tool.pending ? message('agents.tool-pending') : null;
      return { ...tool, disabled: tool.paused || !tool.enabled || !eligibleProject,
        note };
    }), message('ui.external-tools'), message('agents.no-tools'));
    parent.append(node('p', message('agents.skills-later')));
    if (!wizard) parent.append(agentButton(message('ui.external-tools'), openMcp));
  }

  function channelFields(parent) {
    field(parent, 'replyLocale', replyLanguage(draft.replyLocale), 'agent-reply-locale');
    if (!wizard) {
      const bots = node('div');
      const feedback = node('p');
      feedback.setAttribute('role', 'status');
      const id = entry.id;
      const add = agentButton(message('channels.add-bot'), () => openChannels({ agentId: id, opener: add, onSaved }));
      add.id = 'agent-add-channel';
      let noticeTimer;
      function onSaved(accounts, notice) {
        if (!parent.isConnected) return;
        entry.channels = accounts.filter(({ agentId, state }) => agentId === id && state === 'enabled');
        drawBots();
        add.focus();
        setText(feedback, notice);
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => setText(feedback, ''), 5000);
      }
      function drawBots() {
        bots.replaceChildren();
        for (const { accountId, botName } of entry.channels) {
          const row = node('div', undefined, 'agent-channel-token');
          const replace = agentButton(message('channels.replace-token'), () => openChannels({ accountId, opener: replace, onSaved }));
          row.append(node('p', botName ? message('channels.token-configured-bot', { bot: botName }) :
            message('channels.token-configured')), replace);
          bots.append(row);
        }
        if (!entry.channels.length) bots.append(node('p', message('agents.no-channel')));
      }
      drawBots();
      parent.append(bots, add, feedback);
      return;
    }
    const select = field(parent, 'channel', node('select'), 'agent-channel', message('agents.connection'));
    select.append(optionText(message('agents.skip-channel'), ''), ...connections.map((item) =>
      optionText(item.botName || message('channels.bot'), item.accountId)));
    select.value = channel?.accountId ?? '';
    const skip = agentButton(message('agents.skip-channel'), () => clearSetup());
    skip.hidden = !tokenSetup;
    const renderSetup = () => telegramSetup('agent-channel', { initial: tokenSetup, onChange(next) {
      tokenSetup = next;
      if (next) { select.value = ''; channel = undefined; }
      skip.hidden = !next;
    } });
    let setupControl = renderSetup();
    function clearSetup() {
      cancelTelegramSetup(tokenSetup);
      tokenSetup = undefined;
      const next = renderSetup();
      setupControl.replaceWith(next);
      setupControl = next;
      skip.hidden = true;
    }
    select.addEventListener('change', () => {
      channel = connections.find((item) => item.accountId === select.value);
      clearSetup();
    });
    const setupDetails = node('details');
    setupDetails.open = Boolean(tokenSetup);
    const summary = node('summary', message('channels.add-bot'));
    summary.id = 'agent-wizard-add-channel';
    setupDetails.append(summary, node('p', message('channels.wizard-help')), setupControl, skip);
    parent.append(setupDetails);
  }

  function trigger(parent) {
    parent.append(node('p', message('agents.message-trigger')), node('p', message('agents.schedules-later')));
  }

  function confirmation(parent) {
    const summary = node('dl', undefined, 'agent-summary');
    const lists = (chosen, choices, label) => chosen.map((id) => choices.find((item) => item.id === id)?.[label] || id).join(', ');
    for (const [label, value] of [
      [message('ui.assistant-name'), draft.name], [message('agents.folders'), message('agents.new-folder')],
      [fieldLabels.defaultModel, draft.defaultModel || message('agents.follow-global')],
      [message('agents.read-vaults'), lists(draft.knowledgeReads, snapshot.vaults, 'title')],
      [message('ui.external-tools'), lists(draft.mcpGrants, snapshot.tools, 'name')],
      [message('agents.connection'), (tokenSetup || channel) && (tokenSetup?.botName || channel?.botName || message('channels.bot'))],
      [fieldLabels.replyLocale, draft.replyLocale === 'en' ? message('ui.english') : message('ui.traditional-chinese')],
    ]) {
      const description = node('dd', value || message('agents.none'));
      description.toggleAttribute('data-ui-content', typeof value === 'string' && Boolean(value));
      if (label === fieldLabels.defaultModel && draft.defaultModel) description.setAttribute('data-agent-model', '');
      summary.append(node('dt', label), description);
    }
    parent.append(summary);
  }

  const draw = { basic, model, knowledge, ability, channel: channelFields, trigger, confirm: confirmation };

  function values() {
    const next = { ...draft };
    for (const key of detailFields) {
      const control = controls.get(key);
      if (!control || key === 'avatar') continue;
      if (Array.isArray(control)) next[key] = control.filter(({ checked }) => checked).map(({ value }) => value).sort();
      else next[key] = control.value || (key === 'defaultModel' ? null : '');
    }
    return next;
  }

  function dirty() {
    if (!draft || wizard || view.hidden) return false;
    const next = values();
    return avatarReset || controls.get('avatar')?.files.length || detailFields.some((key) =>
      JSON.stringify(original[key]) !== JSON.stringify(next[key]));
  }

  async function capture() {
    draft = values();
    const file = controls.get('avatar')?.files[0];
    if (file) {
      try { draft.avatar = await encodeAvatar(file); }
      catch { throw new Error(t('server.avatar-type-or-size')); }
    } else if (avatarReset) draft.avatar = null;
  }

  function toggleDetail(index, focus) {
    tab = index;
    [...tabs.children].forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === tab));
      button.tabIndex = i === tab ? 0 : -1;
      panels[i].hidden = i !== tab;
    });
    if (focus) tabs.children[tab].focus();
  }

  function render() {
    controls.clear();
    tabs.replaceChildren();
    panes.replaceChildren();
    actions.replaceChildren();
    setText(status, '');
    form.noValidate = !wizard;
    setText(title, wizard ? message('agents.create') : agentName(entry));
    title.toggleAttribute('data-ui-content', !wizard && typeof agentName(entry) === 'string');
    if (wizard) {
      tabs.removeAttribute('role');
      const order = node('ol', undefined, 'agent-steps');
      steps.forEach((key, index) => {
        const label = node('li', stepLabels[key]);
        if (index === step) label.setAttribute('aria-current', 'step');
        order.append(label);
      });
      tabs.append(order);
      const heading = node('h2', stepLabels[steps[step]]);
      heading.id = 'agent-step-title';
      heading.tabIndex = -1;
      panes.append(heading);
      draw[steps[step]](panes);
      if (step > 0) actions.append(agentButton(message('agents.previous'), async () => {
        try { await capture(); if (tokenSetup?.checking) tokenSetup = undefined; step--; render(); document.getElementById('agent-step-title').focus(); }
        catch (error) { setText(status, error.message); }
      }));
    } else {
      tabs.setAttribute('role', 'tablist');
      setAttribute(tabs, 'aria-label', message('agents.details'));
      panels = detailTabs.map((key, index) => {
        const panel = node('section', undefined, 'agent-tab-panel');
        panel.id = 'agent-panel-' + key;
        panel.setAttribute('role', 'tabpanel');
        const button = agentButton(tabLabels[key], () => toggleDetail(index, true));
        button.id = 'agent-tab-' + key;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', panel.id);
        panel.setAttribute('aria-labelledby', button.id);
        tabs.append(button);
        draw[key](panel);
        panes.append(panel);
        return panel;
      });
      toggleDetail(tab, false);
    }
    const submitLabel = wizard ? step === steps.length - 1 ? message('agents.create') : message('agents.next') : message('ui.save-assistant-settings');
    const submit = node('button', submitLabel);
    submit.type = 'submit';
    submit.id = wizard ? 'agent-next' : 'save-assistant';
    submit.disabled = entry?.state === 'archived';
    if (submit.disabled) for (const input of panes.querySelectorAll('input, textarea, select, .file-picker button, #avatar-reset')) {
      input.disabled = true;
    }
    if (entry?.state !== 'archived') actions.append(submit);
    if (wizard) {
      const cancel = agentButton(message('agents.cancel'), close);
      cancel.id = 'agent-cancel';
      actions.append(cancel);
    } else if (entry.builtin) {
      const help = node('small', message('agents.builtin-delete-help'));
      help.id = 'builtin-agent-help';
      actions.append(help);
    } else if (entry.state === 'archived') {
      const restore = agentButton(message('agents.restore'), async () => {
        restore.disabled = true;
        try { await restoreAgent(entry); }
        catch (error) { setText(status, errorText(error)); }
        finally { restore.disabled = false; }
      });
      restore.id = 'restore-agent';
      actions.append(restore);
    } else {
      const remove = agentButton(message('agents.delete'), () => deleteAgent(entry, remove));
      remove.id = 'delete-agent';
      remove.className = 'danger-action';
      actions.append(remove);
    }
  }

  tabs.addEventListener('keydown', (event) => {
    const offsets = { ArrowRight: 1, ArrowLeft: -1, Home: -tab, End: detailTabs.length - tab - 1 };
    if (wizard || !Object.hasOwn(offsets, event.key)) return;
    event.preventDefault();
    toggleDetail((tab + offsets[event.key] + detailTabs.length) % detailTabs.length, true);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || entry?.state === 'archived') return;
    busy = true;
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    try {
      if (wizard && steps[step] === 'channel' && tokenSetup && !setupReady(tokenSetup)) {
        setText(status, tokenSetup.checking ? message('channels.checking-token') : message('channels.finish-owner-confirmation'));
        return;
      }
      await capture();
      if (wizard && step < steps.length - 1) {
        step++;
        render();
        document.getElementById('agent-step-title').focus();
        return;
      }
      setText(status, message('chat.saving'));
      const settings = Object.fromEntries(detailFields.filter((key) => draft[key] !== undefined &&
        (wizard || JSON.stringify(draft[key]) !== JSON.stringify(original[key]))).map((key) => [key, draft[key]]));
      const connection = tokenSetup ? { setupId: tokenSetup.setupId, ownerConfirmed: tokenSetup.ownerConfirmed === true } :
        channel && { accountId: channel.accountId, bindingRevision: channel.bindingRevision };
      const update = wizard ? { ...settings, revision: snapshot.revision, ...(connection && { channel: connection }) } :
        { ...settings, action: 'edit', revision: entry.revision };
      const detail = Object.keys(settings).length || wizard ? await request(wizard ? '/api/agents' : '/api/agents/' + entry.id,
        { data: update }) : snapshot;
      const wasWizard = wizard;
      tokenSetup = undefined;
      applyDetail(detail, wasWizard ? 0 : tab);
      if (wasWizard) title.focus();
      else document.getElementById('save-assistant').focus();
      await onChange().catch(() => {});
      setText(status, message('chat.saved'));
    } catch (error) { setText(status, errorText(error, message('agents.save-error'))); }
    finally {
      busy = false;
      for (const button of actions.querySelectorAll('button')) button.disabled = entry?.state === 'archived';
    }
  });

  function applyDetail(detail, index) {
    snapshot = detail;
    entry = detail.agent;
    wizard = false;
    tab = index;
    const eligible = (id) => snapshot.tools.some((tool) => tool.id === id && tool.enabled && !tool.paused &&
      (entry.builtin === 'main' ? tool.projects.length : tool.projects.includes('default')));
    draft = { ...newAgentValues(), ...Object.fromEntries(detailFields.filter((key) => key in entry).map((key) => [key, entry[key]])) };
    draft.mcpGrants = draft.mcpGrants.filter(eligible).sort();
    draft.knowledgeReads = draft.knowledgeReads.filter((id) => snapshot.vaults.some((vault) => vault.id === id)).sort();
    original = { ...draft };
    render();
    // Paused existing grants are still visible in the read-only list.
    const abilityPanel = document.getElementById('agent-panel-ability');
    for (const input of abilityPanel.querySelectorAll('input:disabled')) input.checked = entry.mcpGrants.includes(input.value);
  }

  async function open(id, copy = false) {
    const version = ++generation;
    draft = undefined;
    tabs.replaceChildren();
    panes.replaceChildren();
    actions.replaceChildren();
    setText(title, id && !copy ? message('agents.details') : message('agents.create'));
    title.removeAttribute('data-ui-content');
    setText(status, message('agents.loading'));
    title.focus();
    try {
      const detail = await request(id ? '/api/agents/' + id : '/api/agents');
      if (version !== generation) return;
      if (id && !copy) { applyDetail(detail, 0); return; }
      const channels = await request('/api/settings/channels');
      if (version !== generation) return;
      snapshot = detail;
      entry = undefined;
      wizard = true;
      step = 0;
      channel = undefined;
      tokenSetup = undefined;
      connections = channels.accounts.filter(({ verified, state, handler }) => verified && state === 'disabled' && handler === 'chat')
        .map((item) => ({ ...item, key: item.accountId }));
      draft = newAgentValues();
      if (copy) {
        const source = detail.agent;
        Object.assign(draft, { name: t('agents.copy-name', { name: resolveText(agentName(source)) }),
          introduction: resolveText(agentIntroduction(source)), instructions: source.instructions,
          defaultModel: detail.models.includes(source.defaultModel) ? source.defaultModel : null,
          knowledgeReads: source.knowledgeReads.filter((read) => detail.vaults.some(({ id }) => id === read)) });
        draft.name = draft.name.slice(0, 80);
        if (source.hasAvatar) {
          const result = await fetch(`/api/agents/${source.id}/avatar`);
          if (version !== generation) return;
          if (result.ok) draft.avatar = await encodeAvatar(await result.blob());
          if (version !== generation) return;
        }
      }
      render();
    } catch (error) { if (version === generation) setText(status, errorText(error)); }
  }

  function leave() {
    if (view.hidden) return true;
    if (busy || dirty() && !window.confirm(t('chat.discard-unsaved-settings'))) return false;
    generation++;
    cancelTelegramSetup(tokenSetup);
    tokenSetup = undefined;
    draft = undefined;
    view.hidden = true;
    return true;
  }

  return { open, leave, dirty, lifecycle(detail) {
    if (!view.hidden && !wizard && draft && entry?.id === detail.agent.id) {
      applyDetail(detail, tab);
      return true;
    }
    return false;
  } };
}
