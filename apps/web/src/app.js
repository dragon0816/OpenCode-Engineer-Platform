import { connect, request, RequestError } from './api.js';
import { bindKnowledge } from './knowledge.js';

const find = (id) => document.getElementById(id);
const model = find('model');
const sessions = find('sessions');
const agent = find('agent');
const create = find('new-session');
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

function sessionLabel(session) {
  const timestamp = new Intl.DateTimeFormat('zh-Hant', { dateStyle: 'short', timeStyle: 'short' }).format(session.createdAt);
  return `${labels[session.agent]} · ${timestamp}`;
}

function render(context) {
  const { state, selected, id } = context;
  if (state.messages) {
    const previous = messages.lastElementChild?.dataset.id;
    const fragment = document.createDocumentFragment();
    for (const item of state.messages) {
      const entry = node('article', '', `message ${item.role}`);
      entry.dataset.id = item.id;
      entry.append(node('strong', item.role === 'user' ? '你' : labels[state.session.agent]), node('p', item.text));
      fragment.append(entry);
    }
    messages.replaceChildren(fragment);
    if (!state.messages.length) messages.append(node('p', '上傳附件或直接輸入訊息。', 'empty'));
    else if (previous !== state.messages.at(-1)?.id) messages.scrollTop = messages.scrollHeight;
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
    link.href = `/api/sessions/${id}/artifacts/${run.id}`;
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
      const state = await request(`/api/sessions/${context.id}/state`, { signal: context.abort.signal });
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
  if (!session) return;
  sessions.value = id;
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
  const events = new EventSource(`/api/sessions/${id}/events`);
  const context = { id, abort: new AbortController(), events, selected: selections.get(id) };
  current = context;
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
  const option = node('option', sessionLabel(session));
  option.value = session.id;
  sessions.append(option);
  sessions.disabled = false;
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
      const result = await request(`/api/sessions/${context.id}/attachments`, { file });
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

sessions.addEventListener('change', () => select(sessions.value));
create.addEventListener('click', async () => {
  create.disabled = true;
  showError();
  try {
    const session = await request('/api/sessions', { data: { agent: agent.value } });
    if (knownSessions.size === 0) sessions.replaceChildren();
    addSession(session);
    select(session.id);
  } catch (error) { showError(error); }
  finally { create.disabled = stopped; }
});
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
    await request(`/api/sessions/${context.id}/turns`, { data: { id, ...data } });
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
    agent.disabled = create.disabled = sessions.disabled = true;
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
  if (bootstrap.job.demo && bootstrap.job.state === 'awaiting_review') find('demo-job').hidden = false;
  if (bootstrap.sessions.length) sessions.replaceChildren();
  for (const session of bootstrap.sessions) addSession(session);
  if (bootstrap.sessions.length) select(bootstrap.sessions.at(-1).id);
  agent.disabled = create.disabled = stop.disabled = false;
  if (bootstrap.knowledge) disableKnowledge = bindKnowledge();
} catch (error) {
  connection.textContent = '尚未連線';
  showError(error instanceof RequestError && error.status === 401 ? '請雙擊 Windows 啟動器開啟 OEP。' : error);
}
