import { errorText } from './api.js';
import { biDocumentIssues } from './bi-documents.js';
import { gatewayModelOption } from './external-helpers.js';
import { bindFilePicker, formatDate, getLocale, joinText, message, optionText, resolveText, setText } from './i18n.js';

const working = new Set(['converting', 'extracting', 'validating', 'testing']);
const steps = [
  message('biBuilder.sources'), message('biBuilder.convert'), message('biBuilder.ingest'),
  message('biBuilder.testing'), message('biBuilder.submit'), message('biBuilder.publish'),
];
const states = {
  converting: message('biDocument.state.converting'),
  converted: message('biBuilder.converted'),
  ingested: message('biBuilder.ingested'),
  testing: message('biBuilder.testing'),
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
const pageStates = {
  'text-layer': message('biOcr.status.text-layer'),
  local: message('biOcr.status.local-ocr'),
  model: message('biOcr.status.model'),
  failed: message('biOcr.status.failed'),
};
const pageWarnings = {
  'render-failed': message('biOcr.warning.render-failed'),
  'local-unavailable': message('biOcr.warning.local-unavailable'),
  'local-failed': message('biOcr.warning.local-failed'),
  'local-low-text': message('biOcr.warning.local-low-text'),
  'vision-no-model': message('biOcr.warning.vision-no-model'),
  'vision-unsupported': message('biOcr.warning.vision-unsupported'),
  'vision-unavailable': message('biOcr.warning.vision-unavailable'),
  'vision-rejected': message('biOcr.warning.vision-rejected'),
  'vision-failed': message('biOcr.warning.vision-failed'),
  'vision-budget': message('biOcr.warning.vision-budget'),
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

const inboxLabels = {
  active: data => message('biBuilder.inboxActive', data),
  paused: data => message('biBuilder.inboxPaused', data),
};
const benchmarkLabels = {
  passed: data => message('biBuilder.benchmark-passed', data),
  failed: data => message('biBuilder.benchmark-failed', data),
  skipped: data => message('biBuilder.benchmark-skipped', data),
};

function select(id, options) {
  const input = element('select', undefined, id);
  input.replaceChildren(...Object.entries(options).map(([value, label]) => optionText(label, value)));
  return input;
}

function check(id) {
  const input = element('input', undefined, id);
  input.type = 'checkbox';
  return input;
}

function integer(id, min, max) {
  const input = element('input', undefined, id);
  input.type = 'number';
  input.min = min;
  input.max = max;
  return input;
}

export async function openBiBuilder(area, api, signal, openReview, draft, openPanel) {
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
  file.accept = '.pdf,.png,.jpg,.jpeg,.txt,.md,.markdown,.csv,.html,.htm';
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
  schema.addEventListener('change', () => {
    draft.schema = schema.value;
    settings = undefined;
    controls();
    void loadSettings().catch(error => { if (!signal.aborted) setText(feedback, errorText(error)); });
  });
  const library = element('section');
  const areas = [element('section', undefined, 'convert-panel'), element('section', undefined, 'ingest-panel'),
    element('section', undefined, 'testing-panel')];
  library.append(element('h3', steps[0]), field(message('biBuilder.title'), title), field(message('biBuilder.folder'), folder), pick);
  const consent = element('input', undefined, 'consent');
  consent.type = 'checkbox';
  consent.checked = draft.allowModel === true;
  consent.addEventListener('change', () => { draft.allowModel = consent.checked; });
  const importSchemas = button(message('biDocument.import'), 'schemas', () => perform(async () => {
    const result = await api.call('bi.schemas', { folder: folder.value.trim() });
    choose(result.choices);
    await loadSettings();
    setText(feedback, message('biDocument.imported', { count: result.count }));
  }));
  const importRepository = button(message('biBuilder.repository'), 'repository', () => perform(async () => {
    draw(await api.call('bi.repository', { folder: folder.value.trim(), allowModel: consent.checked,
      title: title.value.trim() || undefined }));
  }));
  const createWorkspace = button(message('biBuilder.createWorkspace'), 'create-workspace', () => perform(async () => selectWorkspace(await api.call('bi.create', {
    title: title.value.trim(), schema: schema.value, allowModel: consent.checked,
  }))));
  const importWorkspace = button(message('biBuilder.importWorkspace'), 'import-workspace', () => perform(async () => selectWorkspace(await api.call('bi.importdraft', {
    folder: folder.value.trim(), title: title.value.trim() || undefined, schema: schema.value, allowModel: consent.checked,
  }))));
  const browseWorkspace = button(message('biBuilder.workspaceCards'), 'workspace-cards', event => {
    const opener = event.currentTarget;
    void perform(async () => {
      const panel = openPanel('bi-working-draft', message('biBuilder.workspaceCards'), opener);
      await drawWorkspace(panel, await api.call('bi.workspace', { vault: selectedWorkspace() }));
    });
  });
  const prepareWorkspace = button(message('biBuilder.prepareWorkspace'), 'prepare-workspace', () => perform(async () => {
    const item = await api.call('bi.workspace', { vault: selectedWorkspace() });
    draw(await api.call('bi.prepareworkspace', { vault: item.id, version: item.version }));
  }));
  library.append(createWorkspace, importWorkspace, importRepository, browseWorkspace, prepareWorkspace);
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
  const mode = select('mode', { automatic: message('biBuilder.automatic'), step: message('biBuilder.step') });
  mode.value = draft.mode ?? 'automatic';
  mode.addEventListener('change', () => { draft.mode = mode.value; labelRun(); });
  const reader = select('reader', { auto: message('biBuilder.autoReader'), text: message('biBuilder.textReader'),
    html: message('biBuilder.htmlReader'), pdf: message('biBuilder.pdfReader'), image: message('biBuilder.imageReader') });
  const language = select('ocr-language', { auto: message('biOcr.language.auto'), 'en-US': message('biOcr.language.en-US'),
    'zh-Hant-TW': message('biOcr.language.zh-Hant-TW') });
  const ocrMode = select('ocr-mode', { auto: message('biOcr.mode.auto'), local: message('biOcr.mode.local-only'),
    model: message('biOcr.mode.model') });
  const pageReport = element('div', undefined, 'pages');
  const method = select('method', { model: message('biBuilder.modelMethod'), rules: message('biBuilder.rulesMethod') });
  const model = element('select', undefined, 'ingest-model');
  const duplicates = select('duplicates', { hold: message('biBuilder.holdDuplicates'), update: message('biBuilder.updateDuplicates') });
  const minEvidence = integer('min-evidence', 1, 100);
  const fieldRules = element('textarea', undefined, 'field-rules');
  fieldRules.rows = 3;
  fieldRules.maxLength = 12_000;
  const benchmarkName = element('input', undefined, 'benchmark-name');
  benchmarkName.maxLength = 80;
  const savedQuestions = element('select', undefined, 'saved-questions');
  savedQuestions.addEventListener('change', () => {
    if (!savedQuestions.value) return;
    void perform(async () => {
      const { settings, names } = await api.call('bi.questions', { schema: schema.value, name: savedQuestions.value });
      applySettings(settings, 'testing');
      drawQuestionSets(names);
    });
  });
  const questionSet = element('textarea', undefined, 'questions');
  questionSet.rows = 4;
  questionSet.maxLength = 22_000;
  const testModel = element('select', undefined, 'test-model');
  const threshold = integer('threshold', 1, 100);
  const evidenceChecks = check('evidence-checks');
  const inputs = {
    convert: () => ({ reader: reader.value, ocr: { language: language.value, mode: ocrMode.value } }),
    ingest: () => ({ method: method.value, model: model.value, duplicates: duplicates.value, minEvidence: minEvidence.valueAsNumber,
      labels: parseRules(fieldRules.value) }),
    testing: () => ({ name: benchmarkName.value.trim(), model: testModel.value, threshold: threshold.valueAsNumber,
      questions: parseQuestions(questionSet.value), evidenceChecks: evidenceChecks.checked }),
  };
  const save = stage => button(message('biBuilder.saveStage'), 'save-' + stage, () => perform(async () => {
    applySettings(await api.call('bi.configure', { schema: schema.value, stage, value: inputs[stage]() }), stage);
    if (stage === 'testing') drawQuestionSets((await api.call('bi.questions', { schema: schema.value })).names);
    setText(feedback, message('biBuilder.settingsSaved'));
  }));
  const saveConvert = save('convert');
  const saveIngest = save('ingest');
  const saveTesting = save('testing');
  const resume = () => perform(async () => { await watch(await api.call('bi.resume', { id: current.id })); });
  const ingestRun = button(message('biBuilder.runIngest'), 'run-ingest', resume);
  const testingRun = button(message('biBuilder.runTesting'), 'run-testing', resume);
  const inbox = element('details', undefined, 'inbox');
  const inboxTime = element('input', undefined, 'inbox-time');
  inboxTime.type = 'time';
  inboxTime.value = '09:00';
  const inboxZone = element('input', undefined, 'inbox-zone');
  inboxZone.maxLength = 100;
  inboxZone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inboxStatus = element('p', undefined, 'inbox-status');
  inboxStatus.setAttribute('role', 'status');
  const saveInbox = button(message('biBuilder.saveInbox'), 'inbox-save', () => perform(async () => {
    drawInbox(await api.call('bi.inboxschedule', {
      vault: selectedTarget()?.vault, zone: inboxZone.value.trim(), time: inboxTime.value,
    }));
  }));
  const pauseInbox = button(message('biBuilder.pauseInbox'), 'inbox-pause', () => perform(async () => {
    drawInbox(await api.call('bi.inboxstate', { state: inboxSchedule?.state === 'paused' ? 'active' : 'paused' }));
  }));
  inbox.append(element('summary', message('biBuilder.inboxSchedule')), element('p', message('biBuilder.inboxHint')), field(message('biBuilder.inboxTime'), inboxTime),
    field(message('biBuilder.inboxZone'), inboxZone), saveInbox, pauseInbox, inboxStatus);
  const details = button(message('biBuilder.details'), 'details', event => {
    panel = openPanel('bi-build-details', message('biBuilder.details'), event.currentTarget);
    panel.body.classList.add('bi-builder-details');
    drawPanel();
  });
  let panel;
  const consentLabel = element('label');
  consentLabel.append(consent, element('span', message('biDocument.allowModel')));
  areas[0].append(element('h3', steps[1]), field(message('biDocument.file'), file), field(message('biDocument.url'), url),
    field(message('biBuilder.reader'), reader), field(message('biOcr.language'), language), field(message('biOcr.mode'), ocrMode),
    element('p', message('biOcr.gateway')), saveConvert, field(message('biBuilder.mode'), mode), run, pageReport, inbox);
  bindFilePicker(file);
  const pickerButton = file.nextElementSibling.querySelector('button');
  areas[1].append(element('h3', steps[2]), field(message('biDocument.schema'), schema), importSchemas, field(message('biBuilder.method'), method),
    field(message('biBuilder.model'), model), field(message('biBuilder.fieldRules'), fieldRules), field(message('biBuilder.duplicates'), duplicates), field(message('biBuilder.minEvidence'), minEvidence),
    element('p', message('biDocument.gateway')), consentLabel, saveIngest, ingestRun);
  areas[2].append(element('h3', steps[3]), field(message('biBuilder.savedQuestions'), savedQuestions),
    field(message('biBuilder.questionSet'), benchmarkName), field(message('biBuilder.questions'), questionSet),
    field(message('biBuilder.model'), testModel), field(message('biBuilder.threshold'), threshold), field(message('biBuilder.evidenceChecks'), evidenceChecks), saveTesting, testingRun);
  const results = element('section');
  results.append(progressTitle, progress, feedback, details, validation, submit, review, produced,
    element('h3', message('biBuilder.history')), history);
  form.append(pipeline, library, ...areas, results);

  let current;
  let busy = false;
  let settings;
  let choices = [];
  let inboxSchedule;
  const ledger = new Map();

  function selectedTarget() { return choices.find(item => item.id === schema.value); }
  function selectedWorkspace() { return selectedTarget()?.working ? selectedTarget().vault : undefined; }

  function drawInbox(value) {
    inboxSchedule = value;
    if (value) {
      inboxTime.value = value.time;
      inboxZone.value = value.zone;
      setText(inboxStatus, inboxLabels[value.state]({
        time: value.time, zone: value.zone, title: choices.find(item => item.vault === value.target)?.title ?? value.target,
      }));
    } else setText(inboxStatus, message('biBuilder.inboxNone'));
    setText(pauseInbox, value?.state === 'paused' ? message('biBuilder.resumeInbox') : message('biBuilder.pauseInbox'));
    controls();
  }

  async function selectWorkspace({ workspace, choices }) {
    choose(choices);
    schema.value = draft.schema = workspace.choice;
    title.value = draft.title = workspace.title;
    await loadSettings();
    setText(feedback, message('biBuilder.workspaceReady', { title: workspace.title }));
  }

  async function drawWorkspace(panel, workspace) {
    if (panel.signal.aborted || signal.aborted) return;
    const body = panel.body;
    body.classList.add('bi-builder-details');
    body.replaceChildren(element('h3', workspace.title));
    if (!workspace.cards.length) body.append(element('p', message('biBuilder.emptyWorkspace')));
    if (workspace.conflicts) body.append(element('p', message('biBuilder.workspaceConflicts', { count: workspace.conflicts })));
    const load = async (offset, card) => drawWorkspace(panel, await api.call('bi.workspace', { vault: workspace.id, offset, card }));
    if (workspace.offset > 0) body.append(button(message('biBuilder.previousCards'), undefined, () => perform(() => load(workspace.offset - 100))));
    if (workspace.offset + workspace.cards.length < workspace.summary?.cards) {
      body.append(button(message('biBuilder.nextCards'), undefined, () => perform(() => load(workspace.offset + 100))));
    }
    const cards = element('select', undefined, 'workspace-card');
    cards.append(optionText(message('biBuilder.chooseCard'), ''), ...workspace.cards.map(card => optionText(card.title + ' · ' + card.type, card.id)));
    cards.value = workspace.card?.id ?? '';
    cards.addEventListener('change', () => { void perform(() => load(workspace.offset, cards.value || undefined)); });
    if (workspace.cards.length) body.append(field(message('biBuilder.workspaceCard'), cards));
    if (!workspace.card) return;
    const name = element('input', undefined, 'card-title');
    name.value = workspace.card.title;
    name.maxLength = 300;
    const fields = element('textarea', undefined, 'card-fields');
    fields.rows = 10;
    fields.maxLength = 32_000;
    fields.value = JSON.stringify(workspace.card.fields, null, 2);
    const status = element('p');
    status.setAttribute('role', 'status');
    const apply = button(message('biBuilder.saveCard'), 'save-card', () => perform(async () => {
      try {
        await api.call('bi.editworkspace', { vault: workspace.id, version: workspace.version, card: workspace.card.id,
          title: name.value.trim(), fields: JSON.parse(fields.value) });
        await load(workspace.offset, workspace.card.id);
        setText(panel.body.querySelector('[role=status]'), message('biBuilder.workspaceCardSaved'));
        panel.body.querySelector('#bi-builder-save-card').focus();
      } catch (error) { setText(status, errorText(error)); }
    }));
    body.append(field(message('biBuilder.cardTitle'), name), field(message('biBuilder.cardFields'), fields), element('p', message('biBuilder.editEvidence')), apply, status);
    name.focus();
  }

  function pairs(value) {
    return value.split('\n').filter(line => line.trim()).map(line => {
      const separator = line.indexOf(' = ');
      if (separator < 1 || !line.slice(0, separator).trim() || !line.slice(separator + 3).trim()) throw new Error(resolveText(message('biBuilder.lineFormat')));
      return [line.slice(0, separator).trim(), line.slice(separator + 3).trim()];
    });
  }

  const parseRules = value => Object.fromEntries(pairs(value));
  const parseQuestions = value => pairs(value).map(([question, answer]) => ({ question, expect: answer === '-' ? null : answer }));

  function applySettings(value, stage) {
    settings = value;
    if (!stage || stage === 'convert') {
      reader.value = value.convert.reader;
      language.value = value.convert.ocr.language;
      ocrMode.value = value.convert.ocr.mode;
    }
    if (!stage || stage === 'ingest') {
      method.value = value.ingest.method;
      model.value = value.ingest.model;
      duplicates.value = value.ingest.duplicates;
      minEvidence.value = value.ingest.minEvidence;
      fieldRules.value = Object.entries(value.ingest.labels).map(([key, label]) => key + ' = ' + label).join('\n');
    }
    if (!stage || stage === 'testing') {
      benchmarkName.value = value.testing.name;
      testModel.value = value.testing.model;
      threshold.value = value.testing.threshold;
      questionSet.value = value.testing.questions.map(({ question, expect }) => question + ' = ' + (expect ?? '-')).join('\n');
      evidenceChecks.checked = value.testing.evidenceChecks;
    }
  }

  function drawQuestionSets(names) {
    savedQuestions.replaceChildren(optionText(message('biBuilder.chooseQuestions'), ''), ...names.map(name => optionText(name, name)));
    savedQuestions.value = names.includes(settings.testing.name) ? settings.testing.name : '';
  }

  async function loadSettings() {
    const target = schema.value;
    const { settings, names } = await api.call('bi.questions', { schema: target });
    if (!signal.aborted && schema.value === target) {
      applySettings(settings);
      drawQuestionSets(names);
      controls();
    }
  }
  function choose(items) {
    choices = items;
    const previous = schema.value || draft.schema;
    schema.replaceChildren(...items.map(item => optionText(item.builtin && !item.vault.startsWith('bi-build-') ?
      message('biDocument.builtin') : item.title, item.id)));
    if (items.some(({ id }) => id === previous)) schema.value = previous;
  }

  function controls() {
    for (const input of form.querySelectorAll('input, select, textarea')) input.disabled = busy;
    for (const action of [pick, pickerButton, importSchemas, importRepository, ingestRun, testingRun]) action.disabled = busy;
    for (const save of [saveConvert, saveIngest, saveTesting, run]) save.disabled = busy || !schema.value || !settings;
    for (const action of [createWorkspace, importWorkspace, browseWorkspace, prepareWorkspace]) action.disabled = busy || !schema.value || !settings;
    browseWorkspace.hidden = prepareWorkspace.hidden = !selectedWorkspace();
    saveInbox.disabled = busy || !selectedTarget() || selectedTarget().vault.startsWith('bi-document-');
    pauseInbox.disabled = busy;
    pauseInbox.hidden = !inboxSchedule;
    ingestRun.hidden = current?.state !== 'converted';
    testingRun.hidden = current?.state !== 'ingested';
    details.disabled = !current;
    submit.disabled = busy;
    submit.hidden = current?.state !== 'validated' || current?.scheduled;
    review.hidden = !current?.reviewId;
    review.disabled = busy;
  }

  function labelRun() {
    const startLabel = mode.value === 'step' ? message('biBuilder.runConvert') : message('biBuilder.run');
    setText(run, current?.state === 'failed' || current?.state === 'needs-attention' ? message('biBuilder.retry') : startLabel);
  }

  function draw(result) {
    current = result;
    ledger.set(result.id, result);
    const state = result.reviewState || result.state;
    const index = { converting: 1, converted: 1, extracting: 2, ingested: 2, validating: 3, testing: 3, validated: 3, 'needs-attention': 3,
      'awaiting-review': 4, pending: 4, rejected: 4, approved: 5, published: 5 }[state] ?? 0;
    selectStep(index);
    progress.value = result.state === 'extracting' ? 35 + 35 * result.completedChunks / Math.max(1, result.totalChunks) :
      [0, 15, 35, 80, 90, 100][index];
    labelRun();
    const detail = result.issue ? biDocumentIssues[result.issue] : result.state === 'extracting' ?
      message('biDocument.progress', { completed: result.completedChunks, total: result.totalChunks }) :
      states[state] || states[result.state];
    setText(feedback, detail);
    pageReport.replaceChildren();
    if (result.pages?.length) {
      const list = element('ul');
      for (const page of result.pages) list.append(element('li', joinText([
        message('biOcr.page', { page: page.locator.split(':')[1], status: pageStates[page.status] }),
        page.ocr?.engine, pageWarnings[page.warning],
      ])));
      pageReport.append(element('p', result.source.title || result.source.ref), list);
    }
    validation.replaceChildren();
    if (result.repository) {
      const { digestVerified, sizeVerified, ...details } = result.repository;
      validation.append(element('p', message('biBuilder.repositoryReport', details)),
        element('p', digestVerified && sizeVerified ? message('biBuilder.repositoryVerified') : message('biBuilder.repositoryPartial')));
    }
    if (result.conversion) validation.append(element('p', message('biBuilder.convertedSegments', { count: result.conversion.segments })));
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
    if (result.benchmark) validation.append(element('p', benchmarkLabels[result.benchmark.state](result.benchmark)));
    setText(produced, result.summary ? message('biBuilder.summary', { title: result.title, revision: result.publication, ...result.summary }) : '');
    drawHistory();
    drawPanel();
    controls();
  }

  function drawPanel() {
    if (!panel || panel.signal.aborted || !current) return;
    const report = validation.cloneNode(true);
    report.removeAttribute('id');
    panel.body.replaceChildren(element('p', feedback.textContent), report);
    if (current.events?.length) {
      const log = element('ol');
      for (const { state, at } of current.events) log.append(element('li', () =>
        `${formatDate(new Date(at))()} · ${resolveText(states[state] ?? state)}`));
      panel.body.append(element('h3', message('jobs.run-history')), log);
    }
    for (const { locator, text, ocr } of current.conversion?.preview ?? []) {
      const excerpt = element('details');
      excerpt.append(element('summary', joinText([locator, ocr && message('biOcr.evidence', { engine: ocr.engine })])), element('p', text));
      panel.body.append(excerpt);
    }
    for (const row of current.benchmark?.results ?? []) {
      const question = element('details');
      question.append(element('summary', row.question), element('p', row.passed ?
        message('biBuilder.questionPassed') : message('biBuilder.questionFailed')));
      for (const citation of row.citations ?? []) question.append(element('p', citation.locator + ' · ' + citation.quote));
      panel.body.append(question);
    }
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
    const params = { schema: schema.value, mode: mode.value, allowModel: consent.checked,
      title: selectedWorkspace() ? undefined : title.value.trim() || undefined,
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
    const { choices, runs, aliases, modelNotes } = await api.call('bi.catalog');
    for (const input of [model, testModel]) input.replaceChildren(optionText(message('biBuilder.defaultModel'), ''),
      ...aliases.map(alias => gatewayModelOption(alias, modelNotes)));
    choose(choices);
    await loadSettings();
    labelRun();
    drawInbox(await api.call('bi.inbox'));
    for (const item of [...runs].reverse()) ledger.set(item.id, item);
    drawHistory();
    if (runs.length) await watch(await api.call('bi.status', { id: runs[0].id }));
  });
}
