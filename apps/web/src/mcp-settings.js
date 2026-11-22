import { request } from './api.js';

const endpoint = '/api/settings/mcp';
const find = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const control = (text, action) => {
  const button = element('button', text);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
};
const labels = { connected: '已連線', disabled: '已停用', pending: '等待連線',
  failed: '連線失敗，請執行連線測試。', needs_auth: '需要憑證' };

export function bindMcpSettings(projects) {
  const editor = find('mcp-editor');
  const form = find('mcp-form');
  const field = (name) => form.elements.namedItem(name);
  const rows = find('mcp-credential-rows');
  const formStatus = find('mcp-form-status');
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
    const nameLabel = element('label', '名稱');
    const valueLabel = element('label', entry.configured ? '新憑證（已設定）' : '憑證（尚未設定）');
    nameLabel.append(name);
    valueLabel.append(value);
    valueLabel.hidden = !secret.checked;
    const secretLabel = element('label', '', 'mcp-secret');
    secretLabel.append(secret, entry.configured ? ' 輸入新憑證（已設定）' : ' 輸入憑證');
    row.append(nameLabel, secretLabel, valueLabel, control('移除此欄位', () => {
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
    find('mcp-credential-title').textContent = remote ? '服務的憑證欄位' : '程式的憑證欄位';
  }

  function open(server, trigger) {
    form.reset();
    form.querySelector('details').open = false;
    formStatus.textContent = '';
    current = server;
    changed = server?.id;
    opener = trigger;
    saved = false;
    find('mcp-editor-title').textContent = server ? '編輯伺服器' : '新增伺服器';
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
    const choices = projects().map(({ id, title }) => {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.name = 'project';
      input.value = id;
      input.checked = server?.appliesToProjects.includes(id) ?? false;
      label.append(input, ' ' + title);
      return label;
    });
    find('mcp-projects').replaceChildren(...choices);
    transport();
    editor.showModal();
  }

  function renderResult(panel, result, server, apply) {
    panel.replaceChildren();
    if (!result) return;
    panel.append(element('p', result.ok ? '連線測試成功。工具設定會在重新啟動後套用至新會話。' : result.reason));
    if (!result.ok || !result.tools.length) return;
    const tools = element('ul');
    for (const { name, description } of result.tools) {
      const item = element('li');
      item.append(element('strong', name), ...(description ? [element('p', description)] : []));
      if (/^[a-z0-9_]{1,120}$/.test(name)) {
        const enabled = !server.deniedTools.includes(name);
        const toggle = control(enabled ? '停用工具' : '啟用工具', (event) =>
          apply({ action: 'tool', tool: name, enabled: !enabled }, event.currentTarget));
        toggle.setAttribute('aria-label', toggle.textContent + ' ' + name);
        item.append(toggle);
      } else item.append(element('p', '此工具名稱僅供查看。'));
      tools.append(item);
    }
    panel.append(tools);
  }

  function render(snapshot) {
    find('mcp-restart-bar').hidden = !snapshot.restartRequired;
    list.replaceChildren();
    if (!snapshot.servers.length) list.append(element('p', '尚未新增自訂伺服器。'));
    for (const server of snapshot.servers) {
      const card = element('article', '', 'mcp-card');
      const heading = element('h4', server.name);
      heading.tabIndex = -1;
      heading.id = 'mcp-server-' + server.id;
      const badges = element('div', '', 'mcp-badges');
      for (const text of [server.enabled ? '已啟用' : '已停用', server.enabled && (!server.restartRequired || server.status !== 'pending') && labels[server.status],
        server.restartRequired && '等待重新啟動']) {
        if (text) badges.append(element('span', text, 'runtime-badge'));
      }
      const allowed = projects().filter(({ id }) => server.appliesToProjects.includes(id)).map(({ title }) => title);
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
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      };
      renderResult(panel, results.get(server.id), server, apply);
      actions.append(control('編輯', (event) => open(server, event.currentTarget)),
        control(server.enabled ? '停用' : '啟用', (event) => apply({ action: 'enable', enabled: !server.enabled }, event.currentTarget)),
        control('測試連線', async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          panel.textContent = '正在測試連線…';
          try {
            const result = await request(endpoint + '/test', { data: { id: server.id } });
            results.set(server.id, result);
            renderResult(panel, result, server, apply);
          } catch (error) { panel.textContent = error.message; }
          finally { button.disabled = false; button.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'nearest' }); }
        }),
        control('移除', (event) => {
          if (window.confirm('要移除此伺服器設定嗎？')) void apply({ action: 'remove' }, event.currentTarget);
        }));
      card.append(heading, badges, element('p', (server.transport === 'stdio' ? '本機程式' : '遠端服務') +
        ' · ' + (allowed.length ? allowed.join('、') : '尚未允許任何專案')));
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
    formStatus.textContent = '正在儲存…';
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
    } catch (error) { formStatus.textContent = error.message; }
    finally {
      saving = false;
      for (const button of buttons) button.disabled = false;
    }
  });
  restart.addEventListener('click', async () => {
    restart.disabled = true;
    try {
      await request(endpoint + '/restart', { data: {} });
      status.textContent = '正在重新啟動。請使用即將開啟的 OEP 分頁。';
    } catch (error) { status.textContent = error.message; restart.disabled = false; }
  });

  return async () => {
    status.textContent = '';
    try { render(await request(endpoint + '/custom')); }
    catch { status.textContent = '無法讀取自訂伺服器。請重新整理。'; }
  };
}
