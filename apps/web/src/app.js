import { formatDate, formatNumber, getLocale, initializeLocale, joinText, LocalizedError, message, optionText, resolveText, setAttribute, setLocale, setText, t } from './i18n.js';
import { connect, errorText, projectLabel, request, RequestError, serverText } from './api.js';
import { bindVoice } from './voice.js';
import { bindNotes, messageActions } from './message-operations.js';
import { bindCommands } from './commands.js';
import { bindKnowledge } from './knowledge.js';
import { bindMcpSettings } from './mcp-settings.js';
import { bindJobs, loadJobSummary } from './jobs.js';
import { agentAvatar, agentIntroduction, agentName, bindAgents, workspaceName } from './agents.js';
import { bindChannels, channelName } from './channels.js';
import { bindDelegationResults } from './delegations.js';

initializeLocale();

const find = (id) => document.getElementById(id);
const model = find('model');
const sessions = find('sessions');
const agent = find('agent');
let projects = [];
let project = 'default';
let projectBusy = false;
let assistantEntries = [];
const sessionScopes = new Map();
const sessionsPath = (agentId, workspaceId) => `/api/agents/${agentId}/workspaces/${workspaceId}/sessions`;
const sessionPath = (id) => {
  const scope = sessionScopes.get(id);
  return `${sessionsPath(scope.agentId, scope.workspaceId)}/${id}`;
};
const sessionAgent = (id) => assistantEntries.find(({ id: agentId }) => agentId === sessionScopes.get(id)?.agentId);
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
  const inactive = sessionAgent(current?.id)?.state === 'archived';
  const cancellable = !stopped && Boolean(runningID(current));
  send.hidden = cancellable;
  cancelTurn.hidden = !cancellable;
  cancelTurn.disabled = !cancellable || Boolean(current?.cancelling);
  pick.disabled = !current || uploadBusy || stopped || inactive;
  prompt.disabled = !current || stopped || inactive;
  find('session-alias').disabled = !current || !modelSettings || Boolean(current.aliasUpdating) || stopped || inactive;
  voice.update();
  find('project-read').hidden = !current || !find('project-read-folder').options.length || stopped;
  find('project-read-button').disabled = uploadBusy;
  send.disabled = !current || uploadBusy || sending || stopped || inactive || Boolean(current.pendingID || current.aliasUpdating) ||
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
    for (const other of document.querySelectorAll('#sessions details[open], .agent-row > details[open]')) {
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
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const index = actions.indexOf(document.activeElement);
      actions[(index + step + actions.length) % actions.length].focus();
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

const delegationResults = bindDelegationResults({ node, action, openPreview, openRunTab: openFeaturePreview, toolCard, showError, refresh,
  openReview: async (id, opener, signal) => {
    if (!knowledge) throw new LocalizedError(message('review.could-not-open-this-review-item-refresh'));
    await knowledge.openBiReview(id, opener, signal);
  },
});

function render(context) {
  const { state, id } = context;
  if (state.session.alias !== knownSessions.get(id)?.alias) {
    knownSessions.set(id, state.session);
    updateSessionAlias();
  }
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
    const anchors = new Map();
    for (const item of state.messages) {
      appendEvents(item.createdAt ?? 0);
      const entry = node('article', '', `message ${item.role}`);
      entry.dataset.id = item.id;
      entry.tabIndex = -1;
      if (item.role === 'assistant') entry.append(avatar(sessionAgent(id)));
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
      if (item.runId) anchors.set(item.runId, entry);
    }
    appendEvents(Infinity);
    delegationResults.place(context, fragment, anchors);
    messages.replaceChildren(fragment);
    if (focused) {
      const delegation = focused.closest('[data-delegation]')?.dataset.delegation;
      const fallback = delegation && messages.querySelector(`[data-feature-focus="delegation-${CSS.escape(delegation)}-run"]`);
      (visibleOpener(focused) || fallback)?.focus({ preventScroll: true });
    }
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

async function openPreview(file, url, context, opener, { plainText = false } = {}) {
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
  const metadata = file.createdAt === undefined ? formatFileSize(file.bytes)
    : message('chat.type-size-date', { type: fileType(file), size: formatFileSize(file.bytes), date: formatDate(file.createdAt) });
  panel.append(title, node('small', metadata), actions, body);
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
    if (plainText && extension !== 'md' && extension !== 'csv') body.append(node('pre', data));
    else if (data instanceof Blob) {
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
  const { opener } = panelTabs.get(key);
  removeTab(key);
  const parent = opener && [...panelTabs].find(([, tab]) => tab.panel.contains(opener));
  showTab(activeTab === key ? parent?.[0] ?? keys[index + 1] ?? keys[index - 1] : activeTab);
  if (parent?.[0] === activeTab) visibleOpener(opener)?.focus({ preventScroll: true });
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
  const scope = sessionScopes.get(id);
  current = undefined;
  updateAttachmentCount();
  find('file-status').textContent = '';
  renderNotes(null);
  renderReply();
  setText(find('runtime-agent'), session ? message('chat.session-assistant-assistant', { assistant: labels[session.agent] }) : message('chat.no-session-selected'));
  updateTopAgent(id);
  closePanel(false);
  find('chat-resources').replaceChildren();
  find('chat-resources').hidden = true;
  find('panel-runs').replaceChildren();
  find('panel-diff').replaceChildren();
  jump.hidden = true;
  if (!session) {
    localStorage.removeItem('oep.activeSession');
    updateSessionAlias();
    setText(sessionTitle, message('ui.chat'));
    progress.textContent = '';
    messages.replaceChildren(node('p', message('ui.select-or-create-a-session-to-start'), 'empty'));
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
  if (scope.agentId === 'main') {
    project = session.project;
    localStorage.setItem('oep.activeProject', project);
    localStorage.setItem(`oep.activeSession.${project}`, id);
  }
  localStorage.setItem('oep.activeSession', id);
  collapsedGroups.delete(scope.workspaceId);
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
  updateProjectRead();
  renderReply();
  find('session-model-status').textContent = '';
  updateSessionAlias();
  renderSessions();
  events.onopen = () => {
    if (current !== context || stopped) return;
    setText(connection, message('chat.connected'));
    delegationResults.updateOpen(context);
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
    if (detail.kind === 'delegation') delegationResults.updateOpen(context);
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

function addSession(session, agentId, workspaceId) {
  knownSessions.set(session.id, session);
  if (agentId) sessionScopes.set(session.id, { agentId, workspaceId });
}

function sessionButton(label, action) {
  const button = node('button', label);
  button.type = 'button';
  button.disabled = stopped || projectBusy;
  button.addEventListener('click', action);
  return button;
}

const collapsedGroups = new Set();
function renderSessions() {
  setText(find('session-count'), knownSessions.size);
  const query = find('session-search').value.trim().toLocaleLowerCase(getLocale());
  find('clear-session-search').hidden = !find('session-search').value;
  sessions.replaceChildren();
  for (const entry of assistantEntries) {
    const group = node('section', undefined, 'agent-session-group');
    const heading = node('h2', undefined, 'agent-session-heading');
    heading.append(node('span', agentName(entry)));
    heading.firstElementChild.toggleAttribute('data-ui-content', typeof agentName(entry) === 'string');
    if (entry.state === 'archived') heading.append(node('small', message('agents.status-disabled')));
    group.append(heading);
    sessions.append(group);
    for (const workspace of entry.workspaces) renderWorkspace(group, entry, workspace, query);
  }
}

function renderWorkspace(group, entry, workspace, query) {
    const legacy = entry.builtin === 'main';
    const legacyProject = workspace.layout === 'legacy_secondary' ? 'secondary' : 'default';
    const activeWorkspace = sessionScopes.get(current?.id)?.workspaceId;
    const section = node('section', undefined, 'project');
    const heading = node('h2', '', 'project-heading');
    const expanded = Boolean(query) || !collapsedGroups.has(workspace.id) &&
      (legacy ? legacyProject === project || activeWorkspace === workspace.id : true);
    const projectButton = sessionButton(legacy ? workspaceName(workspace) : message('agents.sessions'), () => {
      if (legacy && legacyProject !== project) { changeProject(legacyProject); return; }
      if (expanded) collapsedGroups.add(workspace.id);
      else collapsedGroups.delete(workspace.id);
      renderSessions();
      sessions.querySelector(`[data-project="${workspace.id}"]`)?.focus();
    });
    projectButton.setAttribute('aria-expanded', String(expanded));
    projectButton.dataset.project = workspace.id;
    heading.append(projectButton);
    section.append(heading);
    if (entry.state === 'active') {
      const create = sessionButton('+', () => createAgentSession(entry.id, workspace.id));
      if (legacy) create.id = legacyProject === 'default' ? 'new-session' : 'new-session-secondary';
      else create.setAttribute('data-agent-start', '');
      setAttribute(create, 'aria-label', legacy ? message('chat.new-session-in-project', { project: workspaceName(workspace) }) :
        message('agents.start-named', { name: agentName(entry) }));
      heading.append(create);
    }
    group.append(section);
    if (!expanded) return;
    const list = node('ul', undefined, 'session-list');
    for (const session of knownSessions.values()) {
      if (sessionScopes.get(session.id)?.workspaceId !== workspace.id) continue;
      const label = sessionLabel(session);
      if (!resolveText(label).toLocaleLowerCase(getLocale()).includes(query)) continue;
      const row = node('li');
      const link = sessionButton(undefined, () => {
        find('open-chat').click();
        if (find('chat-view').hidden) return;
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

function switchProject(id) {
  project = id;
  localStorage.setItem('oep.activeProject', id);
  const workspace = 'legacy-' + id;
  collapsedGroups.delete(workspace);
  const entries = [...knownSessions.keys()].filter((id) => sessionScopes.get(id)?.workspaceId === workspace);
  const saved = localStorage.getItem(`oep.activeSession.${project}`);
  select(entries.includes(saved) ? saved : entries.at(-1));
  updateProjectRead();
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
  const folders = !current || sessionAgent(current.id)?.builtin === 'main' ? projectFolders.find((entry) => entry.id === project)?.folders ?? [] : [];
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

let settingsSaving = false;
function updateAgentBranding() {
  const main = assistantEntries.find(({ builtin }) => builtin === 'main');
  const name = find('sidebar-assistant-name');
  name.toggleAttribute('data-ui-content', Boolean(main?.name));
  setText(name, agentName(main));
  const introduction = find('sidebar-assistant-intro');
  introduction.toggleAttribute('data-ui-content', Boolean(main?.introduction));
  const intro = agentIntroduction(main);
  setText(introduction, intro);
  setAttribute(introduction, 'title', intro);
  agentAvatar(document.querySelector('.sidebar-assistant .assistant-avatar'), main);
  for (const element of messages.querySelectorAll('.assistant-avatar')) agentAvatar(element, sessionAgent(current?.id));
  updateTopAgent(current?.id);
}

function updateTopAgent(id) {
  const entry = sessionAgent(id);
  const label = find('top-agent');
  label.toggleAttribute('data-ui-content', typeof agentName(entry) === 'string');
  setText(label, id ? agentName(entry) : '');
  label.hidden = !id;
}

let agentOpener;
const agentView = find('agent-view');
const agentEditor = bindAgents({ onChange: refreshAgents, close: () => find('close-agent').click(),
  openChannels: () => openAgentSettings('channels'), openMcp: () => openAgentSettings('mcp') });
const loadChannels = bindChannels(() => assistantEntries, refreshAgents);

function openAgent(id, copy, opener) {
  if (stopped || !settingsView.hidden && !discardSettings() || !agentEditor.leave()) return;
  agentOpener = opener;
  leaveModelSection();
  closePanel(false);
  for (const id of ['chat-view', 'knowledge-view', 'jobs-view', 'review-view', 'settings-view']) find(id).hidden = true;
  for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review', 'open-settings']) find(id).removeAttribute('aria-current');
  agentView.hidden = false;
  if (narrowNavigation.matches) setSidebar(false);
  void agentEditor.open(id, copy);
}

function openAgentSettings(section) {
  if (!agentEditor.leave()) return;
  if (switchSettingsSection(section)) showSettings();
}

find('new-agent').addEventListener('click', (event) => openAgent(undefined, false, event.currentTarget));
find('open-main-agent').addEventListener('click', (event) => openAgent('main', false, event.currentTarget));
find('close-agent').addEventListener('click', () => {
  if (!agentEditor.leave()) return;
  if (agentOpener?.id === 'open-main-agent') showSettings();
  else find('open-chat').click();
  if (!agentOpener?.isConnected || narrowNavigation.matches && !agentOpener.closest('#settings-view')) {
    if (narrowNavigation.matches) sidebarToggle.focus();
    return;
  }
  agentOpener.focus();
});
agentView.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    find('close-agent').click();
  }
});

function renderAgents() {
  const states = { available: message('agents.status-available'), busy: message('agents.status-busy'), queued: message('agents.status-queued'),
    disabled: message('agents.status-disabled') };
  const active = assistantEntries.filter(({ state }) => state === 'active');
  const archived = assistantEntries.filter(({ state }) => state === 'archived');
  setText(find('assistant-count'), active.length);
  const rowFor = (entry) => {
    const row = node('article', undefined, 'agent-row');
    row.dataset.agent = entry.id;
    const open = sessionButton(undefined, () => openAgent(entry.id, false, open));
    open.className = 'agent-row-open';
    const name = node('strong', agentName(entry));
    name.toggleAttribute('data-ui-content', typeof agentName(entry) === 'string');
    const info = node('span');
    info.append(name, node('small', states[entry.status]));
    for (const channel of entry.channels) {
      const bot = node('small', channelName(channel));
      bot.toggleAttribute('data-ui-content', typeof channelName(channel) === 'string');
      info.append(bot);
    }
    open.append(avatar(entry), info);
    const start = sessionButton(message('agents.start'), () => createAgentSession(entry.id,
      entry.id === 'main' ? 'legacy-' + project : entry.workspaces.find(({ isDefault }) => isDefault)?.id));
    start.className = 'agent-row-start';
    start.hidden = entry.state === 'archived';
    const menu = node('details');
    const trigger = node('summary', '⋯', 'menu-trigger');
    setAttribute(trigger, 'aria-label', message('agents.more-named', { name: agentName(entry) }));
    const copy = sessionButton(message('agents.copy'), () => openAgent(entry.id, true, open));
    const actions = [copy];
    if (!entry.builtin && entry.state === 'active') actions.push(sessionButton(message('agents.archive'), async () => {
      if (!window.confirm(t('agents.confirm-archive', { name: resolveText(agentName(entry)) }))) return;
      try {
        await request('/api/agents/' + entry.id, { data: { action: 'archive', revision: entry.revision } });
        await refreshAgents();
        find('new-agent').focus();
      } catch (error) { showError(error); }
    }));
    const options = node('div', undefined, 'menu-actions');
    options.append(...actions);
    menu.append(trigger, options);
    bindRowMenu(menu, trigger, actions);
    row.append(open, start, menu);
    return row;
  };
  find('agent-list').replaceChildren(...active.map(rowFor));
  find('archived-agent-list').replaceChildren(...archived.map(rowFor));
  find('archived-agents').hidden = !archived.length;
}

async function refreshAgents() {
  const { agents: entries } = await request('/api/agents');
  if (JSON.stringify(entries) === JSON.stringify(assistantEntries)) return;
  const focused = document.activeElement.closest?.('.agent-row[data-agent]');
  assistantEntries = entries;
  renderAgents();
  updateAgentBranding();
  renderSessions();
  setControls();
  if (focused) find('rail-assistants').querySelector(`[data-agent="${CSS.escape(focused.dataset.agent)}"] .agent-row-open`)?.focus();
}

const theme = find('theme');
const density = find('density');
const appearanceStatus = find('appearance-status');
const appearanceSave = find('save-appearance');
const legacyTheme = localStorage.getItem('oep.theme');
let savedAppearance;
function avatar(entry) {
  const element = node('span', 'O', 'assistant-avatar');
  element.setAttribute('aria-hidden', 'true');
  agentAvatar(element, entry);
  return element;
}
function previewAppearance() {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.dataset.density = density.value;
}
function applyAppearance(value) {
  savedAppearance = { ...value, theme: value.theme ?? theme.value };
  theme.value = savedAppearance.theme;
  density.value = value.density;
  previewAppearance();
}
if (['system', 'light', 'dark'].includes(legacyTheme)) theme.value = legacyTheme;
for (const input of [theme, density]) input.addEventListener('change', previewAppearance);
previewAppearance();
find('appearance-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (appearanceSave.disabled) return;
  const fields = [theme, density, appearanceSave];
  fields.forEach((field) => { field.disabled = true; });
  settingsSaving = true;
  setText(appearanceStatus, message('chat.saving'));
  try {
    const data = { theme: theme.value, density: density.value };
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
  return savedAppearance && (theme.value !== savedAppearance.theme || density.value !== savedAppearance.density);
}
const defaultAlias = find('default-alias');
const sessionAlias = find('session-alias');
const modelStatus = find('model-settings-status');
const modelUnsaved = find('model-unsaved');
const modelList = find('model-health');
const modelRestart = find('model-restart');
const modelApplyCookie = 'oep_model_apply';
const modelTests = new Map();
let modelSettings;
let selectedModels = new Set();
let modelBusy = false;
let modelRetry;
function aliasOptions(select, selected, aliases, configuredDefault) {
  select.replaceChildren(...aliases.map((alias) => optionText(
    alias === configuredDefault ? message('chat.default-in-settings-model', { model: alias }) : alias, alias)));
  select.value = selected ?? '';
}
function updateSessionAlias() {
  const session = current && knownSessions.get(current.id);
  const aliases = modelSettings?.aliases.map(({ alias }) => alias) ?? [];
  const fallback = session && modelSettings && !aliases.includes(session.alias) ? modelSettings.defaultAlias : undefined;
  aliasOptions(sessionAlias, fallback ?? session?.alias, aliases, modelSettings?.defaultAlias);
  sessionAlias.disabled = !session || !modelSettings || Boolean(current.aliasUpdating) || stopped;
  find('session-model-hint').hidden = aliases.length !== 1 || modelSettings.selected.length !== 1;
  if (modelSettings) setText(model, session?.alias ?? modelSettings.defaultAlias);
  let notice = '';
  if (fallback) notice = message('model.fallback-next', { model: fallback });
  else if (current?.modelFallback) notice = message('model.fallback-used', { model: current.modelFallback });
  setText(find('session-model-fallback'), notice);
}
function modelControls() {
  const disabled = stopped || modelBusy || !modelSettings;
  const dirty = Boolean(modelDirty());
  if (dirty !== Boolean(modelUnsaved.textContent)) setText(modelUnsaved, dirty ? message('model.unsaved') : '');
  for (const control of modelList.querySelectorAll('input, button')) control.disabled = disabled;
  for (const id of ['default-alias', 'recheck-model', 'refresh-models']) find(id).disabled = disabled;
  find('save-model').disabled = disabled || !dirty || !selectedModels.size || selectedModels.size > modelSettings.maxSelected;
  modelRestart.disabled = disabled || !modelSettings.canRestart || dirty;
}
function modelDraftChanged() {
  if (!modelRetry) setText(modelStatus, '');
  modelControls();
}
function applyModel(value, draft) {
  modelSettings = value;
  selectedModels = new Set(draft?.selected.filter((id) => value.choices.includes(id)) ?? value.selected);
  const picked = draft?.alias ?? value.configuredDefaultAlias;
  aliasOptions(defaultAlias, selectedModels.has(picked) ? picked : [...selectedModels][0], [...selectedModels]);
  setText(find('model-credentials'), value.credentialsConfigured ? message('chat.credentials-configured') : message('chat.credentials-missing'));
  setText(find('model-discovery'), value.discoveredAt === null ? message('model.built-ins') :
    message('model.last-refresh', { date: formatDate(value.discoveredAt) }));
  setText(find('model-limit'), message('model.selection-limit', { max: value.maxSelected }));
  const health = new Map(value.aliases.map(({ alias, healthy }) => [alias, healthy]));
  modelList.replaceChildren(...value.choices.map((alias) => {
    const row = node('li');
    const label = node('label');
    const choice = node('input');
    choice.type = 'checkbox';
    choice.value = alias;
    choice.checked = selectedModels.has(alias);
    const name = node('span', alias);
    name.dataset.uiContent = '';
    label.append(choice, name);
    const status = node('small');
    const showHealth = (healthy) => setText(status, healthy === undefined ? '' : healthy ? message('chat.available') : message('chat.check-failed'));
    showHealth(modelTests.get(alias) ?? health.get(alias));
    choice.addEventListener('change', () => {
      if (choice.checked) selectedModels.add(alias);
      else selectedModels.delete(alias);
      const previous = defaultAlias.value;
      aliasOptions(defaultAlias, selectedModels.has(previous) ? previous : [...selectedModels][0], [...selectedModels]);
      modelDraftChanged();
    });
    const test = node('button', message('model.test'));
    test.type = 'button';
    setAttribute(test, 'aria-label', message('model.test-model', { model: alias }));
    test.addEventListener('click', async () => {
      if (modelBusy) return;
      modelBusy = true;
      modelControls();
      setText(status, message('chat.checking'));
      try {
        const { healthy } = await request('/api/settings/model/test', { data: { alias } });
        modelTests.set(alias, healthy);
        showHealth(healthy);
      } catch (error) { setText(status, errorText(error)); }
      finally { modelBusy = false; modelControls(); }
    });
    status.setAttribute('role', 'status');
    row.append(label, status, test);
    return row;
  }));
  find('model-restart-bar').hidden = !value.restartRequired;
  updateSessionAlias();
  modelControls();
}
async function updateModel(action) {
  if (modelBusy) return;
  const draft = { alias: defaultAlias.value, selected: [...selectedModels] };
  const save = action === 'save';
  let applySaved = false;
  if (save) {
    cancelModelRetry();
    settingsSaving = true;
  }
  modelBusy = true;
  modelControls();
  setText(modelStatus, save ? message('chat.saving') : action === 'refresh' ? message('model.refreshing') : message('chat.checking'));
  try {
    const value = await request('/api/settings/model' + (save ? '' : '/' + action), { data: save ? draft : {} });
    if (action === 'recheck') for (const { alias } of value.aliases) modelTests.delete(alias);
    applyModel(value, !save && modelDirty() ? draft : undefined);
    applySaved = save && value.restartRequired && value.canRestart;
    const status = save ? message('chat.saved') : action === 'recheck' ? message('chat.recheck-complete') :
      value.refreshed ? message('model.refreshed') : message('model.refresh-failed');
    setText(modelStatus, status);
  } catch (error) {
    setText(modelStatus, error.status === 429 ? message('chat.wait-30-seconds-before-checking-again') :
      errorText(error, message('chat.could-not-update-model-settings-try-again')));
  } finally {
    if (save) settingsSaving = false;
    modelBusy = false;
    modelControls();
  }
  if (applySaved) void restartModels(modelSettings);
}
find('model-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  modelControls();
  if (!find('save-model').disabled) void updateModel('save');
});
find('recheck-model').addEventListener('click', () => void updateModel('recheck'));
find('refresh-models').addEventListener('click', () => void updateModel('refresh'));
defaultAlias.addEventListener('change', modelDraftChanged);

function modelSectionOpen() {
  return !settingsView.hidden && activeSettingsSection === 'model';
}
function cancelModelRetry() {
  if (!modelRetry) return;
  clearTimeout(modelRetry.timer);
  modelRetry.controller.abort();
  modelRetry = undefined;
}
function leaveModelSection() {
  if (modelRetry) setText(modelStatus, '');
  cancelModelRetry();
}
function queueModelRetry() {
  const controller = new AbortController();
  const { signal } = controller;
  const retry = modelRetry = { controller, timer: setTimeout(check, 2_000) };
  async function check() {
    if (stopped || !modelSectionOpen()) {
      cancelModelRetry();
      return;
    }
    try {
      if (!modelBusy && !modelDirty()) {
        const value = await request('/api/settings/model', { signal });
        if (signal.aborted) return;
        if (!modelBusy && !modelDirty()) {
          if (value.restartRequired) void restartModels(value);
          else {
            cancelModelRetry();
            applyModel(value);
            setText(modelStatus, message('model.applied'));
          }
          return;
        }
      }
      retry.timer = setTimeout(check, 2_000);
    } catch (error) {
      if (signal.aborted) return;
      cancelModelRetry();
      setText(modelStatus, errorText(error));
    }
  }
}

async function modelSelectionDigest({ selected, configuredDefaultAlias }) {
  const bytes = new TextEncoder().encode(JSON.stringify([configuredDefaultAlias, [...selected].sort()]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
function readModelApplyCookie() {
  return document.cookie.split('; ').find((entry) => entry.startsWith(modelApplyCookie + '='))?.slice(modelApplyCookie.length + 1);
}
function writeModelApplyCookie(value, seconds) {
  document.cookie = `${modelApplyCookie}=${value}; Path=/; Max-Age=${seconds}; SameSite=Strict`;
}
async function confirmModelApply(value) {
  const marker = readModelApplyCookie();
  const [port, selection] = marker?.split('.') ?? [];
  if (!port || port === location.port || value.restartRequired || selection !== await modelSelectionDigest(value) ||
      readModelApplyCookie() !== marker) return;
  writeModelApplyCookie('', 0);
  setText(modelStatus, message('model.applied'));
  setText(find('session-model-status'), message('model.applied'));
}
async function restartModels(value) {
  if (modelBusy || stopped || !modelSectionOpen()) return;
  cancelModelRetry();
  modelBusy = true;
  modelControls();
  let marker;
  let restarting = false;
  try {
    // The launcher opens a paired tab on a new port. Only the expiring UI handoff crosses ports.
    marker = `${location.port}.${await modelSelectionDigest(value)}`;
    if (!modelSectionOpen()) return;
    writeModelApplyCookie(marker, 120);
    await request('/api/settings/model/restart', { data: {} });
    restarting = true;
    setText(modelStatus, message('tools.restarting-continue-in-the-oep-tab-that'));
  } catch (error) {
    if (marker && error instanceof RequestError && readModelApplyCookie() === marker) writeModelApplyCookie('', 0);
    if (error.status === 409 && modelSectionOpen()) {
      setText(modelStatus, message('model.apply-deferred'));
      queueModelRetry();
    } else setText(modelStatus, errorText(error));
  } finally {
    if (!restarting) {
      modelBusy = false;
      modelControls();
    }
  }
}
modelRestart.addEventListener('click', () => void restartModels(modelSettings));
window.addEventListener('pagehide', cancelModelRetry);
sessionAlias.addEventListener('change', async () => {
  const context = current;
  const status = find('session-model-status');
  if (!context) return;
  context.aliasUpdating = true;
  setControls();
  try {
    const session = await request(`${context.path}/model`, { data: { alias: sessionAlias.value } });
    knownSessions.set(session.id, session);
    context.modelFallback = undefined;
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
  return modelSettings && (defaultAlias.value !== modelSettings.configuredDefaultAlias ||
    selectedModels.size !== modelSettings.selected.length || modelSettings.selected.some((id) => !selectedModels.has(id)));
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
function discardSettings() {
  if (settingsSaving) return false;
  if (!appearanceDirty() && !modelDirty() && !limitsDirty()) return true;
  if (!window.confirm(t('chat.discard-unsaved-settings'))) return false;
  if (appearanceDirty()) applyAppearance(savedAppearance);
  if (modelDirty()) applyModel(modelSettings);
  if (limitsDirty()) for (const [key, input] of limitInputs) input.value = savedLimits[key];
  [appearanceStatus, modelStatus, limitsStatus].forEach(element => setText(element, ''));
  return true;
}
window.addEventListener('beforeunload', (event) => {
  if (!agentEditor.dirty() && !appearanceDirty() && !modelDirty() && !limitsDirty()) return;
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
  if (activeSettingsSection === 'channels') void loadChannels();
  if (activeSettingsSection === 'mcp') void loadMcpSettings();
  if (activeSettingsSection === 'integrations') void loadTelegramStatus();
}

function switchSettingsSection(section) {
  if (section === activeSettingsSection) return true;
  if (!discardSettings()) return false;
  if (activeSettingsSection === 'model') leaveModelSection();
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
  if (!agentEditor.leave()) return;
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
find('choose-more-models').addEventListener('click', (event) => {
  event.preventDefault();
  if (switchSettingsSection('model')) showSettings();
});
find('close-settings').addEventListener('click', () => {
  find('open-chat').click();
  if (settingsView.hidden && narrowNavigation.matches) sidebarToggle.focus();
});
for (const id of ['open-chat', 'open-knowledge', 'open-jobs', 'open-review']) {
  find(id).addEventListener('click', (event) => {
    if (!agentEditor.leave()) {
      event.stopImmediatePropagation();
      return;
    }
    if (settingsView.hidden) return;
    if (!discardSettings()) {
      event.stopImmediatePropagation();
      return;
    }
    if (activeSettingsSection === 'model') leaveModelSection();
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
  for (const menu of document.querySelectorAll('#sessions details[open], .agent-row > details[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

async function renameSession(session) {
  const title = window.prompt(t('chat.enter-a-session-name'), resolveText(sessionLabel(session)));
  if (title === null) return;
  try {
    const renamed = await request(`${sessionPath(session.id)}/rename`, { data: { title } });
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
    const workspace = sessionScopes.get(session.id)?.workspaceId;
    sessionScopes.delete(session.id);
    knownSessions.delete(session.id);
    if (current?.id === session.id) select([...knownSessions.keys()].filter((id) => sessionScopes.get(id)?.workspaceId === workspace).at(-1));
    renderSessions();
    (sessions.querySelector('[aria-current="true"]') ?? find('session-search')).focus();
    setText(find('command-toast'), message('chat.session-deleted'));
  } catch (error) { showError(error); }
}

async function changeProject(id) {
  if (projectBusy || stopped) return;
  find('open-chat').click();
  if (find('chat-view').hidden) return;
  projectBusy = true;
  try { switchProject(id); }
  catch (error) { showError(error); }
  finally {
    projectBusy = false;
    renderSessions();
    find('session-search').focus();
  }
}

async function createAgentSession(agentId, workspaceId) {
  if (projectBusy || stopped || !workspaceId) return;
  find('open-chat').click();
  if (find('chat-view').hidden) return;
  projectBusy = true;
  showError();
  try {
    const session = await request(sessionsPath(agentId, workspaceId), { data: agentId === 'main' ? { agent: agent.value } : {} });
    addSession(session, agentId, workspaceId);
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
    const scope = sessionScopes.get(current?.id) ?? { agentId: 'main', workspaceId: 'legacy-' + project };
    const created = await createAgentSession(scope.agentId, scope.workspaceId);
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
        context.modelFallback = undefined;
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
    if (!current) throw new LocalizedError(message('chat.could-not-select-attachments-open-a-session'));
    await knowledge.ask(vault, question, `${current.path}/knowledge-ask`);
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
    const result = await request(`${context.path}/turns`, { data: { id, ...data } });
    if (result.modelFallback) {
      context.modelFallback = result.modelFallback;
      const session = knownSessions.get(context.id);
      if (session) knownSessions.set(context.id, { ...session, alias: result.modelFallback });
      if (current === context) updateSessionAlias();
    }
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
  const pairedLaunch = new URLSearchParams(location.hash.slice(1)).has('pair');
  const bootstrap = await connect();
  setText(connection, message('chat.connected'));
  setText(model, bootstrap.alias);
  request('/api/settings/limits').then(applyLimits).catch(() => { setText(limitsStatus, message('chat.could-not-load-the-turn-limits-refresh')); });
  const modelBootstrap = request('/api/settings/model').then((value) => {
    applyModel(value);
    return value;
  }).catch(() => { setText(modelStatus, message('chat.could-not-load-model-settings-refresh-the')); });
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
  projects = bootstrap.projects;
  const savedProject = localStorage.getItem('oep.activeProject');
  if (projects.some(({ id }) => id === savedProject)) project = savedProject;
  await refreshAgents();
  await Promise.all(assistantEntries.flatMap((assistant) => assistant.workspaces.map(async (workspace) => {
    const entries = await request(sessionsPath(assistant.id, workspace.id));
    for (const session of entries) addSession(session, assistant.id, workspace.id);
  })));
  const saved = localStorage.getItem('oep.activeSession') ?? localStorage.getItem(`oep.activeSession.${project}`);
  const recent = [...knownSessions.values()].filter((entry) => sessionScopes.get(entry.id)?.workspaceId === 'legacy-' + project).at(-1);
  renderSessions();
  select(knownSessions.has(saved) ? saved : recent?.id);
  if (pairedLaunch) void modelBootstrap.then((value) => value && confirmModelApply(value))
    .catch(() => { setText(modelStatus, message('chat.could-not-load-model-settings-refresh-the')); });
  agent.disabled = stop.disabled = find('new-agent').disabled = false;
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
  window.setInterval(() => {
    if (!stopped && !document.hidden) void refreshAgents().catch(() => {});
  }, 10_000);
} catch (error) {
  setText(connection, message('chat.disconnected'));
  showError(error instanceof RequestError && error.status === 401 ? message('chat.double-click-the-windows-launcher-to-open') : error);
}
