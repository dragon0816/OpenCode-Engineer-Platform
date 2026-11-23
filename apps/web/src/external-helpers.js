import { errorText, request } from './api.js';
import { message, optionText, setText } from './i18n.js';

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

export function classificationControl(root, label, name, save, onSaved) {
  const badge = node('span', classifications[label ?? 'unclassified']);
  badge.dataset.classification = label ?? 'unclassified';
  root.replaceChildren(badge);
  if (save && label !== 'public' && label !== 'confidential') root.append(button(message('externalHelpers.gate.markPublic'), (event) => {
    const view = modal(message('externalHelpers.gate.markPublic'), event.currentTarget);
    view.body.append(node('p', message('externalHelpers.classificationWarning', { name })));
    view.submit(message('externalHelpers.gate.markPublic'), async () => {
      await save();
      onSaved?.();
    });
    view.open();
  }));
}

export async function loadExternalSettings(root, status) {
  try {
    const settings = await request(settingsRoute);
    root.replaceChildren(...settings.map((setting) => {
      const group = node('fieldset');
      group.append(content('legend', setting.name));
      const enabled = checkbox(message('externalHelpers.settings.enabled'), setting.enabled);
      const confirm = checkbox(message('externalHelpers.settings.confirmEachRun'), setting.confirmEachRun);
      const terms = checkbox(message('externalHelpers.settings.termsConfirmed'), setting.termsConfirmed);
      const refresh = async (values) => {
        await request(settingsRoute, { data: { provider: setting.provider, enabled: enabled.input.checked,
          confirmEachRun: confirm.input.checked, termsConfirmed: setting.provider === 'claude_code' && terms.input.checked,
          revision: setting.revision, ...values } });
        setText(status, message('externalHelpers.settings.saved'));
        await loadExternalSettings(root, status);
      };
      const apply = async () => {
        try { await refresh(); }
        catch (error) { setText(status, errorText(error)); await loadExternalSettings(root, status); }
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
        enabled.input.disabled = !setting.termsConfirmed;
      }
      group.append(enabled.label, confirm.label);
      if (setting.enabled) {
        const classification = node('div');
        classification.className = 'external-classification';
        group.append(node('p', message('externalHelpers.settings.targetWorkspace')), classification);
        classificationControl(classification, setting.classification, setting.name, () =>
          request('/api/classification/workspace', { data: { workspaceId: setting.targetId, classification: 'public' } }),
        () => void loadExternalSettings(root, status));
      }
      return group;
    }));
  } catch (error) { setText(status, errorText(error)); }
}

export async function openExternalIntake(opener, context, submit) {
  const route = context.path + '/external-sources';
  const [settings, data] = await Promise.all([request(settingsRoute), request(route)]);
  const view = modal(message('externalHelpers.intake.title'), opener);
  const provider = node('select');
  provider.append(...settings.filter((item) => item.enabled).map((item) => optionText(item.name, item.provider)));
  const task = node('textarea');
  task.required = true;
  task.maxLength = 4000;
  const authored = checkbox(message('externalHelpers.intake.ownerAuthored'));
  authored.input.required = true;
  const sources = node('fieldset');
  const selected = new Set();
  function renderEntries(entries) {
    sources.replaceChildren(node('legend', message('externalHelpers.intake.inputs')));
    for (const source of entries) {
      const choose = checkbox(source.name, selected.has(source.id));
      choose.label.lastChild.setAttribute('data-ui-content', '');
      choose.input.addEventListener('change', () => {
        if (choose.input.checked) selected.add(source.id);
        else selected.delete(source.id);
      });
      const row = node('div');
      row.className = 'external-classification';
      row.append(choose.label, node('span', classifications[source.classification]));
      sources.append(row);
    }
    sources.hidden = entries.length === 0;
  }
  renderEntries(data.sources);
  if (!provider.options.length) {
    view.body.append(node('p', message('externalHelpers.intake.noHelpers')));
    view.open();
    return;
  }
  view.body.append(field(provider, message('externalHelpers.intake.provider')), field(task, message('externalHelpers.intake.task')), authored.label, sources);
  if (data.workspace.folders.length) {
    const disclosure = node('details');
    disclosure.append(node('summary', message('externalHelpers.intake.addFile')));
    const folder = node('select');
    folder.append(...data.workspace.folders.map(({ id, path }) => optionText(path, id)));
    const path = node('input');
    const added = node('div');
    const register = button(message('externalHelpers.intake.inspectFile'), async () => {
      try {
        const file = await request(route, { data: { kind: 'workspace', folder: folder.value, path: path.value.trim() } });
        const save = async () => {
          const marked = await request(route + '/' + file.id, { data: { sha256: file.sha256, classification: 'public' } });
          const entry = data.sources.findIndex(({ id }) => id === file.id);
          data.sources.splice(entry, 1, marked);
          renderEntries(data.sources);
        };
        if (!data.sources.some(({ id }) => id === file.id)) data.sources.unshift(file);
        renderEntries(data.sources);
        added.replaceChildren(content('span', file.name), node('span', classifications[file.classification]));
        if (file.classification === 'unclassified') {
          const mark = checkbox(message('externalHelpers.classificationWarning', { name: file.name }));
          const action = button(message('externalHelpers.gate.markPublic'), async () => {
            try { await save(); added.replaceChildren(node('span', message('externalHelpers.label.public'))); }
            catch (error) { setText(view.status, errorText(error)); }
          });
          action.disabled = true;
          mark.input.addEventListener('change', () => { action.disabled = !mark.input.checked; });
          added.append(mark.label, action);
        }
      } catch (error) { setText(view.status, errorText(error)); }
    });
    disclosure.append(field(folder, message('externalHelpers.intake.folder')), field(path, message('externalHelpers.intake.relativePath')), register, added);
    view.body.append(disclosure);
  }
  view.submit(message('externalHelpers.intake.request'), async () => {
    const label = 'public';
    const source = await request(route, { data: { kind: 'owner_text', ownerAuthored: true, text: task.value } });
    await request(route + '/' + source.id, { data: { sha256: source.sha256, classification: label } });
    const runId = crypto.randomUUID();
    const { publicInputId, specialistId } = await request(context.path + '/external-snapshot',
      { data: { runId, provider: provider.value, taskId: source.id, inputs: [...selected] } });
    await submit(runId, publicInputId, specialistId);
  });
  view.open();
}

export async function confirmExternal(id, name, opener, signal, onConfirmed) {
  const route = '/api/delegations/' + id;
  const { externalApproval } = await request(route, { signal });
  if (!externalApproval || externalApproval.decision || signal.aborted) return;
  const { provider, parentRunId, digest, settingsRevision, challenge, task, inputs, bytes } = externalApproval;
  const view = modal(message('externalHelpers.confirm.title'), opener);
  view.body.append(node('p', message('externalHelpers.warning', { provider: name })), node('h3', message('externalHelpers.intake.task')), content('pre', task));
  if (inputs.length) {
    const list = node('ul');
    for (const file of inputs) {
      const row = node('li');
      row.append(content('span', file.name), node('small', message('externalHelpers.confirm.fileSize', { bytes: file.bytes })));
      if (file.excerpt) row.append(content('pre', file.excerpt));
      list.append(row);
    }
    view.body.append(node('h3', message('externalHelpers.intake.inputs')), list);
  }
  view.body.append(node('p', message('externalHelpers.confirm.totals', { count: inputs.length, bytes })));
  view.submit(message('externalHelpers.confirm.send'), async () => {
    await request(route + '/confirm', { data: { provider, parentRunId, digest, settingsRevision, challenge }, signal });
    onConfirmed();
  });
  view.open();
}
