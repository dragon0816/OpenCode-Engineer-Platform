import { bindFilePicker, formatDate, formatNumber, getLocale, initializeLocale, joinText, LocalizedError, message, optionText, resolveText, setAttribute, setLocale, setText, t } from './i18n.js';
import { connect, errorText, modelLabel, projectLabel, request, RequestError, serverText } from './api.js';
import { bindVoice } from './voice.js';
import { bindNotes, messageActions } from './message-operations.js';
import { bindCommands } from './commands.js';
import { bindKnowledge } from './knowledge.js';
import { bindMcpSettings } from './mcp-settings.js';
import { bindJobs, loadJobSummary } from './jobs.js';

initializeLocale();

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
const labels = { inspector: message('ui.data-analysis'), workbook: message('ui.excel-worksheets') };
const statuses = {
  accepted: message('chat.accepted-and-queued'), running: message('chat.assistant-is-working'), awaiting_permission: message('chat.checking-tool-permissions'),
  background: message('chat.creating-and-verifying-the-workbook'), indeterminate: message('chat.checking-the-outcome'), failed: message('chat.this-turn-could-not-finish'), verified: message('chat.completed'), cancelled: message('chat.this-turn-was-stopped'),
};
const eventLabels = {
  working: message('chat.started-processing'), responding: message('chat.model-started-replying'), 'tool-started': message('chat.preparing-to-use-a-tool'), 'tool-running': message('chat.tool-running'),
  'tool-completed': message('chat.tool-completed'), 'tool-failed': message('chat.tool-could-not-finish'), recovering: message('chat.model-is-retrying'),
  permission: message('chat.checking-tool-permissions'), finished: message('chat.processing-completed'), failed: message('chat.processing-failed'), interrupted: message('chat.processing-stopped'),
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
  setText(find('reply-chip-text'), reply ? message('chat.reply-text', { text: reply.text.slice(0, 120) }) : '');
}
find('clear-reply').addEventListener('click', () => {
  replies.delete(current?.id);
  renderReply();
  prompt.focus();
});
const renderNotes = bindNotes(find('notes-filter'), find('session-notes'), find('export-notes'), (id) => {
  const message = messages.querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!message) return;
  if (panelNarrow.matches) closePanel(false);
  message.focus();
  message.scrollIntoView({ block: 'center' });
});
let current;
let uploadBusy = false;
let sending = false;
let stopped = false;
let knowledge;
const voice = bindVoice(find('enable-microphone'), find('microphone'), find('microphone-settings-status'), prompt, () => current, showError);

const limitErrors = {
  'turn-time-limit': message('chat.the-turn-reached-its-time-limit-shorten'),
  'turn-tool-limit': message('chat.the-turn-reached-its-tool-call-limit'),
};

function showError(error) {
  setText(notice, error ? errorText(error) : '');
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
  find('session-alias').disabled = !current || !modelSettings || Boolean(current.aliasUpdating) || stopped;
  voice.update();
  find('project-read').hidden = !current || !find('project-read-folder').options.length || stopped;
  find('project-read-button').disabled = uploadBusy;
  send.disabled = !current || uploadBusy || sending || stopped || Boolean(current.pendingID || current.aliasUpdating) ||
    activeStates.has(current.state?.runs.at(-1)?.state);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) setText(element, text);
  if (className) element.className = className;
  return element;
}

function emptyList(element, text) {
  element.replaceChildren(node('li', text, 'empty'));
}

const relativeTime = (timestamp) => () => formatRelativeTime(timestamp);
function formatRelativeTime(timestamp) {
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
  if (!sameDay) {
    const day = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return relative.format((day(new Date(timestamp)) - day(new Date())) / 86400000, 'day');
  }
  if (minutes < 1) return t('chat.just-now');
  if (minutes < 60) return relative.format(-minutes, 'minute');
  return relative.format(-Math.floor(minutes / 60), 'hour');
}

function sessionLabel(session) {
  return session.title || joinText([labels[session.agent], relativeTime(session.createdAt)]);
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
    if (document.activeElement === trigger) actions[0].focus();
  });
  for (const action of actions) action.addEventListener('click', close);
  menu.addEventListener('keydown', (event) => {
    if (!menu.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      actions[document.activeElement === actions[0] ? 1 : 0].focus();
    }
  });
  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget)) menu.open = false;
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
      const copy = sessionButton(message('chat.copy-code'), async () => {
        try { await navigator.clipboard.writeText(value); setText(copy, message('chat.copied')); }
        catch { setText(copy, message('chat.could-not-copy')); }
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
  const status = { running: message('chat.running'), done: message('chat.done'), failed: message('chat.failed'), cancelled: message('chat.stopped') }[tool.status];
  card.dataset.status = tool.status;
  setText(card.firstElementChild, message('chat.advanced-tool-status-status-seconds-s', { status, seconds: (duration / 1000).toFixed(1) }));
  const fields = card.lastElementChild;
  const signature = JSON.stringify([tool.name, tool.input, tool.output]);
  if (fields.dataset.signature === signature) return card;
  fields.dataset.signature = signature;
  fields.replaceChildren(node('p', message('chat.tool-name-name', { name: tool.name })));
  for (const [label, value] of [[message('ui.input'), tool.input], [message('chat.output'), tool.output]]) {
    fields.append(node('strong', label));
    const excerpt = node('pre', value ? value.slice(0, 800) : '—');
    fields.append(excerpt);
    if (value.length > 800) {
      const toggle = sessionButton(message('chat.show-all'), () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        setText(toggle, expanded ? message('chat.show-all') : message('chat.collapse'));
        setText(excerpt, expanded ? value.slice(0, 800) : value);
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
          card.append(node('summary', eventLabels[event.kind]), node('time', formatDate(event.createdAt)));
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
      const role = node('strong', item.role === 'user' ? message('chat.you') : labels[state.session.agent]);
      if (item.createdAt) setAttribute(role, 'title', formatDate(item.createdAt));
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
      }, showError, (text) => { setText(find('command-toast'), text); },
      () => { if (current === context) renderNotes(context); },
      (trigger) => openSection('notes', trigger)));
      fragment.append(entry);
    }
    appendEvents(Infinity);
    messages.replaceChildren(fragment);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (!state.messages.length) messages.append(node('p', message('chat.attach-files-or-enter-a-message-to'), 'empty'));
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
  const detail = state.stateErrorDetail ?? latest?.errorDetail;
  if (detail) showError(limitErrors[detail.code] ?? serverText(detail));
  else if (state.stateError || latest?.error) showError(state.stateError || latest.error);
  else if (!context.requestError) showError();
  renderPanel(context);
  renderNotes(context);
  setControls();
}

function renderPanel(context) {
  const { state, selected, path } = context;
  find('panel-tools').hidden = !state.session.tools?.includes('oep_knowledge_ask');
  updateAttachmentCount();
  const fileKey = JSON.stringify([state.attachments, state.runs, [...selected]]);
  if (context.fileKey === fileKey) return;
  context.fileKey = fileKey;
  const resources = find('chat-resources');
  const previousButtons = new Map([...resources.children].map((button) => [button.dataset.file, button]));
  const resourceButtons = [];
  function addResource(file, url) {
    const button = previousButtons.get(url)
      ?? action(file.name, () => void openPreview(file, url, context, button));
    button.dataset.file = url;
    setAttribute(button, 'aria-label', message('chat.preview-name', { name: file.name }));
    resourceButtons.push(button);
  }
  attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(attachment.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(attachment.id);
      else selected.delete(attachment.id);
      updateAttachmentCount();
    });
    const label = node('label');
    label.append(checkbox, node('span', attachment.name));
    const entry = node('li');
    entry.append(label);
    if (attachment.converted) entry.append(node('small', message('chat.converted-to-csv-with-worksheet-names-and')));
    const url = `${path}/attachments/${attachment.id}`;
    addFileDetails(entry, attachment, url, context, true);
    addResource(attachment, url);
    attachmentList.append(entry);
  }
  artifactList.replaceChildren();
  for (const run of state.runs.filter((run) => run.artifact).reverse()) {
    const entry = node('li');
    const artifact = { ...run.artifact, createdAt: run.finishedAt ?? run.createdAt };
    const url = `${path}/artifacts/${run.id}`;
    addFileDetails(entry, artifact, url, context);
    addResource(artifact, url);
    artifactList.append(entry);
  }
  if (!artifactList.children.length) emptyList(artifactList, message('ui.no-downloadable-files-yet'));
  const focused = document.activeElement;
  resources.replaceChildren(...resourceButtons);
  resources.hidden = resourceButtons.length === 0;
  if (resourceButtons.includes(focused)) focused.focus({ preventScroll: true });
  const ledger = find('panel-runs');
  ledger.replaceChildren(...state.runs.toReversed().map((run) =>
    node('li', joinText([formatDate(run.createdAt), statuses[run.state] ?? message('chat.unknown-status')]))));
  if (!ledger.children.length) emptyList(ledger, message('chat.no-job-history-for-this-session'));
  renderDiffChoices(context);
}

function updateAttachmentCount() {
  const button = find('manage-attachments');
  button.hidden = !current?.state?.attachments.length;
  setText(button, message('chat.selected-attachments-count', { count: current?.selected.size ?? 0 }));
}

function action(text, handler) {
  const button = node('button', text);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function formatFileSize(bytes) {
  const number = formatNumber(bytes);
  const withUnit = formatNumber(bytes, { style: 'unit', unit: 'byte', unitDisplay: 'long' });
  return message('chat.byte-count', { count: () => getLocale() === 'zh-TW' ? number() : withUnit() });
}

function fileType(file) {
  return file.name.includes('.') ? file.name.split('.').at(-1).toUpperCase() : file.mime;
}

function addFileDetails(entry, file, url, context, attachment = false) {
  const download = node('a', attachment ? message('chat.download') : file.name);
  download.href = url;
  download.download = file.name;
  const actions = node('div', undefined, 'file-actions');
  const hash = action(file.sha256.slice(0, 12), async () => {
    try {
      await navigator.clipboard.writeText(file.sha256);
      setText(find('file-status'), message('chat.file-checksum-copied'));
    } catch { setText(find('file-status'), message('chat.could-not-copy-the-file-checksum-try')); }
  });
  setAttribute(hash, 'aria-label', message('chat.copy-sha-256-for-name', { name: file.name }));
  setAttribute(hash, 'title', file.sha256);
  if (!attachment) entry.append(download);
  entry.append(node('small', message('chat.size-type-date', { size: formatFileSize(file.bytes), type: fileType(file), date: formatDate(file.createdAt) })));
  const open = action(message('chat.preview'), () => void openPreview(file, url, context, open));
  setAttribute(open, 'aria-label', message('chat.preview-name', { name: file.name }));
  actions.append(open);
  if (attachment) actions.append(download, action(message('chat.remove'), async () => {
    if (!confirm(t('chat.remove-name', { name: file.name }))) return;
    try {
      await request(url, { data: {}, signal: context.abort.signal });
      if (current !== context) return;
      context.selected.delete(file.id);
      if (panelTabs.has(url)) closeTab(url);
      refresh(context);
    } catch (error) {
      if (current === context) showError(new LocalizedError(error.status === 409 ? message('chat.wait-for-this-turn-to-finish-before') : message('chat.could-not-remove-the-attachment-try-again')));
    }
  }));
  const advanced = node('details');
  advanced.append(node('summary', message('ui.advanced')), hash);
  entry.append(actions, advanced);
}

async function previewResponse(url, signal) {
  const response = await fetch(`${url}/preview`, { signal });
  if (!response.ok) throw new LocalizedError(message('chat.could-not-load-the-preview'));
  return response;
}

async function openPreview(file, url, context, opener) {
  if (panelTabs.has(url)) {
    showTab(url, opener);
    return;
  }
  const abort = new AbortController();
  let objectURL;
  const panel = node('div');
  find('file-preview').append(panel);
  const body = node('div', undefined, 'preview-body');
  const title = node('h2', file.name);
  const actions = node('div', undefined, 'file-actions');
  const download = node('a', message('chat.download'));
  download.href = url;
  download.download = file.name;
  if (file.mime !== 'application/pdf') {
    const browser = node('a', message('chat.open-in-browser'));
    browser.href = `${url}/preview`;
    browser.target = '_blank';
    browser.rel = 'noopener noreferrer';
    actions.append(browser);
  }
  actions.append(download);
  panel.append(title, node('small', message('chat.type-size-date', { type: fileType(file), size: formatFileSize(file.bytes), date: formatDate(file.createdAt) })), actions, body);
  addTab(url, file.name, panel, () => {
    abort.abort();
    if (objectURL) URL.revokeObjectURL(objectURL);
    panel.remove();
  });
  showTab(url, opener);
  if (file.mime === 'application/pdf') {
    setText(body, message('chat.pdf-preview-is-unavailable-download-the-file'));
    return;
  }
  setText(body, message('chat.loading-preview'));
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
      objectURL = URL.createObjectURL(data);
      image.src = objectURL;
      body.append(image);
    } else if (extension === 'html' || extension === 'htm') {
      const frame = node('iframe');
      setAttribute(frame, 'title', file.name);
      frame.setAttribute('sandbox', '');
      frame.inert = true;
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="light dark">${data}`;
      body.append(node('p', message('chat.the-preview-shows-file-content-only')), frame);
    } else if (extension === 'csv' || extension === 'xlsx') {
      renderSheets(body, readSheets(data, extension === 'xlsx'));
    } else if (extension === 'md') appendMarkdown(body, data);
    else body.append(node('pre', data));
  } catch {
    if (!abort.signal.aborted && current === context) setText(body, message('chat.could-not-preview-this-file-download-it'));
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
  setAttribute(select, 'aria-label', message('chat.worksheet'));
  select.hidden = sheets.size === 1 && (lines || sheets.has('CSV')) && before.size <= 1;
  for (const name of new Set([...sheets.keys(), ...before.keys()])) {
    const option = optionText(lines ? message('chat.text') : name, name);
    option.toggleAttribute('data-ui-content', !lines);
    select.append(option);
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
    setAttribute(scroller, 'aria-label', lines ? message('chat.text-change-comparison') : message('chat.table-contents'));
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
    const more = action(message('chat.show-more'), appendRows);
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
            td.append(node('del', old || message('chat.blank')), node('ins', next || message('chat.blank')));
          } else setText(td, next);
        }
      }
      more.hidden = index >= length;
    }
    content.replaceChildren();
    if (diff) content.append(node('p', lines ? message('chat.changed-rows-count', { count: changes }) : message('chat.changed-cells-on-this-worksheet-count', { count: changes })));
    if (rows.some((row) => row.length > 100)) content.append(node('p', message('chat.the-preview-shows-the-first-100-columns')));
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
    target.append(node('p', message('chat.this-session-has-no-file-versions-to')));
    return;
  }
  const choice = node('select');
  setAttribute(choice, 'aria-label', message('chat.file-versions'));
  for (const [index, [, run]] of pairs.entries()) {
    choice.append(optionText(message('chat.name-version-version', { name: run.artifact.name, version: pairs.length - index + 1 }), String(index)));
  }
  const body = node('div', undefined, 'preview-body');
  let controller;
  async function compare() {
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    const [prior, run] = pairs[Number(choice.value)];
    setText(body, message('chat.comparing-versions'));
    try {
      const signal = AbortSignal.any([abort.signal, context.abort.signal]);
      const [before, after] = await Promise.all([prior, run].map(async ({ id }) =>
        (await previewResponse(`${context.path}/artifacts/${id}`, signal)).text()));
      if (signal.aborted || !body.isConnected) return;
      body.replaceChildren(node('small', message('chat.before-date', { date: formatDate(prior.createdAt) })),
        node('small', message('chat.after-date', { date: formatDate(run.createdAt) })));
      if (/\.xlsx$/i.test(run.artifact.name)) renderSheets(body, readSheets(after, true), readSheets(before, true));
      else renderSheets(body, new Map([['text', after.split(/\r?\n/).map((line) => [line])]]),
        new Map([['text', before.split(/\r?\n/).map((line) => [line])]]), true);
    } catch {
      if (!abort.signal.aborted) setText(body, message('chat.could-not-compare-these-versions-select-the'));
    }
  }
  target.append(choice, action(message('chat.compare-versions'), () => void compare()), body);
}

function updateProgress() {
  if (!current || stopped) return;
  const latest = current.state?.runs.at(-1);
  const startedAt = current.pendingAt ?? (activeStates.has(latest?.state) ? latest.createdAt : undefined);
  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : undefined;
  const label = current.pendingAt || latest?.state === 'running' ? message('chat.generating-a-reply') : statuses[latest?.state];
  const text = elapsed === undefined ? (label ?? message('chat.waiting-for-a-message')) : message('chat.status-elapsed-seconds-s', { status: label, seconds: elapsed });
  if (progress.textContent !== resolveText(text)) setText(progress, text);
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
const topMenu = find('top-menu');
const menuTrigger = find('top-menu-trigger');
const menuLocale = find('menu-locale');
const localePickers = [menuLocale, find('settings-locale')];
let focusBeforeTopMenu;
topMenu.addEventListener('focusin', ({ relatedTarget }) => {
  if (relatedTarget && !topMenu.contains(relatedTarget)) focusBeforeTopMenu = relatedTarget;
});
for (const picker of localePickers) {
  picker.value = getLocale();
  picker.addEventListener('change', () => {
    setLocale(picker.value);
    for (const entry of localePickers) entry.value = getLocale();
    if (picker !== menuLocale) return;
    const restore = topMenu.contains(document.activeElement);
    topMenu.open = false;
    if (restore) (visibleOpener(focusBeforeTopMenu) || menuTrigger).focus({ preventScroll: true });
  });
}

const panelNarrow = matchMedia('(max-width: 900px)');
const panelTabs = new Map();
const panelSections = { files: message('ui.files'), work: message('ui.work'), diff: message('ui.change-comparison'), notes: message('ui.notes') };
const closeFiles = find('close-files');
let activeTab;
let panelOpener;
let nextPreview = 0;

function addTab(key, title, panel, dispose) {
  const item = node('div', undefined, 'panel-tab');
  item.setAttribute('role', 'presentation');
  const button = action(title, () => showTab(key));
  button.toggleAttribute('data-ui-content', typeof title === 'string');
  const id = panel.id ? panel.id.slice('panel-'.length) : `preview-${++nextPreview}`;
  button.id = `tab-${id}`;
  panel.id ||= `panel-${id}`;
  panel.tabIndex = 0;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', button.id);
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', panel.id);
  const close = action('×', () => closeTab(key));
  close.className = 'close-tab';
  setAttribute(close, 'aria-label', message('chat.close-title-tab', { title }));
  item.append(button, close);
  find('panel-tabs').append(item);
  panelTabs.set(key, { button, item, panel, dispose });
  button.addEventListener('keydown', (event) => {
    const keys = [...panelTabs.keys()];
    const index = keys.indexOf(key);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: keys.length - 1 }[event.key];
    if (event.key === 'Delete') {
      event.preventDefault();
      closeTab(key);
    } else if (target !== undefined) {
      event.preventDefault();
      showTab(keys[(target + keys.length) % keys.length]);
    }
  });
}

function updatePanelLayout() {
  const overlay = !rightPanel.hidden && panelNarrow.matches;
  document.querySelector('.navigation').inert = find('work-area').inert = overlay;
  rightPanel.setAttribute('role', overlay ? 'dialog' : 'complementary');
  if (overlay) rightPanel.setAttribute('aria-modal', 'true');
  else rightPanel.removeAttribute('aria-modal');
  setText(closeFiles, !panelNarrow.matches ? message('ui.close-details') : find('chat-view').hidden ? message('chat.back-to-page') : message('ui.back-to-chat'));
}

function showTab(key, opener) {
  const target = panelTabs.get(key);
  if (opener) {
    target.opener = opener;
    if (!rightPanel.contains(opener)) {
      panelOpener = opener;
      target.externalOpener = opener;
    } else target.externalOpener = panelTabs.get(activeTab)?.externalOpener ?? panelOpener;
  }
  activeTab = key;
  for (const [id, { button, panel }] of panelTabs) {
    const active = id === key;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  rightPanel.hidden = false;
  panelToggle.setAttribute('aria-expanded', 'true');
  updatePanelLayout();
  panelTabs.get(key).button.focus({ preventScroll: true });
  if (key === 'work') void loadJobSummary();
}

function openSection(key, opener) {
  if (!panelTabs.has(key)) addTab(key, panelSections[key], find(`panel-${key}`));
  showTab(key, opener);
}

function openFeaturePreview(key, title, opener) {
  if (panelTabs.has(key)) {
    showTab(key, opener);
    return panelTabs.get(key).preview;
  }
  const abort = new AbortController();
  const panel = node('div', undefined, 'knowledge feature-preview');
  const heading = node('h2', title);
  heading.toggleAttribute('data-ui-content', typeof title === 'string');
  const body = node('div', undefined, 'preview-body');
  panel.append(heading, body);
  find('file-preview').append(panel);
  addTab(key, title, panel, () => {
    abort.abort();
    panel.remove();
  });
  const tab = panelTabs.get(key);
  const preview = {
    body,
    signal: abort.signal,
    setTitle(value) {
      for (const element of [heading, tab.button]) {
        setText(element, value);
        element.toggleAttribute('data-ui-content', typeof value === 'string');
      }
      setAttribute(tab.item.querySelector('.close-tab'), 'aria-label', message('chat.close-title-tab', { title: value }));
    },
  };
  tab.preview = preview;
  showTab(key, opener);
  return preview;
}

function removeTab(key) {
  const { item, panel, dispose } = panelTabs.get(key);
  panel.hidden = true;
  item.remove();
  dispose?.();
  panelTabs.delete(key);
}

function visibleOpener(opener) {
  if (opener?.isConnected && opener.getClientRects().length && !opener.closest('[inert]') &&
      !opener.closest('details:not([open]) :not(summary, summary *)')) return opener;
  if (opener?.dataset.featureFocus) {
    const matches = document.querySelectorAll(`[data-feature-focus="${CSS.escape(opener.dataset.featureFocus)}"]`);
    return [...matches].find((item) => item.getClientRects().length && !item.closest('[hidden], [inert]') &&
      !item.closest('details:not([open]) :not(summary, summary *)'));
  }
}

function closeTab(key) {
  const keys = [...panelTabs.keys()];
  const index = keys.indexOf(key);
  if (keys.length === 1) {
    closePanel();
    return;
  }
  const { opener, preview } = panelTabs.get(key);
  removeTab(key);
  const parent = preview && opener && [...panelTabs].find(([, tab]) => tab.panel.contains(opener));
  showTab(activeTab === key ? parent?.[0] ?? keys[index + 1] ?? keys[index - 1] : activeTab);
  if (preview && parent?.[0] === activeTab) visibleOpener(opener)?.focus({ preventScroll: true });
}

function closePanel(restoreFocus = true) {
  const tab = panelTabs.get(activeTab);
  const opener = tab?.preview ? tab.externalOpener ?? panelOpener : panelOpener;
  for (const key of panelTabs.keys()) removeTab(key);
  rightPanel.hidden = true;
  panelToggle.setAttribute('aria-expanded', 'false');
  updatePanelLayout();
  if (restoreFocus) {
    const messageID = opener?.closest('[data-id]')?.dataset.id;
    const replacement = messageID && messages.querySelector(`[data-id="${CSS.escape(messageID)}"] .message-actions summary`);
    const page = tab?.preview && find('work-area').querySelector('.knowledge:not([hidden]) h1');
    const target = visibleOpener(opener) || replacement || page || menuTrigger;
    target.focus({ preventScroll: true });
  }
  panelOpener = undefined;
  activeTab = undefined;
}

for (const [key, id] of [['files', 'toggle-files'], ['work', 'open-work'], ['diff', 'open-diff'], ['notes', 'open-notes']]) {
  find(id).addEventListener('click', () => {
    topMenu.open = false;
    openSection(key, menuTrigger);
  });
}
find('manage-attachments').addEventListener('click', (event) => openSection('files', event.currentTarget));
document.addEventListener('click', (event) => {
  if (!topMenu.contains(event.target)) topMenu.open = false;
});
closeFiles.addEventListener('click', () => closePanel());
find('panel-jobs-link').addEventListener('click', () => closePanel(false), { capture: true });
panelNarrow.addEventListener('change', updatePanelLayout);
rightPanel.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !panelNarrow.matches) return;
  const candidates = rightPanel.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]');
  const stops = [...candidates].filter((element) => element.tabIndex >= 0 && !element.disabled && visibleOpener(element));
  const first = stops[0];
  const last = stops.at(-1);
  if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});
document.addEventListener('keydown', (event) => {
  const disclosure = event.target.closest?.('details:is(#top-menu, .feature-more, #shortcuts)[open]');
  if (event.key === 'Escape' && !event.defaultPrevented && disclosure) {
    event.preventDefault();
    disclosure.open = false;
    disclosure.querySelector('summary').focus();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.key !== 'Escape' || rightPanel.hidden || event.target.closest?.('dialog[open]')) return;
  event.preventDefault();
  closePanel();
});

function select(id) {
  voice.cancel();
  find('project-read').open = false;
  if (current) drafts.set(current.id, { text: prompt.value, workbook: workbook.checked });
  current?.events.close();
  current?.abort.abort();
  const session = knownSessions.get(id);
  current = undefined;
  updateAttachmentCount();
  find('file-status').textContent = '';
  renderNotes(null);
  renderReply();
  setText(find('runtime-agent'), session ? message('chat.session-assistant-assistant', { assistant: labels[session.agent] }) : message('chat.no-session-selected'));
  closePanel(false);
  find('chat-resources').replaceChildren();
  find('chat-resources').hidden = true;
  find('panel-runs').replaceChildren();
  find('panel-diff').replaceChildren();
  jump.hidden = true;
  if (!session) {
    updateSessionAlias();
    setText(sessionTitle, message('ui.chat'));
    progress.textContent = '';
    messages.replaceChildren();
    attachmentList.replaceChildren();
    emptyList(artifactList, message('ui.no-downloadable-files-yet'));
    emptyList(activityList, message('chat.no-jobs-in-progress'));
    uploadStatus.textContent = '';
    prompt.value = '';
    showError();
    setControls();
    renderSessions();
    return;
  }
  localStorage.setItem(`oep.activeSession.${project}`, id);
  setText(sessionTitle, sessionLabel(session));
  const draft = drafts.get(id);
  prompt.value = draft?.text ?? '';
  workbook.checked = draft?.workbook ?? false;
  find('workbook-option').hidden = session.agent !== 'workbook';
  messages.replaceChildren(node('p', message('chat.loading-session'), 'empty'));
  attachmentList.replaceChildren();
  emptyList(artifactList, message('ui.no-downloadable-files-yet'));
  emptyList(activityList, message('chat.no-jobs-in-progress'));
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
  renderSessions();
  events.onopen = () => {
    if (current !== context || stopped) return;
    setText(connection, message('chat.connected'));
    refresh(context);
  };
  events.onerror = () => {
    if (current !== context || stopped) return;
    setText(connection, message('chat.reconnecting'));
    refresh(context);
  };
  events.addEventListener('activity', (event) => {
    if (current !== context || stopped) return;
    const detail = JSON.parse(event.data);
    if (eventLabels[detail.kind]) {
      if (activityList.firstElementChild?.classList.contains('empty')) activityList.replaceChildren();
      activityList.prepend(node('li', joinText([eventLabels[detail.kind], detail.tool])));
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
  setText(find('session-count'), knownSessions.size);
  const query = find('session-search').value.trim().toLocaleLowerCase(getLocale());
  find('clear-session-search').hidden = !find('session-search').value;
  sessions.replaceChildren();
  for (const entry of projects) {
    const section = node('section', undefined, 'project');
    const heading = node('h2', '', 'project-heading');
    const expanded = entry.id === project && collapsedProject !== entry.id;
    const projectButton = sessionButton(projectLabel(entry), () => {
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
    setAttribute(create, 'aria-label', message('chat.new-session-in-project', { project: projectLabel(entry) }));
    heading.append(create);
    sessions.append(section);
    if (!expanded) continue;
    const list = node('ul', undefined, 'session-list');
    for (const session of knownSessions.values()) {
      const label = sessionLabel(session);
      if (!resolveText(label).toLocaleLowerCase(getLocale()).includes(query)) continue;
      const row = node('li');
      const link = sessionButton(undefined, () => {
        select(session.id);
        if (narrowNavigation.matches) setSidebar(false);
        prompt.focus();
      });
      setAttribute(link, 'title', label);
      const name = node('span', session.title || labels[session.agent], 'session-name');
      name.classList.toggle('session-name-default', !session.title);
      link.append(name, node('time', relativeTime(session.createdAt)));
      link.dataset.session = session.id;
      if (current?.id === session.id) link.dataset.phase = current.phase ?? '';
      if (current?.id === session.id) link.setAttribute('aria-current', 'true');
      const menu = node('details');
      const summary = node('summary', '⋯', 'menu-trigger');
      setAttribute(summary, 'aria-label', message('chat.more-options-for-session', { session: label }));
      setAttribute(summary, 'title', message('ui.more'));
      const rename = sessionButton(message('chat.rename'), () => renameSession(session));
      const remove = sessionButton(message('chat.delete'), () => removeSession(session, summary));
      remove.classList.add('button-danger');
      rename.dataset.action = 'rename';
      remove.dataset.action = 'remove';
      const actions = node('div', undefined, 'menu-actions');
      actions.append(rename, remove);
      menu.append(summary, actions);
      bindRowMenu(menu, summary, [rename, remove]);
      row.append(link, menu);
      list.append(row);
    }
    section.append(list);
    if (!list.children.length) section.append(node('p', query ? message('chat.no-matching-sessions') : message('chat.no-sessions-yet')));
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
    if (file.size > 20 * 1024 * 1024) { failures.push(message('chat.name-this-file-exceeds-20-mb-choose', { name: file.name })); continue; }
    setText(uploadStatus, message('chat.uploading-name', { name: file.name }));
    try {
      const result = await request(`${context.path}/attachments`, { file });
      context.selected.add(result.id);
      succeeded++;
    } catch (error) { failures.push(joinText([file.name, errorText(error)])); }
  }
  if (current === context && !stopped) {
    setText(uploadStatus, succeeded ? message('chat.upload-complete-files-count-select-the-files', { count: succeeded }) : '');
    if (failures.length) { context.requestError = true; showError(joinText(failures, '\n')); }
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
  find('project-read-folder').replaceChildren(...folders.map((path) => optionText(path, path)));
  setControls();
}
function displayProjectFolders() {
  const active = projectFolders.find((entry) => entry.id === folderProject.value);
  if (!active) return;
  setText(find('project-working-root'), message('chat.working-folder-path', { path: active.workingRoot }));
  find('project-folder-list').replaceChildren(...active.folders.map((folder) => {
    const row = node('li');
    row.append(node('span', folder));
    row.append(' ', sessionButton(message('chat.remove'), () => void changeProjectFolder('remove', folder)));
    return row;
  }));
}
async function changeProjectFolder(action, folder) {
  try {
    projectFolders = await request('/api/settings/projects', { data: { action, folder, project: folderProject.value } });
    setText(folderStatus, action === 'add' ? message('chat.read-only-folder-added') : message('chat.read-only-folder-removed'));
    if (action === 'add') folderForm.reset();
    displayProjectFolders();
    updateProjectRead();
  } catch (error) { setText(folderStatus, errorText(error)); }
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
      setText(uploadStatus, message('chat.attached-a-file-copy'));
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
  setText(find('sidebar-assistant-name'), preferences.name || message('ui.assistant'));
  const introduction = find('sidebar-assistant-intro');
  introduction.toggleAttribute('data-ui-content', Boolean(preferences.introduction));
  const intro = preferences.introduction || message('ui.local-engineering-assistant');
  setText(introduction, intro);
  setAttribute(introduction, 'title', intro);
}
find('assistant-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = find('save-assistant');
  if (button.disabled) return;
  const data = assistantValues();
  const controls = [...event.currentTarget.elements];
  controls.forEach((control) => { control.disabled = true; });
  settingsSaving = true;
  setText(find('settings-status'), message('chat.saving'));
  try {
    applyPreferences(await request('/api/settings', { data }));
    setText(find('settings-status'), message('chat.saved'));
  } catch {
    setText(find('settings-status'), message('chat.could-not-save-assistant-settings-try-again'));
  } finally {
    settingsSaving = false;
    controls.forEach((control) => { control.disabled = stopped; });
  }
});

const theme = find('theme');
const density = find('density');
const avatarFile = find('avatar-file');
const refreshAvatarPicker = bindFilePicker(avatarFile);
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
  refreshAvatarPicker();
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
  refreshAvatarPicker();
  setText(appearanceStatus, message('chat.saving-will-restore-the-default-avatar'));
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
  setText(appearanceStatus, message('chat.saving'));
  try {
    const data = { theme: theme.value, density: density.value };
    if (avatarFile.files.length) data.avatar = await encodeAvatar(avatarFile.files[0]);
    else if (avatarReset) data.avatar = null;
    applyAppearance(await request('/api/settings/appearance', { data }));
    localStorage.removeItem('oep.theme');
    setText(appearanceStatus, message('chat.saved'));
  } catch {
    setText(appearanceStatus, message('chat.could-not-save-the-appearance-settings-check'));
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
function aliasOptions(select, selected, aliases, configuredDefault) {
  select.replaceChildren(...aliases.map(({ alias }) => {
    const label = modelLabel(alias);
    const option = node('option', alias === configuredDefault ? message('chat.default-in-settings-model', { model: label }) : label);
    option.value = alias;
    return option;
  }));
  select.value = selected ?? '';
}
function updateSessionAlias() {
  const session = current && knownSessions.get(current.id);
  aliasOptions(sessionAlias, session?.alias, modelSettings?.aliases ?? [], modelSettings?.defaultAlias);
  sessionAlias.disabled = !session || !modelSettings || Boolean(current.aliasUpdating) || stopped;
  if (modelSettings) setText(model, modelLabel(session?.alias ?? modelSettings.defaultAlias));
}
function applyModel(value, draft = value.defaultAlias) {
  modelSettings = value;
  aliasOptions(defaultAlias, draft, value.aliases);
  setText(find('model-credentials'), value.credentialsConfigured ? message('chat.credentials-configured') : message('chat.credentials-missing'));
  find('model-health').replaceChildren(...value.aliases.map(({ alias, healthy }) =>
    node('li', joinText([modelLabel(alias), healthy ? message('chat.available') : message('chat.check-failed')]))));
  updateSessionAlias();
  for (const id of ['default-alias', 'recheck-model', 'save-model']) find(id).disabled = stopped;
}
async function updateModel(recheck) {
  const draft = defaultAlias.value;
  if (!recheck) settingsSaving = true;
  setText(modelStatus, recheck ? message('chat.checking') : message('chat.saving'));
  for (const id of ['default-alias', 'recheck-model', 'save-model']) find(id).disabled = true;
  try {
    const path = '/api/settings/model' + (recheck ? '/recheck' : '');
    const value = await request(path, { data: recheck ? {} : { alias: draft } });
    applyModel(value, recheck ? defaultAlias.value : undefined);
    setText(modelStatus, recheck ? message('chat.recheck-complete') : message('chat.saved'));
  } catch (error) {
    setText(modelStatus, error.status === 429 ? message('chat.wait-30-seconds-before-checking-again') : message('chat.could-not-update-model-settings-try-again'));
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
  context.aliasUpdating = true;
  setControls();
  try {
    const session = await request(`${context.path}/model`, { data: { alias: sessionAlias.value } });
    knownSessions.set(session.id, session);
    if (current === context) setText(status, message('chat.model-switched'));
  } catch (error) {
    if (current === context) setText(status, error.status === 409 ? message('chat.wait-for-this-turn-to-finish') : message('chat.could-not-switch-models-try-again'));
  } finally {
    context.aliasUpdating = false;
    if (current === context) {
      updateSessionAlias();
      setControls();
    }
  }
});
function modelDirty() {
  return modelSettings && defaultAlias.value !== modelSettings.defaultAlias;
}
const limitLabels = {
  recentMessages: message('chat.recent-messages'), historyBytes: message('chat.history-size-limit'),
  toolCalls: message('chat.tool-call-limit'), timeoutSeconds: message('chat.turn-timeout-seconds'),
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
      const help = node('small', message('chat.range-min-max-default-initial', { min: field.min, max: field.max, initial: field.initial }));
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
  setText(limitsStatus, message('chat.saving'));
  const data = Object.fromEntries([...limitInputs].map(([key, input]) => [key, input.valueAsNumber]));
  for (const input of limitInputs.values()) input.disabled = true;
  try {
    applyLimits(await request('/api/settings/limits', { data }));
    setText(limitsStatus, message('chat.saved'));
  } catch {
    setText(limitsStatus, message('chat.could-not-save-the-turn-limits-check'));
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
  if (!window.confirm(t('chat.discard-unsaved-settings'))) return false;
  if (assistantDirty()) applyPreferences(JSON.parse(savedAssistant));
  if (appearanceDirty()) applyAppearance(savedAppearance);
  if (modelDirty()) applyModel(modelSettings);
  if (limitsDirty()) for (const [key, input] of limitInputs) input.value = savedLimits[key];
  [find('settings-status'), appearanceStatus, modelStatus, limitsStatus].forEach(element => setText(element, ''));
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
  catch { setText(knowledgeSettingsStatus, message('chat.could-not-load-knowledge-base-settings-refresh')); }
}
const configuredLabel = (configured) => configured ? message('chat.configured') : message('chat.unconfigured');
async function loadTelegramStatus() {
  const mainStatus = find('telegram-main-status');
  const biStatus = find('telegram-bi-status');
  [mainStatus, biStatus].forEach(element => setText(element, message('ui.loading')));
  try {
    const { main, bi } = await request('/api/jobs');
    setText(mainStatus, configuredLabel(main));
    setText(biStatus, configuredLabel(bi));
  } catch { [mainStatus, biStatus].forEach(element => setText(element, message('chat.could-not-load-refresh-the-page'))); }
}
knowledgeSettings.addEventListener('submit', async (event) => {
  event.preventDefault();
  setText(knowledgeSettingsStatus, message('chat.saving'));
  try {
    applyKnowledgeSettings(await request('/api/settings/knowledge', {
      data: { atlasUrl: atlasInput.value, toolbox: find('knowledge-toolbox').checked },
    }));
    setText(knowledgeSettingsStatus, message('chat.saved-2'));
  } catch (error) { setText(knowledgeSettingsStatus, errorText(error)); }
});
atlasButton.addEventListener('click', () => {
  if (savedAtlas && window.confirm(t('chat.open-atlas-in-a-new-tab'))) {
    window.open(savedAtlas, '_blank', 'noopener,noreferrer');
  }
});

const settingsView = find('settings-view');
const settingsEntry = find('open-settings');
const settingsSections = [...find('settings-nav').querySelectorAll('button')];
const settingsSectionPicker = find('settings-section');
const settingsSectionKey = 'oep.settings.section';
const savedSection = localStorage.getItem(settingsSectionKey);
let activeSettingsSection = settingsSections.some((entry) => entry.dataset.section === savedSection) ? savedSection : 'assistant';
settingsSectionPicker.replaceChildren(...settingsSections.map((entry) => optionText(message(entry.dataset.i18n), entry.dataset.section)));

function renderSettingsSection() {
  for (const [index, entry] of settingsSections.entries()) {
    const active = entry.dataset.section === activeSettingsSection;
    if (active) {
      entry.setAttribute('aria-current', 'page');
      settingsSectionPicker.options[index].setAttribute('aria-current', 'page');
    } else {
      entry.removeAttribute('aria-current');
      settingsSectionPicker.options[index].removeAttribute('aria-current');
    }
    find(entry.getAttribute('aria-controls')).hidden = !active;
  }
  settingsSectionPicker.value = activeSettingsSection;
}
renderSettingsSection();

const loadCustomMcp = bindMcpSettings(() => projects);

async function loadMcpSettings() {
  void loadCustomMcp();
  const status = find('mcp-knowledge-status');
  setText(status, message('chat.checking-connection'));
  find('mcp-knowledge-tools').hidden = true;
  try {
    const [server] = await request('/api/settings/mcp');
    setText(status, {
      connected: message('chat.connected'), disabled: message('chat.disabled'), failed: message('chat.could-not-connect-to-the-built-in'),
      needs_auth: message('chat.credentials-required'), pending: message('chat.awaiting-connection'), unconfigured: message('chat.no-knowledge-base-configured'),
    }[server.status]);
    find('mcp-knowledge-tools').hidden = !server.tools.length;
  } catch { setText(status, message('chat.could-not-check-the-connection-refresh-the')); }
}

function loadActiveSettingsSection() {
  if (activeSettingsSection === 'mcp') void loadMcpSettings();
  if (activeSettingsSection === 'integrations') void loadTelegramStatus();
}

function switchSettingsSection(section) {
  if (section === activeSettingsSection) return true;
  if (!discardSettings()) return false;
  activeSettingsSection = section;
  localStorage.setItem(settingsSectionKey, section);
  renderSettingsSection();
  loadActiveSettingsSection();
  return true;
}

find('mcp-open-knowledge-settings').addEventListener('click', () => {
  if (switchSettingsSection('integrations')) find('knowledge-toolbox').focus();
});

function showSettings() {
  closePanel(false);
  for (const id of ['chat-view', 'knowledge-view', 'jobs-view', 'review-view']) find(id).hidden = true;
  for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) find(id).removeAttribute('aria-current');
  settingsView.hidden = false;
  void loadKnowledgeSettings();
  loadActiveSettingsSection();
  settingsEntry.setAttribute('aria-current', 'page');
  if (narrowNavigation.matches) setSidebar(false);
  find('settings-title').focus();
}

settingsEntry.addEventListener('click', showSettings);
find('close-settings').addEventListener('click', () => {
  find('open-chat').click();
  if (settingsView.hidden && narrowNavigation.matches) sidebarToggle.focus();
});
for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) {
  find(id).addEventListener('click', (event) => {
    if (settingsView.hidden) return;
    if (!discardSettings()) {
      event.stopImmediatePropagation();
      return;
    }
    settingsView.hidden = true;
    settingsEntry.removeAttribute('aria-current');
    if (id === 'open-chat') {
      find('chat-view').hidden = false;
      find(id).setAttribute('aria-current', 'page');
    }
  }, { capture: true });
}
for (const button of settingsSections) {
  button.addEventListener('click', () => switchSettingsSection(button.dataset.section));
}
settingsSectionPicker.addEventListener('change', () => {
  if (!switchSettingsSection(settingsSectionPicker.value)) settingsSectionPicker.value = activeSettingsSection;
});
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.key !== ',') return;
  event.preventDefault();
  showSettings();
});

const narrowNavigation = matchMedia('(max-width: 800px)');
const sidebarToggle = find('toggle-sidebar');
function setSidebar(open) {
  find('session-sidebar').hidden = !open;
  sidebarToggle.setAttribute('aria-expanded', String(open));
}
setSidebar(!narrowNavigation.matches);
narrowNavigation.addEventListener('change', () => setSidebar(!narrowNavigation.matches));
sidebarToggle.addEventListener('click', () => setSidebar(find('session-sidebar').hidden));
sidebarToggle.closest('.navigation').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || !narrowNavigation.matches || find('session-sidebar').hidden) return;
  event.preventDefault();
  setSidebar(false);
  sidebarToggle.focus();
});
for (const section of document.querySelectorAll('.rail-section')) {
  const key = `oep.${section.id}.open`;
  section.open = localStorage.getItem(key) !== 'false';
  section.addEventListener('toggle', () => localStorage.setItem(key, String(section.open)));
}
setText(find('assistant-count'), agent.options.length);
function syncNavigation() {
  const view = ['chat', 'jobs', 'knowledge', 'review'].find((id) => !find(id + '-view').hidden);
  const visible = 'open-' + view;
  if (visible !== 'open-chat' || panelTabs.get(activeTab)?.preview) closePanel(false);
  for (const entry of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) {
    if (entry === visible) find(entry).setAttribute('aria-current', 'page');
    else find(entry).removeAttribute('aria-current');
  }
  if (narrowNavigation.matches) {
    setSidebar(false);
    if (visible === 'open-chat') sessionTitle.focus();
  }
}
for (const id of ['open-chat', 'open-knowledge', 'open-jobs']) {
  find(id).addEventListener('click', () => { find('review-view').hidden = true; });
}
find('open-review').addEventListener('click', () => {
  for (const id of ['knowledge-view', 'jobs-view', 'chat-view']) find(id).hidden = true;
  find('review-view').hidden = false;
  find('review-title').focus();
  void knowledge?.refreshReviews();
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
  const title = window.prompt(t('chat.enter-a-session-name'), resolveText(sessionLabel(session)));
  if (title === null) return;
  try {
    const renamed = await request(`${sessionPath(session.id)}/rename`, { data: { title } });
    if (project !== session.project) return;
    addSession(renamed);
    renderSessions();
    if (current?.id === session.id) setText(sessionTitle, sessionLabel(renamed));
    sessions.querySelector(`[data-session="${session.id}"]`)?.focus();
  } catch (error) { showError(error); }
}

async function removeSession(session, opener) {
  const card = find('remove-session-card');
  const path = sessionPath(session.id);
  setText(find('remove-session-question'), message('chat.delete-session', { session: sessionLabel(session) }));
  card.returnValue = 'reject';
  const decision = await new Promise((resolve) => {
    card.addEventListener('close', () => resolve(card.returnValue), { once: true });
    card.showModal();
  });
  opener.focus({ preventScroll: true });
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
    setText(find('command-toast'), message('chat.session-deleted'));
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
    if (created && created.id !== previous) return { text: message('chat.session-created') };
  },
  async '/stop'() {
    await stopTurn();
    return { text: message('chat.stop-requested') };
  },
  async '/model'(alias) {
    const context = current;
    if (!modelSettings?.aliases.some((entry) => entry.alias === alias)) throw new LocalizedError(message('chat.enter-an-approved-model-name'));
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
      text: message('chat.model-switched-2'),
      undo: previous && previous !== alias ? () => change(previous) : undefined,
    };
  },
  async '/theme'(value) {
    if (!['light', 'dark'].includes(value)) throw new LocalizedError(message('chat.enter-light-or-dark'));
    const previous = savedAppearance.theme;
    async function change(next) {
      applyAppearance(await request('/api/settings/appearance', { data: { theme: next, density: savedAppearance.density } }));
      localStorage.removeItem('oep.theme');
    }
    await change(value);
    return { text: message('chat.theme-switched'), undo: previous !== value ? () => change(previous) : undefined };
  },
  '/attach'() {
    if (pick.disabled) throw new LocalizedError(message('chat.could-not-select-attachments-open-a-session'));
    pick.click();
  },
  async '/ask'(argument) {
    const [, vault, question] = /^(\S+)\s+([\s\S]+)$/.exec(argument) ?? [];
    if (!vault) throw new LocalizedError(message('chat.enter-a-knowledge-base-id-and-a'));
    if (!knowledge) throw new LocalizedError(message('chat.no-knowledge-base-configured-check-the-integration'));
    await knowledge.ask(vault, question);
  },
  '/clear-search'() {
    const search = find('session-search');
    const previous = search.value;
    find('clear-session-search').click();
    prompt.focus();
    return { text: message('chat.session-search-cleared'), undo: previous ? () => {
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
  if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest?.('dialog[open]') &&
      !find('chat-view').hidden && !prompt.disabled) {
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
      showError(error instanceof RequestError ? error : message('chat.delivery-could-not-be-confirmed-send-the'));
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
  if (!id || context.cancelling) throw new LocalizedError(message('chat.theres-no-active-turn-to-stop'));
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
  if (topMenu.open) {
    topMenu.open = false;
    menuTrigger.focus();
  }
  try {
    await request('/api/stop', { data: {} });
    stopped = true;
    current?.events.close();
    current?.abort.abort();
    setText(connection, message('chat.service-stopped'));
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
  setText(connection, message('chat.connected'));
  setText(model, modelLabel(bootstrap.alias));
  request('/api/settings/limits').then(applyLimits).catch(() => { setText(limitsStatus, message('chat.could-not-load-the-turn-limits-refresh')); });
  request('/api/settings/model').then(applyModel).catch(() => { setText(modelStatus, message('chat.could-not-load-model-settings-refresh-the')); });
  request('/api/settings/projects').then((entries) => {
    projectFolders = entries;
    folderProject.replaceChildren(...entries.map(entry => optionText(projectLabel(entry), entry.id)));
    folderProject.value = project;
    displayProjectFolders();
    updateProjectRead();
  }).catch(() => { setText(folderStatus, message('chat.could-not-load-project-folders-refresh-the')); });
  request('/api/settings/about').then(({ version, license, pin, root }) => {
    const details = find('about-details');
    for (const [term, value] of [[message('chat.oep-version'), version], [message('chat.data-directory'), root], [message('chat.pinned-opencode-version'), pin], [message('chat.license'), license]]) {
      details.append(node('dt', term), node('dd', value));
    }
    const repository = 'https://github.com/dragon0816/OpenCode-Engineer-Platform';
    for (const [label, path] of [[message('chat.help'), '/blob/main/README.md'], [message('chat.workbench-documentation'), '/blob/main/docs/GUI_LAYOUT.md']]) {
      const link = node('a', label);
      link.href = repository + path;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(node('dt', label));
      const description = node('dd');
      description.append(link);
      details.append(description);
    }
  }).catch(() => { setText(find('about-status'), message('chat.could-not-load-version-information-refresh-the')); });
  request('/api/settings/runtime').then((runtime) => {
    setText(find('runtime-status'), runtime.compatible ? message('chat.the-pinned-version-passed-startup-checks') : message('chat.the-running-version-differs-from-the-pinned'));
    const details = find('runtime-details');
    for (const [name, value] of [[message('chat.pinned-opencode-version'), runtime.pin], [message('chat.running-version'), runtime.version]]) {
      details.append(node('dt', name), node('dd', value));
    }
    const fingerprints = find('runtime-fingerprints');
    for (const [name, value] of [
      [message('chat.commit-hash'), runtime.commit],
      [message('chat.interface-hash'), runtime.openapi], [message('chat.windows-executable-hash'), runtime.binary], [message('chat.client-hash'), runtime.client],
    ]) {
      fingerprints.append(node('dt', name), node('dd', value));
    }
    setText(find('knowledge-configured'), configuredLabel(runtime.knowledgeConfigured));
    setText(find('telegram-configured'), message('chat.telegram-integration', { status: configuredLabel(runtime.telegramConfigured) }));
  }).catch(() => {
    setText(find('runtime-status'), message('chat.could-not-load-runtime-information-refresh-the'));
    setText(find('knowledge-configured'), message('chat.could-not-load-refresh-the-page'));
  });
  request('/api/settings/appearance').then((appearance) => {
    applyAppearance(appearance);
    appearanceSave.disabled = stopped;
  }).catch(() => { setText(appearanceStatus, message('chat.could-not-load-appearance-settings-refresh-the')); });
  request('/api/settings').then((preferences) => {
    applyPreferences(preferences);
    find('save-assistant').disabled = stopped;
  }).catch(() => { setText(find('settings-status'), message('chat.could-not-load-assistant-settings-refresh-the')); });
  projects = bootstrap.projects;
  const savedProject = localStorage.getItem('oep.activeProject');
  if (projects.some(({ id }) => id === savedProject)) project = savedProject;
  const entries = project === 'default' ? bootstrap.sessions : await request(sessionPath());
  for (const session of entries) addSession(session);
  const saved = localStorage.getItem(`oep.activeSession.${project}`) ?? localStorage.getItem('oep.activeSession');
  renderSessions();
  if (entries.length) select(knownSessions.has(saved) ? saved : entries.at(-1).id);
  agent.disabled = stop.disabled = false;
  bindJobs(openFeaturePreview);
  if (bootstrap.knowledge) {
    knowledge = bindKnowledge(openFeaturePreview, () => closePanel(false));
    find('open-review').hidden = false;
  }
  find('open-chat').addEventListener('click', () => {
    find('jobs-view').hidden = true;
    find('chat-view').hidden = false;
  });
  for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) find(id).addEventListener('click', syncNavigation);
} catch (error) {
  setText(connection, message('chat.disconnected'));
  showError(error instanceof RequestError && error.status === 401 ? message('chat.double-click-the-windows-launcher-to-open') : error);
}
