import { connect, request, RequestError } from './api.js';
import { bindVoice } from './voice.js';
import { bindNotes, messageActions } from './message-operations.js';
import { bindCommands } from './commands.js';
import { bindKnowledge } from './knowledge.js';
import { bindMcpSettings } from './mcp-settings.js';
import { loadJobSummary } from './jobs.js';

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
const cancelTurn = find('cancel-turn');
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
  background: '正在產生並驗證工作簿', indeterminate: '正在核對未確定的結果', failed: '這次處理未完成', verified: '已完成', cancelled: '已停止這次處理',
};
const eventLabels = {
  working: '開始處理', responding: '模型開始回覆', 'tool-started': '準備使用工具', 'tool-running': '工具執行中',
  'tool-completed': '工具完成', 'tool-failed': '工具未完成', recovering: '模型正在重試',
  permission: '正在檢查工具權限', finished: '處理完成', failed: '處理失敗', interrupted: '處理已停止',
};
const activeStates = new Set(['accepted', 'running', 'awaiting_permission', 'background', 'indeterminate']);
const knownSessions = new Map();
const selections = new Map();
const submitted = new Map();
const drafts = new Map();
const replies = new Map();
const replyChip = find('reply-chip');
function renderReply() {
  const reply = replies.get(current?.id);
  replyChip.hidden = !reply;
  find('reply-chip-text').textContent = reply ? '回覆 · ' + reply.text.slice(0, 120) : '';
}
find('clear-reply').addEventListener('click', () => {
  replies.delete(current?.id);
  renderReply();
  prompt.focus();
});
const renderNotes = bindNotes(find('notes-filter'), find('session-notes'), find('export-notes'), (id) => {
  const message = messages.querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!message) return;
  if (panelNarrow.matches) setPanel(false);
  message.focus();
  message.scrollIntoView({ block: 'center' });
});
let current;
let uploadBusy = false;
let sending = false;
let stopped = false;
let knowledge;
const voice = bindVoice(find('enable-microphone'), find('microphone'), find('microphone-settings-status'), prompt, () => current, showError);

function showError(error) {
  notice.textContent = error ? error.message || String(error) : '';
  notice.hidden = !error;
}

function runningID(context) {
  const latest = context?.state?.runs.at(-1);
  return context?.pendingID ?? (activeStates.has(latest?.state) && latest.state !== 'indeterminate' ? latest.id : undefined);
}

function setControls() {
  const cancellable = !stopped && Boolean(runningID(current));
  send.hidden = cancellable;
  cancelTurn.hidden = !cancellable;
  cancelTurn.disabled = !cancellable || Boolean(current?.cancelling);
  pick.disabled = !current || uploadBusy || stopped;
  prompt.disabled = !current || stopped;
  voice.update();
  find('project-read').hidden = !current || !find('project-read-folder').options.length || stopped;
  find('project-read-button').disabled = uploadBusy;
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
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (menu.open) close();
    else { menu.open = true; actions[0].focus(); }
  });
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
      const ordered = /^\s*\d+\. /.test(line);
      const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*+] /;
      const list = node(ordered ? 'ol' : 'ul');
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

function toolCard(tool, previous) {
  const card = previous ?? node('details', '', 'tool-card');
  if (!previous) {
    card.dataset.tool = tool.id;
    card.append(node('summary'), node('div', '', 'tool-details'));
  }
  const duration = Math.max(0, (tool.finishedAt ?? Date.now()) - tool.startedAt);
  const status = { running: '執行中', done: '完成', failed: '失敗', cancelled: '已停止' }[tool.status];
  card.dataset.status = tool.status;
  card.firstElementChild.textContent = `${tool.name} · ${status} · ${(duration / 1000).toFixed(1)} 秒`;
  const fields = card.lastElementChild;
  const signature = JSON.stringify([tool.input, tool.output]);
  if (fields.dataset.signature === signature) return card;
  fields.dataset.signature = signature;
  fields.replaceChildren();
  for (const [label, value] of [['輸入', tool.input], ['輸出', tool.output]]) {
    fields.append(node('strong', label));
    const excerpt = node('pre', value ? value.slice(0, 800) : '—');
    fields.append(excerpt);
    if (value.length > 800) {
      const toggle = sessionButton('顯示全部', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        toggle.textContent = expanded ? '顯示全部' : '收合內容';
        excerpt.textContent = expanded ? value.slice(0, 800) : value;
      });
      toggle.setAttribute('aria-expanded', 'false');
      fields.append(toggle);
    }
  }
  return card;
}

function render(context) {
  const { state, id } = context;
  if (state.messages) {
    const follow = !context.renderedMessages || atBottom();
    const offset = messages.scrollTop;
    const previous = new Map([...messages.querySelectorAll('.tool-card')].map((card) => [card.dataset.tool, card]));
    const eventCards = new Map([...messages.querySelectorAll('.event-card')].map((card) => [card.dataset.event, card]));
    const activity = [...(state.activity ?? [])].sort((left, right) => left.createdAt - right.createdAt);
    let eventIndex = 0;
    const appendEvents = (through) => {
      while (eventIndex < activity.length && activity[eventIndex].createdAt <= through) {
        const event = activity[eventIndex++];
        const card = eventCards.get(event.id) ?? node('details', '', 'event-card');
        if (!card.dataset.event) {
          card.dataset.event = event.id;
          card.append(node('summary', eventLabels[event.kind]), node('time', new Date(event.createdAt).toLocaleString('zh-Hant')));
        }
        fragment.append(card);
      }
    };
    const focused = messages.contains(document.activeElement) ? document.activeElement : undefined;
    const fragment = document.createDocumentFragment();
    for (const item of state.messages) {
      appendEvents(item.createdAt ?? 0);
      const entry = node('article', '', `message ${item.role}`);
      entry.dataset.id = item.id;
      entry.tabIndex = -1;
      if (item.role === 'assistant') entry.append(avatar());
      const role = node('strong', item.role === 'user' ? '你' : labels[state.session.agent]);
      if (item.createdAt) role.title = new Date(item.createdAt).toLocaleString('zh-Hant');
      entry.append(role);
      if (item.reply) entry.append(node('blockquote', item.reply.text, 'message-quote'));
      const content = node('div');
      if (item.role === 'assistant') appendMarkdown(content, item.text);
      else content.append(node('p', item.text));
      entry.append(content);
      for (const tool of item.tools ?? []) entry.append(toolCard(tool, previous.get(tool.id)));
      entry.append(messageActions(context, item, content, (reference) => {
        replies.set(id, reference);
        renderReply();
        prompt.focus();
      }, showError, (text) => { find('command-toast').textContent = text; },
      () => { if (current === context) renderNotes(context); }));
      fragment.append(entry);
    }
    appendEvents(Infinity);
    messages.replaceChildren(fragment);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (!state.messages.length) messages.append(node('p', '上傳附件或直接輸入訊息。', 'empty'));
    messages.scrollTop = follow ? messages.scrollHeight : offset;
    jump.hidden = atBottom();
    context.renderedMessages = true;
  }
  const latest = state.runs.at(-1);
  const row = sessions.querySelector(`[data-session="${id}"]`);
  const phase = activeStates.has(latest?.state) ? 'running' : latest?.state === 'failed' ? 'failed' : '';
  context.phase = phase;
  if (row) row.dataset.phase = phase;
  if (context.pendingID && state.runs.some((run) => run.id === context.pendingID)) {
    context.pendingID = undefined;
    context.pendingAt = undefined;
  }
  updateProgress();
  if (state.stateError || latest?.error) showError(state.stateError || latest.error);
  else if (!context.requestError) showError();
  renderPanel(context);
  renderNotes(context);
  setControls();
}

function renderPanel(context) {
  const { state, selected, path } = context;
  find('panel-tools').hidden = !state.session.tools?.includes('oep_knowledge_ask');
  const fileKey = JSON.stringify([state.attachments, state.runs, [...selected]]);
  if (context.fileKey === fileKey) return;
  context.fileKey = fileKey;
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
    addFileDetails(entry, attachment, `${path}/attachments/${attachment.id}`, context, true);
    attachmentList.append(entry);
  }
  artifactList.replaceChildren();
  for (const run of state.runs.filter((run) => run.artifact).reverse()) {
    const entry = node('li');
    const artifact = { ...run.artifact, createdAt: run.finishedAt ?? run.createdAt };
    addFileDetails(entry, artifact, `${path}/artifacts/${run.id}`, context);
    artifactList.append(entry);
  }
  if (!artifactList.children.length) emptyList(artifactList, '尚無可下載的產物');
  const ledger = find('panel-runs');
  ledger.replaceChildren(...state.runs.toReversed().map((run) =>
    node('li', `${formatDate(run.createdAt)} · ${statuses[run.state] ?? '狀態未知'}`)));
  if (!ledger.children.length) emptyList(ledger, '此會話尚無工作紀錄');
  renderDiffChoices(context);
}

function formatDate(at) {
  return new Date(at).toLocaleString('zh-TW');
}

function action(text, handler) {
  const button = node('button', text);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function fileType(file) {
  return file.name.includes('.') ? file.name.split('.').at(-1).toUpperCase() : file.mime;
}

function addFileDetails(entry, file, url, context, attachment = false) {
  const download = node('a', attachment ? '下載' : file.name);
  download.href = url;
  download.download = file.name;
  const actions = node('div', undefined, 'file-actions');
  const hash = action(file.sha256.slice(0, 12), async () => {
    try {
      await navigator.clipboard.writeText(file.sha256);
      find('upload-status').textContent = '已複製 SHA-256。';
    } catch { find('upload-status').textContent = '無法複製 SHA-256。'; }
  });
  hash.setAttribute('aria-label', `複製 ${file.name} 的 SHA-256`);
  hash.title = file.sha256;
  if (!attachment) entry.append(download);
  entry.append(node('small', `${file.bytes.toLocaleString('zh-TW')} 位元組 · ${fileType(file)} · ${formatDate(file.createdAt)}`));
  const open = action('預覽', () => void openPreview(file, url, context, open));
  actions.append(hash, open);
  if (attachment) actions.append(download, action('移除', async () => {
    if (!confirm(`要移除「${file.name}」嗎？`)) return;
    try {
      await request(url, { data: {}, signal: context.abort.signal });
      if (current !== context) return;
      context.selected.delete(file.id);
      if (previewPath === url) closePreview();
      refresh(context);
    } catch (error) {
      if (current === context) showError(new Error(error.status === 409 ? '請等這次處理結束後再移除附件。' : '無法移除附件。'));
    }
  }));
  entry.append(actions);
}

const preview = find('file-preview');
let previewURL;
let previewPath;
let previewRequest;

function closePreview() {
  previewRequest?.abort();
  previewPath = undefined;
  preview.replaceChildren();
  find('file-list').hidden = false;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = undefined;
}

async function previewResponse(url, signal) {
  const response = await fetch(`${url}/preview`, { signal });
  if (!response.ok) throw new Error('無法載入預覽');
  return response;
}

async function openPreview(file, url, context, opener) {
  closePreview();
  previewPath = url;
  const abort = new AbortController();
  previewRequest = abort;
  const body = node('div', undefined, 'preview-body');
  const title = node('h2', file.name);
  title.tabIndex = -1;
  const close = action('關閉預覽', () => {
    closePreview();
    (opener.isConnected ? opener : find('panel-files')).focus();
  });
  find('file-list').hidden = true;
  preview.append(title, node('small', `${fileType(file)} · ${file.bytes.toLocaleString('zh-TW')} 位元組 · ${formatDate(file.createdAt)}`), close, body);
  title.focus({ preventScroll: true });
  find('panel-files').scrollTop = 0;
  if (file.mime === 'application/pdf') {
    body.textContent = '目前無法預覽 PDF。請下載後開啟。';
    return;
  }
  body.textContent = '正在載入預覽…';
  try {
    const result = await previewResponse(url, AbortSignal.any([abort.signal, context.abort.signal]));
    const data = file.mime.startsWith('image/') ? await result.blob() : await result.text();
    if (abort.signal.aborted || current !== context) return;
    body.replaceChildren();
    const extension = file.name.split('.').at(-1).toLowerCase();
    if (data instanceof Blob) {
      if (!['image/png', 'image/jpeg'].includes(data.type) || data.size > 20 * 1024 * 1024) throw new Error();
      const image = node('img');
      image.alt = file.name;
      previewURL = URL.createObjectURL(data);
      image.src = previewURL;
      body.append(image);
    } else if (extension === 'html' || extension === 'htm') {
      const frame = node('iframe');
      frame.title = file.name;
      frame.setAttribute('sandbox', '');
      frame.inert = true;
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">${data}`;
      body.append(node('p', '隔離預覽，指令碼與外部資源已停用。'), frame);
    } else if (extension === 'csv' || extension === 'xlsx') {
      renderSheets(body, readSheets(data, extension === 'xlsx'));
    } else if (extension === 'md') appendMarkdown(body, data);
    else body.append(node('pre', data));
  } catch {
    if (!abort.signal.aborted && current === context) body.textContent = '無法預覽這個檔案。請下載後開啟。';
  }
}

function readCSV(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index++; }
      else if (quoted || !field) quoted = !quoted;
      else field += char;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && source[index + 1] === '\n') index++;
      rows.push([...row, field]);
      row = [];
      field = '';
    } else field += char;
  }
  if (row.length || field) rows.push([...row, field]);
  return rows;
}

function readSheets(source, workbook) {
  const rows = readCSV(source);
  if (!workbook) return new Map([['CSV', rows]]);
  const sheets = new Map();
  let sheet;
  for (const [label, ...cells] of rows) {
    if (label === 'Sheet') {
      sheet = [];
      sheets.set(cells[0], sheet);
    } else if (sheet && /^Row [1-9]\d*$/.test(label)) {
      sheet[Number(label.slice(4)) - 1] = cells;
    }
  }
  return sheets;
}

function renderSheets(target, sheets, before = new Map(), lines = false) {
  const select = node('select');
  select.setAttribute('aria-label', '工作表');
  select.hidden = sheets.size === 1 && (lines || sheets.has('CSV')) && before.size <= 1;
  for (const name of new Set([...sheets.keys(), ...before.keys()])) {
    select.append(new Option(name, name));
  }
  const content = node('div');
  target.append(select, content);
  function renderSheet() {
    const rows = sheets.get(select.value) ?? [];
    const prior = before.get(select.value) ?? [];
    const diff = before.size > 0;
    const length = Math.max(rows.length, prior.length);
    const table = node('table');
    const scroller = node('div', undefined, 'table-scroll');
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', lines ? '文字差異' : '表格內容');
    scroller.append(table);
    const tbody = table.createTBody();
    let index = 0;
    let changes = 0;
    for (let row = 0; diff && row < length; row++) {
      const old = prior[row] ?? [];
      const next = rows[row] ?? [];
      for (let cell = 0; cell < Math.max(old.length, next.length); cell++) {
        if ((old[cell] ?? '') !== (next[cell] ?? '')) changes++;
      }
    }
    const more = action('顯示更多', appendRows);
    function appendRows() {
      const end = Math.min(index + 200, length);
      for (; index < end; index++) {
        const tr = tbody.insertRow();
        const beforeRow = prior[index] ?? [];
        const afterRow = rows[index] ?? [];
        const header = node('th', String(index + 1));
        header.scope = 'row';
        tr.append(header);
        for (let cell = 0; cell < Math.min(100, Math.max(beforeRow.length, afterRow.length)); cell++) {
          const old = beforeRow[cell] ?? '';
          const next = afterRow[cell] ?? '';
          const td = tr.insertCell();
          if (diff && old !== next) {
            td.className = 'changed-cell';
            td.append(node('del', old || '（空白）'), node('ins', next || '（空白）'));
          } else td.textContent = next;
        }
      }
      more.hidden = index >= length;
    }
    content.replaceChildren();
    if (diff) content.append(node('p', lines ? `${changes} 行有變更` : `這張工作表有 ${changes} 個儲存格有變更`));
    if (rows.some((row) => row.length > 100)) content.append(node('p', '預覽顯示前 100 欄。'));
    content.append(scroller, more);
    appendRows();
  }
  select.addEventListener('change', renderSheet);
  renderSheet();
}

function renderDiffChoices(context) {
  const target = find('panel-diff');
  const runs = context.state.runs.filter((run) => run.artifact);
  const key = runs.map((run) => run.id).join(',');
  if (context.diffKey === key) return;
  context.diffKey = key;
  target.replaceChildren();
  const earlier = new Map();
  const pairs = [];
  for (const run of runs) {
    const prior = earlier.get(run.artifact.name);
    if (prior) pairs.unshift([prior, run]);
    earlier.set(run.artifact.name, run);
  }
  if (!pairs.length) {
    target.append(node('p', '此會話沒有可比較的產物版本。'));
    return;
  }
  const choice = node('select');
  choice.setAttribute('aria-label', '產物版本');
  for (const [index, [, run]] of pairs.entries()) {
    choice.append(new Option(`${run.artifact.name} · 版本 ${pairs.length - index + 1}`, String(index)));
  }
  const body = node('div', undefined, 'preview-body');
  let controller;
  async function compare() {
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    const [prior, run] = pairs[Number(choice.value)];
    body.textContent = '正在比較版本…';
    try {
      const signal = AbortSignal.any([abort.signal, context.abort.signal]);
      const [before, after] = await Promise.all([prior, run].map(async ({ id }) =>
        (await previewResponse(`${context.path}/artifacts/${id}`, signal)).text()));
      if (signal.aborted || !body.isConnected) return;
      body.replaceChildren(node('small', `比較前 · ${formatDate(prior.createdAt)}`),
        node('small', `比較後 · ${formatDate(run.createdAt)}`));
      if (/\.xlsx$/i.test(run.artifact.name)) renderSheets(body, readSheets(after, true), readSheets(before, true));
      else renderSheets(body, new Map([['文字', after.split(/\r?\n/).map((line) => [line])]]),
        new Map([['文字', before.split(/\r?\n/).map((line) => [line])]]), true);
    } catch {
      if (!abort.signal.aborted) body.textContent = '無法比較這兩個版本。';
    }
  }
  target.append(choice, action('比較版本', () => void compare()), body);
}

function updateProgress() {
  if (!current || stopped) return;
  const latest = current.state?.runs.at(-1);
  const startedAt = current.pendingAt ?? (activeStates.has(latest?.state) ? latest.createdAt : undefined);
  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : undefined;
  const label = current.pendingAt || latest?.state === 'running' ? '正在產生回覆' : statuses[latest?.state];
  const text = elapsed === undefined ? (label ?? '等待訊息') : `${label}，已等候 ${elapsed} 秒`;
  if (progress.textContent !== text) progress.textContent = text;
}
setInterval(updateProgress, 1000);

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

const rightPanel = find('chat-files');
const panelToggle = find('toggle-files');
const panelNarrow = matchMedia('(max-width: 900px)');
const panelTabs = [...rightPanel.querySelectorAll('[role="tab"]')];

function activatePanel(tab) {
  for (const candidate of panelTabs) {
    const active = tab === candidate;
    candidate.setAttribute('aria-selected', String(active));
    candidate.tabIndex = active ? 0 : -1;
    find(candidate.getAttribute('aria-controls')).hidden = !active;
  }
  if (current) localStorage.setItem(`oep.panel.${current.path}`, tab.id);
  if (tab.id === 'tab-work') void loadJobSummary();
}

function setPanel(open) {
  rightPanel.classList.toggle('sheet-open', open);
  panelToggle.setAttribute('aria-expanded', String(open));
}

panelToggle.addEventListener('click', () => {
  const open = !rightPanel.classList.contains('sheet-open');
  setPanel(open);
  if (open) rightPanel.querySelector('[aria-selected="true"]').focus();
});
find('close-files').addEventListener('click', () => { setPanel(false); panelToggle.focus(); });
panelNarrow.addEventListener('change', () => setPanel(false));
rightPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panelNarrow.matches) {
    event.preventDefault();
    setPanel(false);
    panelToggle.focus();
  }
});
for (const [index, tab] of panelTabs.entries()) {
  tab.addEventListener('click', () => activatePanel(tab));
  tab.addEventListener('keydown', (event) => {
    const target = {
      ArrowRight: (index + 1) % panelTabs.length,
      ArrowLeft: (index + panelTabs.length - 1) % panelTabs.length,
      Home: 0, End: panelTabs.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    activatePanel(panelTabs[target]);
    panelTabs[target].focus();
  });
}

function select(id) {
  voice.cancel();
  find('project-read').open = false;
  if (current) drafts.set(current.id, { text: prompt.value, workbook: workbook.checked });
  current?.events.close();
  current?.abort.abort();
  const session = knownSessions.get(id);
  current = undefined;
  renderNotes(null);
  renderReply();
  find('runtime-agent').textContent = session ? `目前會話助理：${labels[session.agent]}` : '目前沒有選取會話。';
  closePreview();
  find('panel-runs').replaceChildren();
  find('panel-diff').replaceChildren();
  jump.hidden = true;
  if (!session) {
    updateSessionAlias();
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
  renderReply();
  find('session-model-status').textContent = '';
  updateSessionAlias();
  activatePanel(panelTabs.find((tab) => tab.id === localStorage.getItem(`oep.panel.${path}`)) ?? panelTabs[0]);
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
  find('session-count').textContent = knownSessions.size;
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
      if (current?.id === session.id) link.dataset.phase = current.phase ?? '';
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
  updateProjectRead();
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

let projectFolders = [];
const folderForm = find('project-folder-form');
const folderProject = find('folder-project');
const folderStatus = find('project-folder-status');

function updateProjectRead() {
  const folders = projectFolders.find((entry) => entry.id === project)?.folders ?? [];
  find('project-read-folder').replaceChildren(...folders.map((path) => new Option(path, path)));
  setControls();
}
function displayProjectFolders() {
  const active = projectFolders.find((entry) => entry.id === folderProject.value);
  if (!active) return;
  find('project-working-root').textContent = '工作根目錄 · ' + active.workingRoot;
  find('project-folder-list').replaceChildren(...active.folders.map((folder) => {
    const row = node('li', folder);
    row.append(' ', sessionButton('移除', () => void changeProjectFolder('remove', folder)));
    return row;
  }));
}
async function changeProjectFolder(action, folder) {
  try {
    projectFolders = await request('/api/settings/projects', { data: { action, folder, project: folderProject.value } });
    folderStatus.textContent = action === 'add' ? '已加入唯讀資料夾。' : '已移除唯讀資料夾。';
    if (action === 'add') folderForm.reset();
    displayProjectFolders();
    updateProjectRead();
  } catch (error) { folderStatus.textContent = error.message; }
}
folderProject.addEventListener('change', displayProjectFolders);
folderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void changeProjectFolder('add', find('project-folder').value.trim());
});
find('project-read-button').addEventListener('click', async () => {
  const context = current;
  const field = find('project-read-file');
  if (!context || !field.value.trim() || uploadBusy || stopped) return;
  uploadBusy = true;
  setControls();
  try {
    const attachment = await request(context.path + '/read-project-file', { data: {
      folder: find('project-read-folder').value, file: field.value.trim(),
    } });
    context.selected.add(attachment.id);
    if (current === context) {
      field.value = '';
      find('project-read').open = false;
      uploadStatus.textContent = '已附加檔案副本。';
      refresh(context);
    }
  } catch (error) {
    if (current === context) showError(error);
  } finally {
    uploadBusy = false;
    setControls();
  }
});

const preferenceFields = ['name', 'introduction', 'instructions'];
let savedAssistant;
let settingsSaving = false;
function assistantValues() {
  return Object.fromEntries(preferenceFields.map((field) => [field, find(`assistant-${field}`).value]));
}
function applyPreferences(preferences) {
  for (const field of preferenceFields) find(`assistant-${field}`).value = preferences[field];
  savedAssistant = JSON.stringify(assistantValues());
  find('sidebar-assistant-name').textContent = preferences.name || '助理';
  const introduction = find('sidebar-assistant-intro');
  introduction.textContent = preferences.introduction || '本機工程工作助理';
  introduction.title = introduction.textContent;
}
find('assistant-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = find('save-assistant');
  if (button.disabled) return;
  const data = assistantValues();
  const controls = [...event.currentTarget.elements];
  controls.forEach((control) => { control.disabled = true; });
  settingsSaving = true;
  find('settings-status').textContent = '正在儲存…';
  try {
    applyPreferences(await request('/api/settings', { data }));
    find('settings-status').textContent = '已儲存';
  } catch {
    find('settings-status').textContent = '無法儲存助理設定，請再試一次。';
  } finally {
    settingsSaving = false;
    controls.forEach((control) => { control.disabled = stopped; });
  }
});

const theme = find('theme');
const density = find('density');
const avatarFile = find('avatar-file');
const appearanceStatus = find('appearance-status');
const appearanceSave = find('save-appearance');
const legacyTheme = localStorage.getItem('oep.theme');
let savedAppearance;
let avatarReset = false;
let showingAvatar = false;
function avatar() {
  const element = node('span', 'O', 'assistant-avatar');
  element.setAttribute('aria-hidden', 'true');
  paintAvatar(element);
  return element;
}
function paintAvatar(element) {
  if (!showingAvatar) { element.textContent = 'O'; return; }
  const image = document.createElement('img');
  image.alt = '';
  image.src = '/api/settings/avatar';
  element.replaceChildren(image);
}
function previewAppearance() {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.dataset.density = density.value;
}
function applyAppearance(value) {
  savedAppearance = { ...value, theme: value.theme ?? theme.value };
  theme.value = savedAppearance.theme;
  density.value = value.density;
  avatarFile.value = '';
  avatarReset = false;
  showingAvatar = value.hasAvatar;
  document.querySelectorAll('.assistant-avatar').forEach(paintAvatar);
  previewAppearance();
}
if (['system', 'light', 'dark'].includes(legacyTheme)) theme.value = legacyTheme;
for (const input of [theme, density]) input.addEventListener('change', previewAppearance);
previewAppearance();
find('avatar-reset').addEventListener('click', () => {
  avatarReset = true;
  avatarFile.value = '';
  appearanceStatus.textContent = '儲存後會還原預設頭像。';
});
avatarFile.addEventListener('change', () => { avatarReset = false; });
async function encodeAvatar(file) {
  if (file.size > 90 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
find('appearance-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (appearanceSave.disabled) return;
  const fields = [theme, density, avatarFile, find('avatar-reset'), appearanceSave];
  fields.forEach((field) => { field.disabled = true; });
  settingsSaving = true;
  appearanceStatus.textContent = '正在儲存…';
  try {
    const data = { theme: theme.value, density: density.value };
    if (avatarFile.files.length) data.avatar = await encodeAvatar(avatarFile.files[0]);
    else if (avatarReset) data.avatar = null;
    applyAppearance(await request('/api/settings/appearance', { data }));
    localStorage.removeItem('oep.theme');
    appearanceStatus.textContent = '已儲存';
  } catch {
    appearanceStatus.textContent = '無法儲存外觀。請確認圖片格式、檔案大小及寬高。';
  } finally {
    settingsSaving = false;
    fields.forEach((field) => { field.disabled = stopped; });
  }
});
function appearanceDirty() {
  return savedAppearance && (theme.value !== savedAppearance.theme || density.value !== savedAppearance.density ||
    avatarReset || avatarFile.files.length > 0);
}
const defaultAlias = find('default-alias');
const sessionAlias = find('session-alias');
const modelStatus = find('model-settings-status');
let modelSettings;
function aliasOptions(select, selected, aliases) {
  select.replaceChildren(...aliases.map(({ alias }) => {
    const option = node('option', alias);
    option.value = alias;
    return option;
  }));
  select.value = selected ?? '';
}
function updateSessionAlias() {
  const session = current && knownSessions.get(current.id);
  aliasOptions(sessionAlias, session?.alias, modelSettings?.aliases ?? []);
  sessionAlias.disabled = !session || !modelSettings || stopped;
  if (modelSettings) model.textContent = `模型 ${session?.alias ?? modelSettings.defaultAlias}`;
}
function applyModel(value, draft = value.defaultAlias) {
  modelSettings = value;
  aliasOptions(defaultAlias, draft, value.aliases);
  find('model-credentials').textContent = value.credentialsConfigured ? '憑證已設定' : '憑證未設定';
  find('model-health').replaceChildren(...value.aliases.map(({ alias, healthy }) =>
    node('li', `${alias} · ${healthy ? '可用' : '無法通過檢查'}`)));
  updateSessionAlias();
  for (const id of ['default-alias', 'recheck-model', 'save-model']) find(id).disabled = stopped;
}
async function updateModel(recheck) {
  const draft = defaultAlias.value;
  if (!recheck) settingsSaving = true;
  modelStatus.textContent = recheck ? '正在檢查…' : '正在儲存…';
  for (const id of ['default-alias', 'recheck-model', 'save-model']) find(id).disabled = true;
  try {
    const path = '/api/settings/model' + (recheck ? '/recheck' : '');
    const value = await request(path, { data: recheck ? {} : { alias: draft } });
    applyModel(value, recheck ? defaultAlias.value : undefined);
    modelStatus.textContent = recheck ? '已重新檢查' : '已儲存';
  } catch (error) {
    modelStatus.textContent = error.status === 429 ? '請等候 30 秒再重新檢查。' : '無法更新模型設定。';
    for (const id of ['default-alias', 'recheck-model', 'save-model']) find(id).disabled = stopped;
  } finally { if (!recheck) settingsSaving = false; }
}
find('model-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!find('save-model').disabled) void updateModel(false);
});
find('recheck-model').addEventListener('click', () => void updateModel(true));
sessionAlias.addEventListener('change', async () => {
  const context = current;
  const status = find('session-model-status');
  if (!context) return;
  sessionAlias.disabled = true;
  try {
    const session = await request(`${context.path}/model`, { data: { alias: sessionAlias.value } });
    knownSessions.set(session.id, session);
    if (current === context) status.textContent = '模型已切換';
  } catch (error) {
    if (current === context) status.textContent = error.status === 409 ? '請等這次處理結束。' : '無法切換模型。';
  } finally { if (current === context) updateSessionAlias(); }
});
function modelDirty() {
  return modelSettings && defaultAlias.value !== modelSettings.defaultAlias;
}
const limitLabels = {
  recentMessages: '最近訊息則數', historyBytes: '歷史位元組上限',
  toolCalls: '工具呼叫次數上限', timeoutSeconds: '回合時限（秒）',
};
const limitsStatus = find('limits-status');
const saveLimits = find('save-limits');
let savedLimits;
const limitInputs = new Map();
function applyLimits({ values, fields }) {
  savedLimits = values;
  for (const [key, field] of Object.entries(fields)) {
    if (!limitInputs.has(key)) {
      const id = `limit-${key}`;
      const label = node('label', limitLabels[key]);
      label.htmlFor = id;
      const input = node('input');
      input.id = id;
      input.type = 'number';
      input.min = field.min;
      input.max = field.max;
      input.required = true;
      const help = node('small', `範圍 ${field.min} 至 ${field.max}，預設 ${field.initial}。`);
      help.id = `${id}-help`;
      input.setAttribute('aria-describedby', help.id);
      const row = node('div');
      row.append(label, input, help);
      find('limit-fields').append(row);
      limitInputs.set(key, input);
    }
    limitInputs.get(key).value = values[key];
  }
  saveLimits.disabled = stopped;
}
function limitsDirty() {
  return savedLimits && [...limitInputs].some(([key, input]) => input.valueAsNumber !== savedLimits[key]);
}
find('limits-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saveLimits.disabled) return;
  saveLimits.disabled = true;
  settingsSaving = true;
  limitsStatus.textContent = '正在儲存…';
  const data = Object.fromEntries([...limitInputs].map(([key, input]) => [key, input.valueAsNumber]));
  for (const input of limitInputs.values()) input.disabled = true;
  try {
    applyLimits(await request('/api/settings/limits', { data }));
    limitsStatus.textContent = '已儲存';
  } catch {
    limitsStatus.textContent = '無法儲存回合限制。請檢查數值範圍。';
  } finally {
    settingsSaving = false;
    for (const input of limitInputs.values()) input.disabled = stopped;
    saveLimits.disabled = stopped;
  }
});
function assistantDirty() {
  return savedAssistant !== undefined && savedAssistant !== JSON.stringify(assistantValues());
}
function discardSettings() {
  if (settingsSaving) return false;
  if (!assistantDirty() && !appearanceDirty() && !modelDirty() && !limitsDirty()) return true;
  if (!window.confirm('設定尚未儲存。要捨棄變更嗎？')) return false;
  if (assistantDirty()) applyPreferences(JSON.parse(savedAssistant));
  if (appearanceDirty()) applyAppearance(savedAppearance);
  if (modelDirty()) applyModel(modelSettings);
  if (limitsDirty()) for (const [key, input] of limitInputs) input.value = savedLimits[key];
  find('settings-status').textContent = appearanceStatus.textContent = modelStatus.textContent = limitsStatus.textContent = '';
  return true;
}
window.addEventListener('beforeunload', (event) => {
  if (!assistantDirty() && !appearanceDirty() && !modelDirty() && !limitsDirty()) return;
  event.preventDefault();
  event.returnValue = true;
});

const knowledgeSettings = find('knowledge-settings');
const atlasInput = find('atlas-url');
const atlasButton = find('open-atlas');
const knowledgeSettingsStatus = find('knowledge-settings-status');
let savedAtlas = '';
function applyKnowledgeSettings({ atlasUrl, toolbox }) {
  atlasInput.value = savedAtlas = atlasUrl;
  find('knowledge-toolbox').checked = toolbox;
  atlasButton.disabled = !savedAtlas;
}
async function loadKnowledgeSettings() {
  try { applyKnowledgeSettings(await request('/api/settings/knowledge')); }
  catch { knowledgeSettingsStatus.textContent = '無法讀取知識庫設定。'; }
}
knowledgeSettings.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    applyKnowledgeSettings(await request('/api/settings/knowledge', {
      data: { atlasUrl: atlasInput.value, toolbox: find('knowledge-toolbox').checked },
    }));
    knowledgeSettingsStatus.textContent = '已儲存。';
  } catch (error) { knowledgeSettingsStatus.textContent = error.message; }
});
atlasButton.addEventListener('click', () => {
  if (savedAtlas && window.confirm('即將離開此頁並在新分頁開啟 Atlas。要繼續嗎？')) {
    window.open(savedAtlas, '_blank', 'noopener,noreferrer');
  }
});

const settingsView = find('settings-view');
const settingsEntry = find('open-settings');
const settingsSections = [...find('settings-nav').querySelectorAll('button')];

const loadCustomMcp = bindMcpSettings(() => projects);

async function loadMcpSettings() {
  void loadCustomMcp();
  const status = find('mcp-knowledge-status');
  status.textContent = '正在讀取連線狀態…';
  find('mcp-knowledge-tools').hidden = true;
  try {
    const [server] = await request('/api/settings/mcp');
    status.textContent = {
      connected: '已連線', disabled: '已停用', failed: '無法連線至內建知識庫。',
      needs_auth: '需要憑證', pending: '等待連線', unconfigured: '尚未設定知識庫',
    }[server.status];
    find('mcp-knowledge-tools').hidden = !server.tools.length;
  } catch { status.textContent = '無法讀取連線狀態。'; }
}

find('mcp-open-knowledge-settings').addEventListener('click', () => {
  settingsSections.find((section) => section.dataset.section === 'integrations').click();
  if (!find('settings-integrations').hidden) find('knowledge-toolbox').focus();
});

function showSettings() {
  for (const id of ['chat-view', 'chat-files', 'knowledge-view', 'jobs-view']) find(id).hidden = true;
  for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) find(id).removeAttribute('aria-current');
  settingsView.hidden = false;
  void loadKnowledgeSettings();
  if (!find('settings-mcp').hidden) void loadMcpSettings();
  settingsEntry.setAttribute('aria-current', 'page');
  if (narrowNavigation.matches) setSidebar(false);
  find('settings-title').focus();
}

settingsEntry.addEventListener('click', showSettings);
find('close-settings').addEventListener('click', () => {
  find('open-chat').click();
  if (settingsView.hidden && narrowNavigation.matches) sidebarToggle.focus();
});
for (const id of ['open-chat', 'open-knowledge', 'open-jobs']) {
  find(id).addEventListener('click', (event) => {
    if (settingsView.hidden) return;
    if (!discardSettings()) {
      event.stopImmediatePropagation();
      return;
    }
    settingsView.hidden = true;
    settingsEntry.removeAttribute('aria-current');
    if (id === 'open-chat') {
      find('chat-view').hidden = find('chat-files').hidden = false;
      find(id).setAttribute('aria-current', 'page');
    }
  }, { capture: true });
}
for (const button of settingsSections) {
  button.addEventListener('click', () => {
    if (button.hasAttribute('aria-current') || !discardSettings()) return;
    for (const section of settingsSections) {
      if (section === button) section.setAttribute('aria-current', 'page');
      else section.removeAttribute('aria-current');
      find(`settings-${section.dataset.section}`).hidden = section !== button;
    }
    if (button.dataset.section === 'mcp') void loadMcpSettings();
  });
}
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.key !== ',') return;
  event.preventDefault();
  showSettings();
});

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
  if (event.key !== 'Escape' || event.defaultPrevented || !narrowNavigation.matches) return;
  event.preventDefault();
  setSidebar(false);
  sidebarToggle.focus();
});
for (const section of document.querySelectorAll('.rail-section')) {
  const key = `oep.${section.id}.open`;
  section.open = localStorage.getItem(key) !== 'false';
  section.addEventListener('toggle', () => localStorage.setItem(key, String(section.open)));
}
find('assistant-count').textContent = agent.options.length;
function syncNavigation() {
  const visible = !find('chat-view').hidden ? 'open-chat' : !find('jobs-view').hidden ? 'open-jobs' : 'open-knowledge';
  for (const entry of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) {
    if (entry === visible) find(entry).setAttribute('aria-current', 'page');
    else find(entry).removeAttribute('aria-current');
  }
  if (narrowNavigation.matches) {
    setSidebar(false);
    if (visible === 'open-chat') sessionTitle.focus();
  }
}
find('open-review').addEventListener('click', () => {
  find('open-knowledge').click();
  if (find('knowledge-view').hidden) return;
  find('knowledge-tab-build').click();
  const review = find('ingest-review');
  review.open = true;
  review.querySelector('summary').focus();
  find('open-knowledge').removeAttribute('aria-current');
  find('open-review').setAttribute('aria-current', 'page');
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
  const card = find('remove-session-card');
  const path = sessionPath(session.id);
  find('remove-session-question').textContent = `確定刪除「${sessionLabel(session)}」？`;
  card.returnValue = 'reject';
  const decision = await new Promise((resolve) => {
    card.addEventListener('close', () => resolve(card.returnValue), { once: true });
    card.showModal();
  });
  try {
    await request(path + '/remove', { data: { decision } });
    if (decision !== 'accept') return;
    drafts.delete(session.id);
    replies.delete(session.id);
    selections.delete(session.id);
    submitted.delete(session.id);
    if (project !== session.project) return;
    knownSessions.delete(session.id);
    if (current?.id === session.id) select([...knownSessions.keys()].at(-1));
    renderSessions();
    (sessions.querySelector('[aria-current="true"]') ?? find('session-search')).focus();
    find('command-toast').textContent = '已刪除會話。';
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
  return current;
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
const executeCommand = bindCommands(prompt, find('slash-palette'), find('command-toast'), {
  async '/new'() {
    const previous = current?.id;
    const created = await createSession(project);
    if (created && created.id !== previous) return { text: '已新增會話。' };
  },
  async '/stop'() {
    await stopTurn();
    return { text: '已送出停止要求。' };
  },
  async '/model'(alias) {
    const context = current;
    if (!modelSettings?.aliases.some((entry) => entry.alias === alias)) throw new Error('請輸入核准的模型名稱。');
    const previous = knownSessions.get(context.id)?.alias;
    async function change(value) {
      const session = await request(context.path + '/model', { data: { alias: value } });
      if (current === context) {
        knownSessions.set(session.id, session);
        updateSessionAlias();
      }
    }
    await change(alias);
    return {
      text: '已切換模型。',
      undo: previous && previous !== alias ? () => change(previous) : undefined,
    };
  },
  async '/theme'(value) {
    if (!['light', 'dark'].includes(value)) throw new Error('請輸入 light 或 dark。');
    const previous = savedAppearance.theme;
    async function change(next) {
      applyAppearance(await request('/api/settings/appearance', { data: { theme: next, density: savedAppearance.density } }));
      localStorage.removeItem('oep.theme');
    }
    await change(value);
    return { text: '已切換主題。', undo: previous !== value ? () => change(previous) : undefined };
  },
  '/attach'() {
    if (pick.disabled) throw new Error('目前無法選擇附件。');
    pick.click();
  },
  async '/ask'(argument) {
    const [, vault, question] = /^(\S+)\s+([\s\S]+)$/.exec(argument) ?? [];
    if (!vault) throw new Error('請輸入知識庫識別碼和問題。');
    if (!knowledge) throw new Error('知識庫目前未設定。');
    await knowledge.ask(vault, question);
  },
  '/clear-search'() {
    const search = find('session-search');
    const previous = search.value;
    find('clear-session-search').click();
    prompt.focus();
    return { text: '已清除會話搜尋。', undo: previous ? () => {
      search.value = previous;
      renderSessions();
    } : undefined };
  },
}, showError);

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
  if (prompt.value.startsWith('/')) { await executeCommand(); return; }
  if (send.disabled || !prompt.value.trim()) return;
  const context = current;
  const reference = replies.get(context.id);
  const data = { text: prompt.value, attachments: [...context.selected], workbook: workbook.checked, replyTo: reference?.id };
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
    if (replies.get(context.id) === reference) replies.delete(context.id);
    if (current === context) renderReply();
    drafts.delete(context.id);
    if (!context.state?.runs.some((run) => run.id === id)) {
      context.pendingID = id;
      context.pendingAt = Date.now();
    }
    context.selected.clear();
    context.fileKey = undefined;
    if (current === context) {
      prompt.value = '';
      updateProgress();
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
async function stopTurn() {
  const context = current;
  const id = runningID(context);
  if (!id || context.cancelling) throw new Error('目前沒有可停止的回合。');
  context.cancelling = true;
  setControls();
  try {
    const run = await request(`${context.path}/cancel-turn`, { data: { id } });
    if (current === context && context.state) {
      context.state.runs = [...context.state.runs.filter((prior) => prior.id !== id), run];
      render(context);
      prompt.focus();
    }
  } finally {
    context.cancelling = false;
    setControls();
    refresh(context);
  }
}
cancelTurn.addEventListener('click', () => void stopTurn().catch(showError));
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyS' && !cancelTurn.hidden && !find('chat-view').hidden) {
    event.preventDefault();
    cancelTurn.click();
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
    knowledge?.disable();
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
  request('/api/settings/limits').then(applyLimits).catch(() => { limitsStatus.textContent = '無法載入回合限制。'; });
  request('/api/settings/model').then(applyModel).catch(() => { modelStatus.textContent = '無法載入模型設定。'; });
  request('/api/settings/projects').then((entries) => {
    projectFolders = entries;
    folderProject.replaceChildren(...entries.map(({ title, id }) => new Option(title, id)));
    folderProject.value = project;
    displayProjectFolders();
    updateProjectRead();
  }).catch(() => { folderStatus.textContent = '無法載入專案資料夾。'; });
  request('/api/settings/about').then(({ version, license, pin, root }) => {
    const details = find('about-details');
    for (const [term, value] of [['OEP 版本', version], ['資料目錄', root], ['OpenCode 固定版本', pin], ['授權', license]]) {
      details.append(node('dt', term), node('dd', value));
    }
    const repository = 'https://github.com/dragon0816/OpenCode-Engineer-Platform';
    for (const [label, path] of [['使用說明', '/blob/main/README.md'], ['工作台文件', '/blob/main/docs/GUI_LAYOUT.md']]) {
      const link = node('a', label);
      link.href = repository + path;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(node('dt', label));
      const description = node('dd');
      description.append(link);
      details.append(description);
    }
  }).catch(() => { find('about-status').textContent = '無法載入版本資訊。'; });
  request('/api/settings/runtime').then((runtime) => {
    const configured = (value) => value ? '已設定' : '未設定';
    find('runtime-status').textContent = runtime.compatible ? '固定版本已通過啟動檢查。' : '執行版本與固定版本不相符。';
    const details = find('runtime-details');
    for (const [name, value] of [
      ['OpenCode 固定版本', runtime.pin], ['執行版本', runtime.version], ['提交雜湊', runtime.commit],
      ['介面雜湊', runtime.openapi], ['Windows 執行檔雜湊', runtime.binary], ['用戶端雜湊', runtime.client],
      ['階段 3 知識庫', configured(runtime.knowledgeConfigured)], ['階段 4 Telegram', configured(runtime.telegramConfigured)],
    ]) {
      const detail = node('dd');
      if (name.startsWith('階段')) detail.append(node('span', value, 'runtime-badge'));
      else detail.textContent = value;
      details.append(node('dt', name), detail);
    }
  }).catch(() => { find('runtime-status').textContent = '無法載入執行環境。'; });
  request('/api/settings/appearance').then((appearance) => {
    applyAppearance(appearance);
    appearanceSave.disabled = stopped;
  }).catch(() => { appearanceStatus.textContent = '無法載入外觀設定。'; });
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
  if (bootstrap.knowledge) {
    knowledge = bindKnowledge();
    find('open-review').hidden = false;
  }
  find('open-chat').addEventListener('click', () => {
    find('jobs-view').hidden = true;
    find('chat-view').hidden = find('chat-files').hidden = false;
  });
  for (const id of ['open-chat', 'open-knowledge', 'open-jobs']) find(id).addEventListener('click', syncNavigation);
} catch (error) {
  connection.textContent = '尚未連線';
  showError(error instanceof RequestError && error.status === 401 ? '請雙擊 Windows 啟動器開啟 OEP。' : error);
}
