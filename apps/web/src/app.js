import { connect, request, RequestError } from './api.js';
import { bindKnowledge } from './knowledge.js';
import './jobs.js';

const find = (id) => document.getElementById(id);
const model = find('model');
const sessions = find('sessions');
const agent = find('agent');
let projects = [];
let project = 'default';
let projectBusy = false;
const sessionPath = (id) => `/api/projects/${project}/sessions${id ? '/' + id : ''}`;
const pick = find('pick');
const fileInput = find('file-input');
const drop = find('drop');
const prompt = find('prompt');
const send = find('send');
const workbook = find('workbook');
const stop = find('stop');
const messages = find('messages');
const progress = find('progress');
const activityList = find('activity');
const sessionTitle = find('session-title');
const attachmentList = find('attachments');
const artifactList = find('artifacts');
const uploadStatus = find('upload-status');
const connection = find('connection');
const notice = find('error');
const labels = { inspector: '資料分析', workbook: 'Excel 工作表' };
const statuses = {
  accepted: '已接收，等待執行', running: '助理處理中', awaiting_permission: '正在檢查工具權限',
  background: '正在產生並驗證工作簿', indeterminate: '正在核對未確定的結果', failed: '這次處理未完成', verified: '已完成',
};
const eventLabels = {
  working: '開始處理', responding: '模型開始回覆', 'tool-started': '準備使用工具', 'tool-running': '工具執行中',
  'tool-completed': '工具完成', 'tool-failed': '工具未完成', recovering: '模型正在重試',
  permission: '正在檢查工具權限',
};
const activeStates = new Set(['accepted', 'running', 'awaiting_permission', 'background', 'indeterminate']);
const knownSessions = new Map();
const selections = new Map();
const submitted = new Map();
const drafts = new Map();
let current;
let uploadBusy = false;
let sending = false;
let stopped = false;
let disableKnowledge;

function showError(error) {
  notice.textContent = error ? error.message || String(error) : '';
  notice.hidden = !error;
}

function setControls() {
  pick.disabled = !current || uploadBusy || stopped;
  prompt.disabled = !current || stopped;
  send.disabled = !current || uploadBusy || sending || stopped || Boolean(current.pendingID) ||
    activeStates.has(current.state?.runs.at(-1)?.state);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function emptyList(element, text) {
  element.replaceChildren(node('li', text, 'empty'));
}

const relative = new Intl.RelativeTimeFormat('zh-Hant', { numeric: 'auto' });
function relativeTime(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
  if (!sameDay) {
    const day = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return relative.format((day(new Date(timestamp)) - day(new Date())) / 86400000, 'day');
  }
  if (minutes < 1) return '剛剛';
  if (minutes < 60) return `${minutes} 分鐘前`;
  return relative.format(-Math.floor(minutes / 60), 'hour');
}

function sessionLabel(session) {
  return session.title || `${labels[session.agent]} · ${relativeTime(session.createdAt)}`;
}

function bindRowMenu(menu, trigger, actions) {
  const close = () => { menu.open = false; trigger.focus(); };
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of sessions.querySelectorAll('details[open]')) {
      if (other !== menu) other.open = false;
    }
    actions[0].focus();
  });
  for (const action of actions) action.addEventListener('click', close);
  menu.addEventListener('keydown', (event) => {
    if (!menu.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (['Tab', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      actions[document.activeElement === actions[0] ? 1 : 0].focus();
    }
  });
}

const jump = find('jump-latest');
const atBottom = () => messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 24;
messages.addEventListener('scroll', () => { jump.hidden = atBottom(); });
jump.addEventListener('click', () => { messages.scrollTop = messages.scrollHeight; jump.hidden = true; });

function appendMarkdown(target, text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((value) => value.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (line.startsWith('```')) {
      const block = [];
      while (i < lines.length && !lines[i].startsWith('```')) block.push(lines[i++]);
      if (i < lines.length) i++;
      const value = block.join('\n');
      const section = node('div', '', 'code-block');
      const copy = sessionButton('複製程式碼', async () => {
        try { await navigator.clipboard.writeText(value); copy.textContent = '已複製'; }
        catch { copy.textContent = '無法複製'; }
      });
      const pre = node('pre');
      pre.append(node('code', value));
      section.append(copy, pre);
      target.append(section);
    } else if (/^#{1,6} /.test(line)) {
      const count = line.indexOf(' ');
      target.append(node(`h${Math.min(count + 1, 6)}`, line.slice(count + 1)));
    } else if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const pattern = /^\s*\d+\. /.test(line) ? /^\s*\d+\. / : /^\s*[-*+] /;
      const list = node(pattern.source.includes('\\d') ? 'ol' : 'ul');
      list.append(node('li', line.replace(pattern, '')));
      while (i < lines.length && pattern.test(lines[i])) list.append(node('li', lines[i++].replace(pattern, '')));
      target.append(list);
    } else if (line.includes('|') && i < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i]) && cells(lines[i]).every((value) => /^:?-{3,}:?$/.test(value))) {
      i++;
      const wrapper = node('div', '', 'message-table');
      const table = node('table');
      const head = table.createTHead().insertRow();
      head.append(...cells(line).map((value) => node('th', value)));
      const body = table.createTBody();
      while (i < lines.length && lines[i].includes('|')) {
        body.insertRow().append(...cells(lines[i++]).map((value) => node('td', value)));
      }
      wrapper.append(table);
      target.append(wrapper);
    } else if (line.trim()) {
      target.append(node('p', line));
    }
  }
}

function render(context) {
  const { state, selected, id } = context;
  if (state.messages) {
    const follow = !context.renderedMessages || atBottom();
    const offset = messages.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const item of state.messages) {
      const entry = node('article', '', `message ${item.role}`);
      entry.dataset.id = item.id;
      const role = node('strong', item.role === 'user' ? '你' : labels[state.session.agent]);
      if (item.createdAt) role.title = new Date(item.createdAt).toLocaleString('zh-Hant');
      entry.append(role);
      if (item.role === 'assistant') appendMarkdown(entry, item.text);
      else entry.append(node('p', item.text));
      fragment.append(entry);
    }
    messages.replaceChildren(fragment);
    if (!state.messages.length) messages.append(node('p', '上傳附件或直接輸入訊息。', 'empty'));
    messages.scrollTop = follow ? messages.scrollHeight : offset;
    jump.hidden = atBottom();
    context.renderedMessages = true;
  }
  const latest = state.runs.at(-1);
  if (context.pendingID && state.runs.some((run) => run.id === context.pendingID)) context.pendingID = undefined;
  progress.textContent = latest ? statuses[latest.state] : '等待訊息';
  if (state.stateError || latest?.error) showError(state.stateError || latest.error);
  else if (!context.requestError) showError();
  attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(attachment.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(attachment.id);
      else selected.delete(attachment.id);
    });
    const label = node('label');
    label.append(checkbox, node('span', attachment.name));
    const entry = node('li');
    entry.append(label);
    if (attachment.converted) entry.append(node('small', '已轉成含工作表與列號的 CSV'));
    attachmentList.append(entry);
  }
  artifactList.replaceChildren();
  for (const run of state.runs.filter((run) => run.artifact).reverse()) {
    const entry = node('li');
    const link = node('a', run.artifact.name);
    link.href = `${sessionPath(id)}/artifacts/${run.id}`;
    link.download = run.artifact.name;
    entry.append(link, node('small', new Date(run.createdAt).toLocaleTimeString('zh-Hant')));
    artifactList.append(entry);
  }
  if (!artifactList.children.length) emptyList(artifactList, '尚無可下載的產物');
  setControls();
}

function refresh(context) {
  if (context !== current || stopped) return;
  if (context.refreshing) { context.dirty = true; return; }
  if (context.timer) return;
  context.timer = setTimeout(async () => {
    context.timer = undefined;
    context.refreshing = true;
    try {
      const state = await request(`${context.path}/state`, { signal: context.abort.signal });
      if (current !== context || stopped) return;
      context.state = state;
      render(context);
    } catch (error) {
      if (current === context && !stopped) showError(error);
    } finally {
      context.refreshing = false;
      if (context.dirty) { context.dirty = false; refresh(context); }
    }
  }, 150);
}

function select(id) {
  if (current) drafts.set(current.id, { text: prompt.value, workbook: workbook.checked });
  current?.events.close();
  current?.abort.abort();
  const session = knownSessions.get(id);
  current = undefined;
  jump.hidden = true;
  if (!session) {
    sessionTitle.textContent = '對話';
    progress.textContent = '從左側新增會話後即可開始。';
    messages.replaceChildren();
    attachmentList.replaceChildren();
    emptyList(artifactList, '尚無可下載的產物');
    emptyList(activityList, '等待即時事件');
    uploadStatus.textContent = '';
    prompt.value = '';
    showError();
    setControls();
    renderSessions();
    return;
  }
  localStorage.setItem(`oep.activeSession.${project}`, id);
  sessionTitle.textContent = sessionLabel(session);
  const draft = drafts.get(id);
  prompt.value = draft?.text ?? '';
  workbook.checked = draft?.workbook ?? false;
  find('workbook-option').hidden = session.agent !== 'workbook';
  messages.replaceChildren(node('p', '載入會話中', 'empty'));
  attachmentList.replaceChildren();
  emptyList(artifactList, '尚無可下載的產物');
  emptyList(activityList, '等待即時事件');
  uploadStatus.textContent = '';
  showError();
  if (!selections.has(id)) selections.set(id, new Set());
  const path = sessionPath(id);
  const events = new EventSource(`${path}/events`);
  const context = { id, path, abort: new AbortController(), events, selected: selections.get(id) };
  current = context;
  renderSessions();
  events.onopen = () => {
    if (current !== context || stopped) return;
    connection.textContent = '已連線';
    refresh(context);
  };
  events.onerror = () => {
    if (current !== context || stopped) return;
    connection.textContent = '重新連線中';
    refresh(context);
  };
  events.addEventListener('activity', (event) => {
    if (current !== context || stopped) return;
    const detail = JSON.parse(event.data);
    if (eventLabels[detail.kind]) {
      if (activityList.firstElementChild?.classList.contains('empty')) activityList.replaceChildren();
      activityList.prepend(node('li', eventLabels[detail.kind] + (detail.tool ? ` · ${detail.tool}` : '')));
      while (activityList.children.length > 8) activityList.lastElementChild.remove();
    }
    refresh(context);
  });
  refresh(context);
  setControls();
}

function addSession(session) {
  knownSessions.set(session.id, session);
}

function sessionButton(label, action) {
  const button = node('button', label);
  button.type = 'button';
  button.disabled = stopped || projectBusy;
  button.addEventListener('click', action);
  return button;
}

let collapsedProject;
function renderSessions() {
  const query = find('session-search').value.trim().toLocaleLowerCase();
  find('clear-session-search').hidden = !find('session-search').value;
  sessions.replaceChildren();
  for (const entry of projects) {
    const section = node('section', undefined, 'project');
    const heading = node('h2', '', 'project-heading');
    const expanded = entry.id === project && collapsedProject !== entry.id;
    const projectButton = sessionButton(entry.title, () => {
      if (entry.id !== project) { collapsedProject = undefined; void changeProject(entry.id); return; }
      collapsedProject = expanded ? entry.id : undefined;
      renderSessions();
      sessions.querySelector(`[data-project="${entry.id}"]`)?.focus();
    });
    projectButton.setAttribute('aria-expanded', String(expanded));
    projectButton.dataset.project = entry.id;
    heading.append(projectButton);
    section.append(heading);
    const create = sessionButton('+', () => { collapsedProject = undefined; return createSession(entry.id); });
    create.id = entry.id === 'default' ? 'new-session' : 'new-session-secondary';
    create.setAttribute('aria-label', `${entry.title}新增會話`);
    heading.append(create);
    sessions.append(section);
    if (!expanded) continue;
    const list = node('ul', undefined, 'session-list');
    for (const session of knownSessions.values()) {
      const label = sessionLabel(session);
      if (!label.toLocaleLowerCase().includes(query)) continue;
      const row = node('li');
      const link = sessionButton(undefined, () => {
        select(session.id);
        if (narrowNavigation.matches) setSidebar(false);
        prompt.focus();
      });
      link.title = label;
      link.append(node('span', session.title || labels[session.agent], 'session-name'),
        node('time', relativeTime(session.createdAt)));
      link.dataset.session = session.id;
      if (current?.id === session.id) link.setAttribute('aria-current', 'true');
      const menu = node('details');
      const summary = node('summary', '⋯');
      summary.setAttribute('aria-label', `${label}的會話操作`);
      const rename = sessionButton('重新命名', () => renameSession(session));
      const remove = sessionButton('刪除', () => removeSession(session));
      rename.dataset.action = 'rename';
      remove.dataset.action = 'remove';
      menu.append(summary, rename, remove);
      bindRowMenu(menu, summary, [rename, remove]);
      row.append(link, menu);
      list.append(row);
    }
    section.append(list);
    if (!list.children.length) section.append(node('p', query ? '找不到符合的會話' : '尚無會話'));
  }
}

async function switchProject(id) {
  if (id === project) return;
  const entries = await request(`/api/projects/${id}/sessions`);
  select();
  project = id;
  knownSessions.clear();
  localStorage.setItem('oep.activeProject', id);
  for (const entry of entries) addSession(entry);
  const saved = localStorage.getItem(`oep.activeSession.${project}`);
  select(knownSessions.has(saved) ? saved : entries.at(-1)?.id);
}

async function upload(files) {
  const context = current;
  if (!context || uploadBusy || stopped || !files.length) return;
  uploadBusy = true;
  context.requestError = false;
  showError();
  setControls();
  let succeeded = 0;
  const failures = [];
  for (const file of files) {
    if (current !== context || stopped) break;
    if (file.size > 20 * 1024 * 1024) { failures.push(`${file.name} · 單檔最多 20 MiB。`); continue; }
    uploadStatus.textContent = `上傳中 · ${file.name}`;
    try {
      const result = await request(`${context.path}/attachments`, { file });
      context.selected.add(result.id);
      succeeded++;
    } catch (error) { failures.push(`${file.name} · ${error.message}`); }
  }
  if (current === context && !stopped) {
    uploadStatus.textContent = succeeded ? `已上傳 ${succeeded} 個檔案。可勾選這則訊息要附上的檔案。` : '';
    if (failures.length) { context.requestError = true; showError(failures.join('\n')); }
    refresh(context);
  }
  uploadBusy = false;
  setControls();
}

const preferenceFields = ['name', 'introduction', 'instructions'];
function applyPreferences(preferences) {
  for (const field of preferenceFields) find(`assistant-${field}`).value = preferences[field];
}
find('assistant-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = find('save-assistant');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = Object.fromEntries(preferenceFields.map((field) => [field, find(`assistant-${field}`).value]));
    applyPreferences(await request('/api/settings', { data }));
    find('settings-status').textContent = '已儲存';
  } catch {
    find('settings-status').textContent = '無法儲存助理設定，請再試一次。';
  } finally { button.disabled = stopped; }
});

const theme = find('theme');
const savedTheme = localStorage.getItem('oep.theme');
if (['system', 'light', 'dark'].includes(savedTheme)) theme.value = savedTheme;
function applyTheme() {
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem('oep.theme', theme.value);
}
theme.addEventListener('change', applyTheme);
applyTheme();

const narrowNavigation = matchMedia('(max-width: 540px)');
const sidebarToggle = find('toggle-sidebar');
function setSidebar(open) {
  find('session-sidebar').hidden = !open;
  sidebarToggle.setAttribute('aria-expanded', String(open));
}
setSidebar(!narrowNavigation.matches);
narrowNavigation.addEventListener('change', () => setSidebar(!narrowNavigation.matches));
sidebarToggle.addEventListener('click', () => setSidebar(find('session-sidebar').hidden));
find('session-sidebar').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  setSidebar(false);
  sidebarToggle.focus();
});
find('session-search').addEventListener('input', renderSessions);
find('clear-session-search').addEventListener('click', () => {
  find('session-search').value = '';
  renderSessions();
  find('session-search').focus();
});
document.addEventListener('click', (event) => {
  for (const menu of sessions.querySelectorAll('details[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

async function renameSession(session) {
  const title = window.prompt('請輸入會話名稱', sessionLabel(session));
  if (title === null) return;
  try {
    const renamed = await request(`${sessionPath(session.id)}/rename`, { data: { title } });
    if (project !== session.project) return;
    addSession(renamed);
    renderSessions();
    if (current?.id === session.id) sessionTitle.textContent = sessionLabel(renamed);
    sessions.querySelector(`[data-session="${session.id}"]`)?.focus();
  } catch (error) { showError(error); }
}

async function removeSession(session) {
  if (!window.confirm(`確定刪除「${sessionLabel(session)}」？`)) return;
  try {
    await request(`${sessionPath(session.id)}/remove`, { data: {} });
    drafts.delete(session.id);
    selections.delete(session.id);
    submitted.delete(session.id);
    if (project !== session.project) return;
    knownSessions.delete(session.id);
    if (current?.id === session.id) select([...knownSessions.keys()].at(-1));
    renderSessions();
    (sessions.querySelector('[aria-current="true"]') ?? find('session-search')).focus();
  } catch (error) { showError(error); }
}

async function changeProject(id) {
  if (projectBusy || stopped) return;
  projectBusy = true;
  try { await switchProject(id); }
  catch (error) { showError(error); }
  finally {
    projectBusy = false;
    renderSessions();
    find('session-search').focus();
  }
}

async function createSession(id) {
  if (projectBusy || stopped) return;
  projectBusy = true;
  showError();
  try {
    await switchProject(id);
    const session = await request(sessionPath(), { data: { agent: agent.value } });
    addSession(session);
    find('session-search').value = '';
    select(session.id);
    if (narrowNavigation.matches) setSidebar(false);
  } catch (error) { showError(error); }
  finally {
    projectBusy = false;
    renderSessions();
    if (current) prompt.focus();
  }
}
pick.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  void upload([...fileInput.files]);
  fileInput.value = '';
});
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
drop.addEventListener('dragover', (event) => {
  if (!pick.disabled && event.dataTransfer.types.includes('Files')) drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => {
  drop.classList.remove('dragging');
  void upload([...event.dataTransfer.files]);
});
prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!send.disabled) find('composer').requestSubmit(send);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented && !find('chat-view').hidden && !prompt.disabled) {
    find('shortcuts').open = false;
    prompt.focus();
  }
});
find('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (send.disabled || !prompt.value.trim()) return;
  const context = current;
  const data = { text: prompt.value, attachments: [...context.selected], workbook: workbook.checked };
  const previous = submitted.get(context.id);
  const signature = JSON.stringify(data);
  const id = previous?.signature === signature ? previous.id : crypto.randomUUID();
  submitted.set(context.id, { id, signature });
  sending = true;
  context.requestError = false;
  showError();
  setControls();
  try {
    await request(`${context.path}/turns`, { data: { id, ...data } });
    submitted.delete(context.id);
    drafts.delete(context.id);
    if (!context.state?.runs.some((run) => run.id === id)) context.pendingID = id;
    context.selected.clear();
    if (current === context) {
      prompt.value = '';
      progress.textContent = statuses.accepted;
    }
  } catch (error) {
    if (error instanceof RequestError) submitted.delete(context.id);
    if (current === context) {
      context.requestError = true;
      showError(error instanceof RequestError ? error : '未能確認是否送達。可用相同內容再次按送出以核對。');
    }
  } finally {
    sending = false;
    setControls();
    refresh(context);
  }
});
stop.addEventListener('click', async () => {
  stop.disabled = true;
  try {
    await request('/api/stop', { data: {} });
    stopped = true;
    current?.events.close();
    current?.abort.abort();
    connection.textContent = '服務已停止';
    disableKnowledge?.();
    agent.disabled = true;
    renderSessions();
    setControls();
  } catch (error) {
    showError(error);
    stop.disabled = false;
  }
});

try {
  const bootstrap = await connect();
  connection.textContent = '已連線';
  model.textContent = `模型 ${bootstrap.alias}`;
  find('runtime-status').textContent = `OpenCode ${bootstrap.version} · 已連線 · 模型 ${bootstrap.alias}`;
  request('/api/settings').then((preferences) => {
    applyPreferences(preferences);
    find('save-assistant').disabled = stopped;
  }).catch(() => { find('settings-status').textContent = '無法載入助理設定。'; });
  if (bootstrap.job.demo && bootstrap.job.state === 'awaiting_review') find('demo-job').hidden = false;
  projects = bootstrap.projects;
  const savedProject = localStorage.getItem('oep.activeProject');
  if (projects.some(({ id }) => id === savedProject)) project = savedProject;
  const entries = project === 'default' ? bootstrap.sessions : await request(sessionPath());
  for (const session of entries) addSession(session);
  const saved = localStorage.getItem(`oep.activeSession.${project}`) ?? localStorage.getItem('oep.activeSession');
  renderSessions();
  if (entries.length) select(knownSessions.has(saved) ? saved : entries.at(-1).id);
  agent.disabled = stop.disabled = false;
  if (bootstrap.knowledge) disableKnowledge = bindKnowledge();
} catch (error) {
  connection.textContent = '尚未連線';
  showError(error instanceof RequestError && error.status === 401 ? '請雙擊 Windows 啟動器開啟 OEP。' : error);
}
