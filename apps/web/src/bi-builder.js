import { errorText } from './api.js';
import { biDocumentIssues } from './bi-documents.js';
import { bindFilePicker, getLocale, joinText, message, optionText, setText } from './i18n.js';

const working = new Set(['converting', 'extracting', 'validating']);
const steps = [
  message('biBuilder.sources'), message('biBuilder.convert'), message('biBuilder.extract'),
  message('biBuilder.validate'), message('biBuilder.submit'), message('biBuilder.publish'),
];
const states = {
  converting: message('biDocument.state.converting'),
  extracting: message('biBuilder.extract'),
  validating: message('biDocument.state.validating'),
  validated: message('biBuilder.validated'),
  'awaiting-review': message('biDocument.state.awaiting-review'),
  'needs-attention': message('biDocument.state.needs-attention'),
  failed: message('biDocument.state.failed'),
  approved: message('jobs.approved'),
  rejected: message('jobs.rejected'),
  published: message('jobs.published'),
};

function element(tag, text, id) {
  const node = document.createElement(tag);
  if (id) node.id = 'bi-builder-' + id;
  if (text !== undefined) setText(node, text);
  return node;
}

function field(label, input) {
  const wrapper = element('label');
  wrapper.append(element('span', label), input);
  return wrapper;
}

function button(label, id, action) {
  const node = element('button', label, id);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export async function openBiBuilder(area, api, signal, openReview, draft) {
  const form = element('div', undefined, 'form');
  form.className = 'bi-builder';
  area.replaceChildren(form);
  const pipeline = element('ol', undefined, 'steps');
  for (const title of steps) pipeline.append(element('li', title));
  function selectStep(index) {
    pipeline.childNodes.forEach((step, i) => {
      if (i === index) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }
  selectStep(0);

  const title = element('input', undefined, 'title');
  title.maxLength = 100;
  title.value = draft.title ?? '';
  title.addEventListener('input', () => { draft.title = title.value; });
  const file = element('input', undefined, 'file');
  file.type = 'file';
  file.accept = '.pdf,.png,.jpg,.jpeg,.txt,.md,.markdown,.html,.htm';
  const url = element('input', undefined, 'url');
  url.type = 'url';
  url.maxLength = 2048;
  url.value = draft.url ?? '';
  url.addEventListener('input', () => { draft.url = url.value; selectStep(0); });
  file.addEventListener('change', () => {
    if (file.files.length) url.value = draft.url = '';
    selectStep(0);
  });
  url.addEventListener('input', () => {
    if (!url.value || !file.files.length) return;
    file.value = '';
    file.dispatchEvent(new Event('change'));
  });
  const folder = element('input', undefined, 'folder');
  folder.maxLength = 2048;
  folder.value = draft.folder ?? '';
  folder.addEventListener('input', () => { draft.folder = folder.value; });
  const pick = button(message('references.pick-folder'), 'pick', () => perform(async () => {
    const chosen = await api.call('bi.pick', { locale: getLocale() });
    if (chosen.folder) folder.value = draft.folder = chosen.folder;
  }));
  const schema = element('select', undefined, 'schema');
  schema.addEventListener('change', () => { draft.schema = schema.value; });
  const language = element('select', undefined, 'ocr-language');
  language.append(optionText(message('biOcr.language.auto'), 'auto'), optionText(message('biOcr.language.en-US'), 'en-US'),
    optionText(message('biOcr.language.zh-Hant-TW'), 'zh-Hant-TW'));
  language.value = draft.ocrLanguage ?? 'auto';
  language.addEventListener('change', () => { draft.ocrLanguage = language.value; });
  const mode = element('select', undefined, 'ocr-mode');
  mode.append(optionText(message('biOcr.mode.auto'), 'auto'), optionText(message('biOcr.mode.local-only'), 'local'),
    optionText(message('biOcr.mode.model'), 'model'));
  mode.value = draft.ocrMode ?? 'auto';
  mode.addEventListener('change', () => { draft.ocrMode = mode.value; });
  const pageReport = element('div', undefined, 'pages');
  const areas = [element('section'), element('section'), element('section')];
  areas[0].append(element('h3', steps[0]), field(message('biBuilder.title'), title),
    field(message('biDocument.file'), file), field(message('biOcr.language'), language), field(message('biOcr.mode'), mode),
    element('p', message('biOcr.gateway')), pageReport, field(message('biDocument.url'), url), field(message('biBuilder.folder'), folder), pick);
  bindFilePicker(file);
  const pickerButton = file.nextElementSibling.querySelector('button');
  const consent = element('input', undefined, 'consent');
  consent.type = 'checkbox';
  consent.checked = draft.allowModel === true;
  consent.addEventListener('change', () => { draft.allowModel = consent.checked; });
  const importSchemas = button(message('biDocument.import'), 'schemas', () => perform(async () => {
    const result = await api.call('bi.schemas', { folder: folder.value.trim() });
    choose(result.choices);
    setText(feedback, message('biDocument.imported', { count: result.count }));
  }));
  const importRepository = button(message('biBuilder.repository'), 'repository', () => perform(async () => {
    draw(await api.call('bi.repository', { folder: folder.value.trim(), allowModel: consent.checked,
      title: title.value.trim() || undefined }));
  }));
  areas[0].append(importRepository);
  const progress = element('progress', undefined, 'progress');
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute('aria-labelledby', 'bi-builder-progress-title');
  const progressTitle = element('h3', message('biBuilder.progress'), 'progress-title');
  const feedback = element('p', undefined, 'status');
  feedback.setAttribute('role', 'status');
  const validation = element('div', undefined, 'report');
  const history = element('ul', undefined, 'history');
  const produced = element('p', undefined, 'summary');
  const run = button(message('biBuilder.run'), 'run', () => perform(start));
  const submit = button(message('biBuilder.submit'), 'submit', () => perform(async () => {
    draw(await api.call('bi.submit', { id: current.id }));
  }));
  const review = button(message('biBuilder.openReview'), 'review', () => openReview(current.reviewId));
  const consentLabel = element('label');
  consentLabel.append(consent, element('span', message('biDocument.allowModel')));
  areas[1].append(element('h3', steps[2]), field(message('biDocument.schema'), schema), importSchemas,
    element('p', message('biDocument.gateway')), consentLabel, run);
  areas[2].append(progressTitle, progress, feedback, element('h3', steps[3]), validation, submit, review, produced,
    element('h3', message('biBuilder.history')), history);
  form.append(pipeline, ...areas);

  let current;
  let busy = false;
  const ledger = new Map();
  function choose(items) {
    const previous = schema.value || draft.schema;
    schema.replaceChildren(...items.map(item => optionText(item.builtin && !item.vault.startsWith('bi-build-') ?
      message('biDocument.builtin') : item.title, item.id)));
    if (items.some(({ id }) => id === previous)) schema.value = previous;
  }

  function controls() {
    for (const input of [title, file, url, folder, schema, language, mode, pick, consent, pickerButton, importSchemas, importRepository]) input.disabled = busy;
    run.disabled = busy || !schema.value;
    submit.disabled = busy;
    submit.hidden = current?.state !== 'validated';
    review.hidden = !current?.reviewId;
    review.disabled = busy;
  }

  function draw(result) {
    current = result;
    ledger.set(result.id, result);
    const state = result.reviewState || result.state;
    const index = { converting: 1, extracting: 2, validating: 3, validated: 3, 'needs-attention': 3,
      'awaiting-review': 4, pending: 4, rejected: 4, approved: 5, published: 5 }[state] ?? 0;
    selectStep(index);
    progress.value = result.state === 'extracting' ? 35 + 35 * result.completedChunks / Math.max(1, result.totalChunks) :
      [0, 15, 35, 80, 90, 100][index];
    setText(run, result.state === 'failed' || result.state === 'needs-attention' ? message('biBuilder.retry') : message('biBuilder.run'));
    const detail = result.issue ? biDocumentIssues[result.issue] : result.state === 'extracting' ?
      message('biDocument.progress', { completed: result.completedChunks, total: result.totalChunks }) :
      states[state] || states[result.state];
    setText(feedback, detail);
    pageReport.replaceChildren();
    if (result.pages?.length) {
      const list = element('ul');
      for (const page of result.pages) list.append(element('li', joinText([
        message('biOcr.page', { page: page.locator.split(':')[1],
          status: message('biOcr.status.' + (page.status === 'local' ? 'local-ocr' : page.status)) }),
        page.ocr?.engine, page.warning && message('biOcr.warning.' + page.warning),
      ])));
      pageReport.append(element('p', result.source.title || result.source.ref), list);
    }
    validation.replaceChildren();
    if (result.repository) {
      const { digestVerified, sizeVerified, ...details } = result.repository;
      validation.append(element('p', message('biBuilder.repositoryReport', details)),
        element('p', digestVerified && sizeVerified ? message('biBuilder.repositoryVerified') : message('biBuilder.repositoryPartial')));
    }
    if (result.candidates.length) {
      const accepted = result.candidates.filter(candidate => candidate.state !== 'needs-attention').length;
      validation.append(element('p', message('biBuilder.validation', { accepted, held: result.candidates.length - accepted })));
      const candidates = element('ul');
      for (const candidate of result.candidates) {
        const row = element('li');
        row.append(element('strong', candidate.name || message('biDocument.unnamed')));
        const findings = element('ul');
        for (const issue of candidate.issues) {
          const finding = element('li');
          if (issue.field) finding.append(element('strong', issue.field + ' '));
          finding.append(element('span', biDocumentIssues[issue.code]));
          findings.append(finding);
        }
        for (const evidence of Object.values(candidate.evidence)) {
          findings.append(element('li', joinText([evidence.locator,
            evidence.ocr && message('biOcr.evidence', { engine: evidence.ocr.engine }), evidence.quote])));
        }
        row.append(findings);
        candidates.append(row);
      }
      validation.append(candidates);
    }
    setText(produced, result.summary ? message('biBuilder.summary', { title: result.title, revision: result.publication, ...result.summary }) : '');
    drawHistory();
    controls();
  }

  function drawHistory() {
    const sorted = [...ledger.values()].reverse();
    history.replaceChildren(...sorted.map(item => {
      const row = element('li');
      row.append(button(item.source.title || item.source.ref, undefined, () => perform(async () => {
        await watch(await api.call('bi.status', { id: item.id }));
      })), element('span', states[item.reviewState] || states[item.state]));
      return row;
    }));
  }

  async function watch(result) {
    draw(result);
    while (working.has(result.state)) {
      await new Promise(resolve => setTimeout(resolve, 400));
      signal.throwIfAborted();
      result = await api.call('bi.status', { id: result.id });
      draw(result);
    }
  }

  async function start() {
    const selected = file.files[0];
    const link = url.value.trim();
    if (Boolean(selected) === Boolean(link)) {
      setText(feedback, message('biDocument.chooseOne'));
      return;
    }
    setText(feedback, states.converting);
    progressTitle.scrollIntoView({ block: 'nearest' });
    const source = selected ? (await api.source(selected)).id : undefined;
    const params = { schema: schema.value, allowModel: consent.checked, title: title.value.trim() || undefined,
      ocr: { language: language.value, mode: mode.value },
      ...(source ? { source } : { url: link }) };
    await watch(await api.call('bi.start', params));
  }

  async function perform(action) {
    if (busy || signal.aborted) return;
    busy = true;
    controls();
    try { await action(); }
    catch (error) { if (!signal.aborted) setText(feedback, errorText(error)); }
    finally { busy = false; controls(); }
  }

  await perform(async () => {
    const { choices, runs } = await api.call('bi.catalog');
    choose(choices);
    for (const item of [...runs].reverse()) ledger.set(item.id, item);
    drawHistory();
    if (runs.length) await watch(await api.call('bi.status', { id: runs[0].id }));
  });
}
