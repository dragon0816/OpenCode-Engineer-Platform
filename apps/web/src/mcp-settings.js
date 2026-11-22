import { joinText, message, setAttribute, setText, textNode, t } from './i18n.js';
import { errorText, projectLabel, request, serverText } from './api.js';

const endpoint = '/api/settings/mcp';
const find = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) setText(node, text);
  if (className) node.className = className;
  return node;
};
const control = (text, action) => {
  const button = element('button', text);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
};
const labels = { connected: message('chat.connected'), disabled: message('chat.disabled'), pending: message('chat.awaiting-connection'),
  failed: message('tools.connection-failed-run-a-connection-test'), needs_auth: message('chat.credentials-required') };
const connectionDetails = /\b(?:HTTPS|TLS|stdio|MCP)\b/i;

export function bindMcpSettings(projects) {
  const editor = find('mcp-editor');
  const form = find('mcp-form');
  const field = (name) => form.elements.namedItem(name);
  const rows = find('mcp-credential-rows');
  const formStatus = find('mcp-form-status');
  const formDiagnostic = find('mcp-form-diagnostic');
  const status = find('mcp-status');
  const restart = find('mcp-restart');
  const list = find('mcp-servers');
  let current;
  let changed;
  let opener;
  let saved;
  let saving = false;
  const results = new Map();

  function credential(entry = {}) {
    const row = element('div', '', 'mcp-credential');
    const name = element('input');
    name.maxLength = 64;
    name.value = entry.name ?? '';
    name.required = true;
    name.dataset.mcpName = '';
    const value = element('input');
    value.type = 'password';
    value.dataset.mcpValue = '';
    const secret = element('input');
    secret.type = 'checkbox';
    secret.checked = !entry.configured;
    value.disabled = !secret.checked;
    secret.addEventListener('change', () => {
      value.disabled = !secret.checked;
      valueLabel.hidden = !secret.checked;
      if (!secret.checked) value.value = '';
    });
    value.autocomplete = 'new-password';
    value.maxLength = 4096;
    const nameLabel = element('label', message('ui.name'));
    const valueLabel = element('label', entry.configured ? message('tools.new-credential-configured') : message('tools.credential-unconfigured'));
    nameLabel.append(name);
    valueLabel.append(value);
    valueLabel.hidden = !secret.checked;
    const secretLabel = element('label', '', 'mcp-secret');
    secretLabel.append(secret, textNode(entry.configured ? message('tools.enter-new-credential-configured') : message('tools.enter-credential')));
    row.append(nameLabel, secretLabel, valueLabel, control(message('tools.remove-field'), () => {
      row.remove();
      find('mcp-add-credential').focus();
    }));
    rows.append(row);
    return name;
  }

  function transport() {
    const remote = field('transport').value === 'remote';
    find('mcp-stdio-fields').hidden = remote;
    find('mcp-remote-fields').hidden = !remote;
    field('url').required = remote;
    field('executable').required = !remote;
    field('cwd').required = !remote;
    setText(find('mcp-credential-title'), remote ? message('tools.service-credential-fields') : message('ui.program-credential-fields'));
  }

  function open(server, trigger) {
    form.reset();
    form.querySelector('details').open = false;
    formStatus.textContent = '';
    formDiagnostic.hidden = true;
    formDiagnostic.textContent = '';
    current = server;
    changed = server?.id;
    opener = trigger;
    saved = false;
    setText(find('mcp-editor-title'), server ? message('tools.edit-server') : message('ui.add-server'));
    for (const name of ['name', 'transport', 'cwd', 'url', 'dataScope']) {
      field(name).value = server?.[name] ?? (name === 'transport' ? 'stdio' : '');
    }
    field('enabled').checked = server?.enabled ?? true;
    field('localService').checked = Boolean(server?.localService);
    field('executable').value = server?.command?.[0] ?? '';
    field('args').value = server?.command?.slice(1).join('\n') ?? '';
    for (const name of ['startup', 'catalog', 'execution']) field(name).value = server?.timeouts[name] ?? 15000;
    rows.replaceChildren();
    for (const entry of server?.environment ?? []) credential(entry);
    const choices = projects().map((project) => {
      const { id } = project;
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.name = 'project';
      input.value = id;
      input.checked = server?.appliesToProjects.includes(id) ?? false;
      label.append(input, ' ', textNode(projectLabel(project)));
      return label;
    });
    find('mcp-projects').replaceChildren(...choices);
    transport();
    editor.showModal();
  }

  function renderResult(panel, result, server, apply) {
    panel.replaceChildren();
    if (!result) return;
    if (result.ok) panel.append(element('p', message('tools.connection-test-passed-tool-settings-apply-to')));
    else if (connectionDetails.test(result.reason)) {
      const diagnostic = element('details', '', 'settings-advanced');
      diagnostic.append(element('summary', message('ui.advanced')), element('p', serverText(result.reasonDetail, errorText(result.reason))));
      panel.append(element('p', message('tools.connection-test-failed-check-the-service-url')), diagnostic);
    } else panel.append(element('p', serverText(result.reasonDetail, errorText(result.reason))));
    if (!result.ok || !result.tools.length) return;
    const tools = element('ul');
    for (const { name, description } of result.tools) {
      const item = element('li');
      item.append(element('strong', name), ...(description ? [element('p', description)] : []));
      if (/^[a-z0-9_]{1,120}$/.test(name)) {
        const enabled = !server.deniedTools.includes(name);
        const label = enabled ? message('tools.disable-tool') : message('tools.enable-tool');
        const toggle = control(label, (event) =>
          apply({ action: 'tool', tool: name, enabled: !enabled }, event.currentTarget));
        setAttribute(toggle, 'aria-label', joinText([label, name], ' '));
        item.append(toggle);
      } else item.append(element('p', message('tools.this-tool-name-is-read-only')));
      tools.append(item);
    }
    panel.append(tools);
  }

  function render(snapshot) {
    find('mcp-restart-bar').hidden = !snapshot.restartRequired;
    list.replaceChildren();
    if (!snapshot.servers.length) list.append(element('p', message('tools.no-custom-servers-yet')));
    for (const server of snapshot.servers) {
      const card = element('article', '', 'mcp-card');
      const heading = element('h4', server.name);
      heading.tabIndex = -1;
      heading.id = 'mcp-server-' + server.id;
      const badges = element('div', '', 'mcp-badges');
      for (const text of [server.enabled ? message('jobs.enabled') : message('chat.disabled'), server.enabled && (!server.restartRequired || server.status !== 'pending') && labels[server.status],
        server.restartRequired && message('tools.restart-pending')]) {
        if (text) badges.append(element('span', text, 'runtime-badge'));
      }
      const allowed = projects().filter(({ id }) => server.appliesToProjects.includes(id)).map(projectLabel);
      const panel = element('div', '', 'mcp-result');
      panel.setAttribute('role', 'status');

      const actions = element('div', '', 'settings-actions');
      const apply = async (data, button) => {
        button.disabled = true;
        status.textContent = '';
        try {
          const next = await request(endpoint + '/custom', { data: { id: server.id, ...data } });
          if (data.action === 'remove') results.delete(server.id);
          render(next);
          (find(heading.id) ?? find('mcp-add')).focus();
        } catch (error) { setText(status, errorText(error)); }
        finally { button.disabled = false; }
      };
      renderResult(panel, results.get(server.id), server, apply);
      actions.append(control(message('jobs.edit'), (event) => open(server, event.currentTarget)),
        control(server.enabled ? message('tools.disable') : message('tools.enable'), (event) => apply({ action: 'enable', enabled: !server.enabled }, event.currentTarget)),
        control(message('tools.test-connection'), async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          setText(panel, message('tools.testing-connection'));
          try {
            const result = await request(endpoint + '/test', { data: { id: server.id } });
            results.set(server.id, result);
            renderResult(panel, result, server, apply);
          } catch (error) { setText(panel, errorText(error)); }
          finally { button.disabled = false; button.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'nearest' }); }
        }),
        control(message('chat.remove'), (event) => {
          if (window.confirm(t('tools.remove-this-server-configuration'))) void apply({ action: 'remove' }, event.currentTarget);
        }));
      card.append(heading, badges, element('p', joinText([server.transport === 'stdio' ? message('ui.local-program') : message('ui.remote-service'),
        allowed.length ? joinText(allowed, ', ') : message('tools.no-projects-allowed')])));
      if (server.dataScope) card.append(element('p', server.dataScope));
      card.append(actions, panel);
      list.append(card);
    }
  }

  find('mcp-add').addEventListener('click', (event) => open(undefined, event.currentTarget));
  find('mcp-cancel').addEventListener('click', () => editor.close());
  editor.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  editor.addEventListener('close', () => {
    rows.replaceChildren();
    if (!saved) (opener?.isConnected ? opener : find('mcp-add')).focus({ preventScroll: true });
    opener = undefined;
  });
  field('transport').addEventListener('change', transport);
  find('mcp-add-credential').addEventListener('click', () => credential().focus());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const buttons = [...form.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    setText(formStatus, message('chat.saving'));
    formDiagnostic.hidden = true;
    formDiagnostic.textContent = '';
    const kind = field('transport').value;
    const credentials = [...rows.children].map((row) => [row.querySelector('[data-mcp-name]'), row.querySelector('[data-mcp-value]')]);
    const names = credentials.map(([name]) => name.value.trim());
    const args = field('args').value;
    try {
      const snapshot = await request(endpoint + '/custom', { data: {
        action: changed ? 'update' : 'create', id: changed, transport: kind, name: field('name').value,
        enabled: field('enabled').checked, dataScope: field('dataScope').value,
        appliesToProjects: new FormData(form).getAll('project'),
        timeouts: Object.fromEntries(['startup', 'catalog', 'execution'].map((name) => [name, field(name).valueAsNumber])),
        ...(kind === 'stdio' ? { command: [field('executable').value, ...(args ? args.split('\n') : [])],
          cwd: field('cwd').value, environment: names } : { url: field('url').value, localService: field('localService').checked, headers: names }),
      } });
      changed = snapshot.changedId;
      if (current) results.delete(current.id);
      render(snapshot);
      for (const [name, value] of credentials) {
        if (!value.value) continue;
        await request(endpoint + '/custom', { data: { action: 'credential', id: changed, name: name.value.trim(), value: value.value } });
        value.value = '';
      }
      render(await request(endpoint + '/custom'));
      saved = true;
      editor.close();
      (find('mcp-server-' + changed) ?? find('mcp-add')).focus();
    } catch (error) {
      if (connectionDetails.test(error.message)) {
        setText(formStatus, message('tools.could-not-save-the-server-check-that'));
        setText(formDiagnostic, errorText(error));
        formDiagnostic.hidden = false;
      } else setText(formStatus, errorText(error));
    }
    finally {
      saving = false;
      for (const button of buttons) button.disabled = false;
    }
  });
  restart.addEventListener('click', async () => {
    restart.disabled = true;
    try {
      await request(endpoint + '/restart', { data: {} });
      setText(status, message('tools.restarting-continue-in-the-oep-tab-that'));
    } catch (error) { setText(status, errorText(error)); restart.disabled = false; }
  });

  return async () => {
    status.textContent = '';
    try { render(await request(endpoint + '/custom')); }
    catch { setText(status, message('tools.could-not-load-custom-servers-refresh-the')); }
  };
}
