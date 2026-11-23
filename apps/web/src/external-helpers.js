import { errorText, request } from './api.js';
import { message, optionText, setAttribute, setText } from './i18n.js';

const classifications = {
  public: message('externalHelpers.label.public'),
  unclassified: message('externalHelpers.label.unclassified'),
  confidential: message('externalHelpers.label.confidential'),
};
const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) setText(element, text);
  return element;
};
const button = (text, handler) => {
  const element = node('button', text);
  element.type = 'button';
  element.addEventListener('click', handler);
  return element;
};
const field = (input, text) => {
  const label = node('label');
  label.append(node('span', text), input);
  return label;
};
const checkbox = (text, checked = false) => {
  const input = node('input');
  input.type = 'checkbox';
  input.checked = checked;
  const label = node('label');
  label.append(input, node('span', text));
  return { input, label };
};
const settingsRoute = '/api/settings/external-helpers';
const loginLabels = {
  signedIn: message('externalHelpers.status.signedIn'), signedOut: message('externalHelpers.status.signedOut'),
  probeFailed: message('externalHelpers.status.probeFailed'), unknown: message('externalHelpers.status.loginUnknown'),
  reauthRequired: message('externalHelpers.status.reauthRequired'),
};

export const modelChoice = (source, alias) => source === 'gateway' ? alias ?? '' : `external:${source}`;

export function gatewayModelOption(alias, notes, label = alias) {
  const option = optionText(label, alias);
  const { note, mappedModel } = notes?.[alias] ?? {};
  const annotation = note ?? mappedModel;
  if (annotation && annotation !== alias) {
    const hint = node('span', note == null ? message('model.mapped-to', { model: mappedModel }) : ' · ' + note);
    hint.className = 'model-annotation';
    hint.dataset.uiContent = '';
    option.append(hint);
  }
  return option;
}

export function groupModelOptions(select, gatewayOptions, externalModels, selected) {
  const gateway = node('optgroup');
  setAttribute(gateway, 'label', message('externalHelpers.models.gateway'));
  gateway.append(...gatewayOptions);
  const external = node('optgroup');
  setAttribute(external, 'label', message('externalHelpers.models.external'));
  for (const { provider, name, enabled } of externalModels) {
    const option = optionText(enabled ? name : message('externalHelpers.models.disabled', { provider: name }), modelChoice(provider));
    option.disabled = !enabled;
    external.append(option);
  }
  select.replaceChildren(gateway, external);
  select.value = selected;
}

export function externalModelBlock(setting) {
  if (!setting.enabled) return message('externalHelpers.models.enableHelp');
  if (setting.status.isolation !== 'verified') return message('externalHelpers.settings.setup');
  if (setting.status.installation !== 'detected') return message('server.external-cli-unsupported');
  if (setting.status.login !== 'signedIn') return message('externalHelpers.models.signInHelp');
  return '';
}
const content = (tag, value) => {
  const element = node(tag, value);
  element.setAttribute('data-ui-content', '');
  return element;
};

function modal(title, opener) {
  const dialog = node('dialog');
  dialog.className = 'external-dialog';
  const heading = node('h2', title);
  heading.id = 'external-dialog-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', heading.id);
  const form = node('form');
  const body = node('div');
  const status = node('p');
  status.setAttribute('role', 'status');
  const actions = node('div');
  actions.className = 'settings-actions';
  form.append(body, status, actions);
  dialog.append(heading, form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }, { once: true });
  const cancel = button(message('externalHelpers.confirm.cancel'), () => dialog.close());
  cancel.autofocus = true;
  actions.append(cancel);
  return { dialog, body, status, actions, form, open() {
    document.body.append(dialog);
    dialog.showModal();
  }, submit(label, handler) {
    const action = node('button', label);
    action.type = 'submit';
    actions.append(action);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      action.disabled = cancel.disabled = true;
      const preventClose = (event) => event.preventDefault();
      dialog.addEventListener('cancel', preventClose);
      try {
        await handler();
        dialog.close();
      } catch (error) {
        setText(status, errorText(error));
      } finally {
        dialog.removeEventListener('cancel', preventClose);
        action.disabled = cancel.disabled = false;
      }
    });
  } };
}

export function openExternalLogin(setting, opener, onChange) {
  const view = modal(message('externalHelpers.login.title', { provider: setting.name }), opener);
  const close = view.actions.querySelector('button');
  setText(close, message('externalHelpers.login.close'));
  const stop = new AbortController();
  const method = node('select');
  const isClaude = setting.provider === 'claude_code';
  const keyChoice = isClaude ? message('externalHelpers.login.consoleKey') : message('externalHelpers.login.apiKey');
  method.append(optionText(isClaude ? message('externalHelpers.login.claudeCli') : message('externalHelpers.login.chatgpt'), 'cli'),
    optionText(keyChoice, 'key'));
  if (isClaude) method.value = 'key';
  const key = node('input');
  key.type = 'password';
  key.autocomplete = 'off';
  key.maxLength = 1024;
  const keyField = field(key, keyChoice);
  const live = node('p');
  live.setAttribute('role', 'status');
  const setup = node('p');
  const signIn = node('button', message('externalHelpers.login.signIn'));
  signIn.type = 'submit';
  const signOut = button(message('externalHelpers.login.signOut'), () => change({ action: 'logout' }));
  let status = setting.status;
  let busy = false;
  function render() {
    const installed = status.isolation === 'verified' && status.installation === 'detected';
    const terms = !isClaude || setting.termsConfirmed;
    const useKey = method.value === 'key';
    setText(live, loginLabels[status.login]);
    setText(setup, status.isolation !== 'verified' ? message('externalHelpers.settings.setup') :
      !installed ? message('server.external-cli-unsupported') : !terms ? message('server.external-terms-required') : '');
    keyField.hidden = !useKey;
    key.required = useKey;
    method.disabled = key.disabled = signIn.disabled = busy || !installed || !terms;
    signOut.disabled = busy || !installed || !['signedIn', 'reauthRequired', 'probeFailed'].includes(status.login);
  }
  async function change(data) {
    if (busy) return;
    busy = true;
    key.value = '';
    render();
    setText(view.status, message('chat.checking'));
    try {
      status = await request(settingsRoute + '/auth', { data: { provider: setting.provider, ...data }, signal: stop.signal });
      if (view.dialog.open) setText(view.status, '');
      onChange?.(status);
    } catch (error) { if (view.dialog.open) setText(view.status, errorText(error)); }
    finally { busy = false; render(); }
  }
  method.addEventListener('change', () => { key.value = ''; render(); });
  view.dialog.addEventListener('close', () => { key.value = ''; stop.abort(); });
  view.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!signIn.disabled) void change(method.value === 'key' ? { action: 'key', key: key.value } : { action: 'cli' });
  });
  view.body.append(node('p', message('externalHelpers.login.publicOnly', { provider: setting.name })), live, setup,
    field(method, message('externalHelpers.login.method')), keyField);
  view.actions.prepend(signIn, signOut);
  render();
  view.open();
  return view.dialog;
}

export function classificationControl(root, label, name, save, onSaved, allowConfidential = false) {
  const badge = node('span', classifications[label ?? 'unclassified']);
  badge.dataset.classification = label ?? 'unclassified';
  root.replaceChildren(badge);
  const mark = (value, action, warning) => button(action, (event) => {
    const view = modal(action, event.currentTarget);
    view.body.append(node('p', warning));
    view.submit(action, async () => {
      await save(value);
      onSaved?.();
    });
    view.open();
  });
  if (save && label !== 'public' && label !== 'confidential') root.append(mark('public',
    message('externalHelpers.gate.markPublic'), message('externalHelpers.classificationWarning', { name })));
  if (save && allowConfidential && label !== 'confidential') root.append(mark('confidential',
    message('externalHelpers.gate.markConfidential'), message('externalHelpers.confidentialWarning', { name })));
}

export async function loadExternalSettings(root, status, onChange) {
  try {
    const [settings, policy] = await Promise.all([request(settingsRoute), request(settingsRoute + '/policy')]);
    root.replaceChildren(...settings.map((setting) => {
      const group = node('fieldset');
      group.append(content('legend', setting.name));
      const detected = {
        detected: message('externalHelpers.status.detected'), missing: message('externalHelpers.status.missing'),
        unsupported: message('externalHelpers.status.unsupported'), unknown: message('externalHelpers.status.installationUnknown'),
      };
      const check = setting.status;
      const installed = check.isolation === 'verified' && check.installation === 'detected';
      group.append(node('p', check.isolation === 'verified' ? message('externalHelpers.status.isolationVerified') :
        message('externalHelpers.status.isolationUnavailable')), node('p', detected[check.installation]), node('p', loginLabels[check.login]));
      if (check.isolation !== 'verified') group.append(node('p', message('externalHelpers.settings.setup')));
      if (check.version) group.append(node('p', message('externalHelpers.status.version', { version: check.version })));
      if (check.pinnedVersion) group.append(node('p', message('externalHelpers.status.pinnedVersion', { version: check.pinnedVersion })));
      const enabled = checkbox(message('externalHelpers.settings.enabled'), setting.enabled);
      const confirm = checkbox(message('externalHelpers.settings.confirmEachRun'), setting.confirmEachRun);
      const terms = checkbox(message('externalHelpers.settings.termsConfirmed'), setting.termsConfirmed);
      enabled.input.disabled = !installed && !setting.enabled;
      const refresh = async (values) => {
        await request(settingsRoute, { data: { provider: setting.provider, enabled: enabled.input.checked,
          confirmEachRun: confirm.input.checked, termsConfirmed: setting.provider === 'claude_code' && terms.input.checked,
          revision: setting.revision, ...values } });
        setText(status, message('externalHelpers.settings.saved'));
        await loadExternalSettings(root, status, onChange);
        onChange?.();
      };
      const apply = async () => {
        try { await refresh(); }
        catch (error) { setText(status, errorText(error)); await loadExternalSettings(root, status, onChange); }
      };
      enabled.input.addEventListener('change', () => {
        if (!enabled.input.checked) { void apply(); return; }
        const view = modal(message('externalHelpers.settings.title'), enabled.input);
        view.body.append(node('p', message('externalHelpers.warning', { provider: setting.name })));
        view.dialog.addEventListener('close', () => { enabled.input.checked = setting.enabled; }, { once: true });
        view.submit(message('externalHelpers.settings.enable'), () => refresh({ warningAccepted: true }));
        view.open();
      });
      confirm.input.addEventListener('change', () => void apply());
      if (setting.provider === 'claude_code') {
        terms.input.addEventListener('change', () => {
          if (!terms.input.checked) enabled.input.checked = false;
          void apply();
        });
        group.append(terms.label);
        enabled.input.disabled ||= !setting.termsConfirmed;
      }
      group.append(enabled.label, confirm.label);
      group.append(button(message('externalHelpers.login.manage'), (event) => {
        const dialog = openExternalLogin(setting, event.currentTarget, (next) => {
          setting.status = next;
          onChange?.();
        });
        dialog.addEventListener('close', () => {
          if (setting.status === check) return;
          void loadExternalSettings(root, status, onChange).then(() => root.querySelector(`[data-external-login="${setting.provider}"]`)?.focus());
        }, { once: true });
      }));
      group.lastElementChild.dataset.externalLogin = setting.provider;
      group.append(button(message('externalHelpers.settings.recheck'), async (event) => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          await request(settingsRoute + '/recheck', { data: { provider: setting.provider } });
          await loadExternalSettings(root, status, onChange);
          onChange?.();
          root.querySelector(`[data-external-recheck="${setting.provider}"]`)?.focus();
        } catch (error) { setText(status, errorText(error)); }
        finally { control.disabled = false; }
      }));
      group.lastElementChild.dataset.externalRecheck = setting.provider;
      if (setting.enabled) {
        const classification = node('div');
        classification.className = 'external-classification';
        group.append(node('p', message('externalHelpers.settings.targetWorkspace')), classification);
        classificationControl(classification, setting.classification, setting.name, (classification) =>
          request('/api/classification/workspace', { data: { workspaceId: setting.targetId, classification } }),
        () => void loadExternalSettings(root, status, onChange), true);
      }
      return group;
    }));
    const strict = checkbox(message('externalHelpers.settings.strictMode'), policy.strictMode);
    strict.input.id = 'external-helper-strict';
    strict.input.addEventListener('change', async () => {
      try {
        Object.assign(policy, await request(settingsRoute + '/policy', {
          data: { strictMode: strict.input.checked, revision: policy.revision },
        }));
        setText(status, message('externalHelpers.settings.saved'));
        onChange?.();
      } catch (error) {
        strict.input.checked = policy.strictMode;
        setText(status, errorText(error));
      }
    });
    root.append(strict.label);
  } catch (error) { setText(status, errorText(error)); }
}

export function confirmExternalTurn(opener) {
  return new Promise((resolve) => {
    const view = modal(message('server.external-confirm-turn'), opener);
    view.dialog.addEventListener('close', () => resolve(false), { once: true });
    view.submit(message('externalHelpers.confirm.sendTurn'), async () => resolve(true));
    view.open();
  });
}

export async function confirmExternal(id, name, opener, signal, onConfirmed) {
  const route = '/api/delegations/' + id;
  const { externalApproval } = await request(route, { signal });
  if (!externalApproval || externalApproval.decision || signal.aborted) return;
  const { provider, parentRunId, digest, settingsRevision, challenge, task, inputs, bytes } = externalApproval;
  const view = modal(message('externalHelpers.confirm.title'), opener);
  view.body.append(node('p', message('externalHelpers.warning', { provider: name })), node('h3', message('externalHelpers.confirm.task')), content('pre', task));
  if (inputs.length) {
    const list = node('ul');
    for (const file of inputs) {
      const row = node('li');
      row.append(content('span', file.name), node('small', message('externalHelpers.confirm.fileSize', { bytes: file.bytes })));
      if (file.excerpt) row.append(content('pre', file.excerpt));
      list.append(row);
    }
    view.body.append(node('h3', message('externalHelpers.confirm.inputs')), list);
  }
  view.body.append(node('p', message('externalHelpers.confirm.totals', { count: inputs.length, bytes })));
  view.submit(message('externalHelpers.confirm.send'), async () => {
    await request(route + '/confirm', { data: { provider, parentRunId, digest, settingsRevision, challenge }, signal });
    onConfirmed();
  });
  view.open();
}
