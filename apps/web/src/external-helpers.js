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
const helperSetupScript = 'scripts/windows/Setup-OEPExternalHelper.ps1';
const loginLabels = {
  signedIn: message('externalHelpers.status.signedIn'), signedOut: message('externalHelpers.status.signedOut'),
  probeFailed: message('externalHelpers.status.probeFailed'), unknown: message('externalHelpers.status.loginUnknown'),
  reauthRequired: message('externalHelpers.status.reauthRequired'),
};
const loginLabel = ({ login, account }) => login === 'signedIn' && account ?
  message('externalHelpers.status.signedInAccount', { account }) : loginLabels[login];

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
  const isClaude = setting.provider === 'claude_code';
  const account = isClaude ? message('externalHelpers.login.claudeCli') : message('externalHelpers.login.chatgpt');
  const live = node('p');
  live.setAttribute('role', 'status');
  const setup = node('p');
  const setupScript = content('code', helperSetupScript);
  const signIn = node('button', account);
  signIn.type = 'submit';
  const device = button(message('externalHelpers.login.device'), () => change({ action: 'device' }));
  const signOut = button(message('externalHelpers.login.signOut'), () => change({ action: 'logout' }));
  const cancel = button(message('externalHelpers.login.cancel'), () => promptAction('cancel'));
  cancel.dataset.loginCancel = '';
  const advanced = node('details');
  const keyChoice = isClaude ? message('externalHelpers.login.consoleKey') : message('externalHelpers.login.apiKey');
  const password = (length) => {
    const input = node('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.maxLength = length;
    return input;
  };
  const key = password(1024);
  const code = password(512);
  const keyButton = button(message('externalHelpers.login.keySignIn'), () => {
    if (key.value) void change({ action: 'key', key: key.value });
    else key.focus();
  });
  advanced.append(node('summary', message('externalHelpers.login.advanced')),
    node('p', message('externalHelpers.login.apiBilling')), field(key, keyChoice), keyButton);
  const prompt = node('div');
  prompt.className = 'external-login-prompt';
  const link = node('a', message('externalHelpers.login.openPage'));
  link.className = 'external-login-link';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const codeDisplay = node('code');
  const copy = (label, value) => button(label, async () => {
    try {
      await navigator.clipboard.writeText(value());
      setText(view.status, message('externalHelpers.login.copied'));
    } catch { setText(view.status, message('externalHelpers.login.copyFailed')); }
  });
  const urlRow = node('div');
  urlRow.className = 'settings-actions';
  urlRow.append(link, copy(message('externalHelpers.login.copyUrl'), () => link.href));
  const browserHelp = node('p', message('externalHelpers.login.sameComputer'));
  const codeRow = node('div');
  codeRow.className = 'settings-actions';
  codeRow.append(node('span', message('externalHelpers.login.deviceCode')), codeDisplay,
    copy(message('externalHelpers.login.copyCode'), () => codeDisplay.textContent));
  const codeEntry = node('div');
  const submitCode = button(message('externalHelpers.login.submitCode'), () => {
    const value = code.value.trim();
    if (value) void promptAction('code', value);
    else code.focus();
  });
  codeEntry.append(field(code, message('externalHelpers.login.pasteCode')), submitCode);
  prompt.append(browserHelp, urlRow, codeRow, codeEntry);
  let status = setting.status;
  let busy = false;
  let exchange;
  let promptTimer;

  function showPrompt(next = {}) {
    prompt.hidden = !next.url && !next.deviceCode && !next.pasteCode;
    browserHelp.hidden = urlRow.hidden = !next.url;
    if (next.url) link.href = next.url;
    else link.removeAttribute('href');
    codeRow.hidden = !next.deviceCode;
    codeDisplay.textContent = next.deviceCode ?? '';
    codeEntry.hidden = !next.pasteCode;
  }
  function render() {
    const installed = status.isolation === 'verified' && status.installation === 'detected';
    const terms = !isClaude || setting.termsConfirmed;
    setText(live, loginLabel(status));
    setText(setup, status.isolation !== 'verified' ? message('externalHelpers.settings.setup') :
      !installed ? message('server.external-cli-unsupported') : !terms ? message('server.external-terms-required') : '');
    setupScript.hidden = status.isolation === 'verified';
    signIn.disabled = device.disabled = key.disabled = keyButton.disabled = busy || !installed || !terms;
    device.hidden = isClaude;
    cancel.hidden = !exchange;
    signOut.disabled = busy || !installed || !['signedIn', 'reauthRequired', 'probeFailed'].includes(status.login);
  }
  async function readPrompt(id) {
    if (exchange !== id || stop.signal.aborted) return;
    try {
      const next = await request(settingsRoute + '/auth/prompt', { data: { action: 'poll', exchange: id }, signal: stop.signal });
      if (exchange !== id || stop.signal.aborted) return;
      showPrompt(next);
    } catch {
      if (exchange !== id || stop.signal.aborted) return;
    }
    promptTimer = setTimeout(() => void readPrompt(id), 350);
  }
  async function promptAction(action, value) {
    code.value = '';
    if (!exchange) return;
    const id = exchange;
    const actionButton = action === 'cancel' ? cancel : submitCode;
    actionButton.disabled = true;
    try {
      await request(settingsRoute + '/auth/prompt', {
        data: { action, exchange: id, ...(value && { code: value }) }, signal: stop.signal,
      });
      if (exchange === id && action === 'code') {
        codeEntry.hidden = true;
        if (!cancel.hidden) cancel.focus();
      }
    } catch (error) {
      if (exchange === id && view.dialog.open) setText(view.status, errorText(error));
    } finally { actionButton.disabled = false; }
  }
  async function change(data) {
    if (busy) return;
    busy = true;
    key.value = '';
    const login = data.action === 'cli' || data.action === 'device';
    if (login) exchange = crypto.randomUUID();
    render();
    setText(view.status, login ? message('externalHelpers.login.waiting') : message('chat.checking'));
    if (exchange) {
      cancel.focus();
      const id = exchange;
      promptTimer = setTimeout(() => void readPrompt(id), 150);
    }
    try {
      status = await request(settingsRoute + '/auth', {
        data: { provider: setting.provider, ...data, ...(exchange && { exchange }) }, signal: stop.signal,
      });
      if (!view.dialog.open) return;
      setText(view.status, '');
      onChange?.(status);
    } catch (error) {
      if (view.dialog.open) {
        setText(view.status, errorText(error));
        if (error.detail?.code === 'external-auth-setup-required') view.status.append(content('code', helperSetupScript));
        try {
          status = await request(settingsRoute + '/recheck', { data: { provider: setting.provider }, signal: stop.signal });
          if (view.dialog.open) onChange?.(status);
        } catch { /* Retain the authentication outcome in the dialog. */ }
      }
    } finally {
      clearTimeout(promptTimer);
      const returnFocus = view.dialog.open && (prompt.contains(document.activeElement) ||
        document.activeElement === cancel || document.activeElement === document.body);
      exchange = undefined;
      busy = false;
      code.value = '';
      showPrompt();
      render();
      if (returnFocus) (signIn.disabled ? close : signIn).focus();
    }
  }
  view.dialog.addEventListener('close', () => {
    key.value = code.value = '';
    clearTimeout(promptTimer);
    stop.abort();
  });
  for (const [input, action] of [[key, keyButton], [code, submitCode]]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        action.click();
      }
    });
  }
  view.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!signIn.disabled) void change({ action: 'cli' });
  });
  view.body.append(node('p', message('externalHelpers.login.publicOnly', { provider: setting.name })), live, setup, setupScript, prompt);
  view.actions.prepend(signIn, device, signOut, cancel);
  view.form.append(advanced);
  showPrompt();
  render();
  if (!signIn.disabled) {
    signIn.autofocus = true;
    close.autofocus = false;
  }
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
        message('externalHelpers.status.isolationUnavailable')), node('p', detected[check.installation]), node('p', loginLabel(check)));
      if (check.isolation !== 'verified') group.append(node('p', message('externalHelpers.settings.setup')), content('code', helperSetupScript));
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
