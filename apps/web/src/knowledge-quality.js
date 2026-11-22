import { message, optionText, setText, t } from './i18n.js';
import { errorText, modelLabel, request, sampleKnowledgeID } from './api.js';

const find = (id) => document.getElementById(id);
const kinds = { answerable: message('ui.answerable'), 'no-evidence': message('ui.missing-evidence'), conflict: message('ui.conflicting-evidence'), injection: message('ui.contains-injected-instructions') };
function node(tag, text) {
  const element = document.createElement(tag);
  setText(element, text ?? '');
  return element;
}
function button(text, work) {
  const element = node('button', text);
  element.type = 'button';
  element.onclick = work;
  return element;
}

export function bindKnowledgeQuality(openPassage, messages) {
  const sets = find('quality-sets');
  const aliases = find('quality-aliases');
  const editor = find('quality-editor');
  const status = find('quality-status');
  const run = find('quality-run');
  const stop = find('quality-stop');
  const actions = find('quality-actions');
  const results = find('quality-results');
  const rows = find('quality-questions');
  const json = find('quality-json');
  const evidence = find('quality-evidence');
  const matches = find('quality-matches');
  let selected;
  let catalog = [];
  const preferredSets = new Map();
  let loading;
  let running;
  let saving = false;
  let picked = [];
  let editing;

  const current = () => catalog.find(({ name }) => name === sets.value);
  const setRequest = (data, signal) => request('/api/knowledge/benchmarks', { data: { vault: selected.id, ...data }, signal });

  function render() {
    const set = current();
    actions.hidden = !catalog.length;
    editor.hidden = !set || set.builtIn;
    find('quality-remove-set').disabled = !set || set.builtIn;
    find('quality-import').disabled = !set || set.builtIn;
    find('quality-builtin-note').hidden = !set?.builtIn || selected?.id === sampleKnowledgeID;
    run.disabled = !set?.questions.length || !selected?.modelEnabled || (set.builtIn && selected.id !== sampleKnowledgeID);
    rows.replaceChildren();
    if (!set) return;
    for (const question of set.questions) {
      const row = node('li', question.query + ' · ' + kinds[question.class]);
      if (!set.builtIn) {
        row.append(' ', button(message('jobs.edit'), () => openEditor(question)), ' ', button(message('chat.delete'), () => {
          if (confirm(t('quality.delete-this-question'))) void save(set.questions.filter(({ id }) => id !== question.id));
        }));
      }
      rows.append(row);
    }
    if (!set.questions.length) rows.append(node('li', message('quality.add-a-question-to-get-started')));
    openEditor();
  }

  function openEditor(question) {
    editing = question?.id;
    editor.reset();
    editor.elements.query.value = question?.query ?? '';
    editor.elements.answer.value = question?.answer ?? '';
    editor.elements.kind.value = question?.class ?? 'answerable';
    picked = [...(question?.evidence ?? [])];
    matches.replaceChildren();
    renderEvidence();
    if (question) editor.elements.query.focus();
  }
  function renderEvidence() {
    evidence.replaceChildren(...picked.map((id) => button(id + ' ×', () => {
      picked = picked.filter((item) => item !== id);
      renderEvidence();
    })));
  }

  async function refresh(preferred) {
    loading?.abort();
    const active = loading = new AbortController();
    setText(status, selected ? message('quality.loading-question-sets') : message('quality.use-build-to-import-a-knowledge-base'));
    catalog = [];
    render();
    if (!selected) return;
    try {
      const data = await setRequest({}, active.signal);
      if (active.signal.aborted) return;
      catalog = data.sets;
      sets.replaceChildren(...catalog.map(({ name, builtIn }) => optionText(builtIn ? message('quality.standard-question-set') : name, name)));
      if (catalog.some(({ name }) => name === preferred)) sets.value = preferred;
      aliases.replaceChildren(...data.aliases.map((alias) => optionText(modelLabel(alias), alias)));
      setText(status, selected.modelEnabled ? '' : message('quality.model-access-is-disabled-for-this-release'));
      render();
    } catch {
      if (!active.signal.aborted) setText(status, message('quality.could-not-load-question-sets-select-the'));
    }
  }

  async function save(questions, name = sets.value) {
    if (!selected || !name || saving || running) return;
    const vault = selected;
    saving = true;
    actions.inert = true;
    try {
      await setRequest({ name, questions });
      if (questions === null) preferredSets.delete(vault.id);
      else preferredSets.set(vault.id, name);
      if (selected?.id === vault.id) await refresh(preferredSets.get(vault.id));
    } catch (error) {
      if (selected === vault) setText(status, errorText(error));
    } finally {
      saving = false;
      actions.inert = false;
    }
  }

  sets.onchange = () => { preferredSets.set(selected.id, sets.value); results.replaceChildren(); render(); };
  find('quality-add-set').onsubmit = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    if (!name) return;
    if (catalog.some((set) => set.name === name)) setText(status, message('quality.a-question-set-already-uses-that-name'));
    else {
      form.reset();
      void save([], name);
    }
  };
  find('quality-remove-set').onclick = () => { if (confirm(t('quality.delete-this-question-set'))) void save(null); };
  find('quality-export').onclick = () => {
    json.value = JSON.stringify(current()?.questions ?? [], null, 2);
    const url = URL.createObjectURL(new Blob([json.value], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = 'oep-benchmark.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  find('quality-json-file').onchange = async (event) => {
    const input = event.currentTarget;
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 120 * 1024) {
      setText(status, message('quality.this-question-set-file-is-too-large'));
      return;
    }
    const set = current();
    try {
      const text = await file.text();
      if (current() === set) json.value = text;
    } catch { setText(status, message('quality.could-not-read-the-question-set-file')); }
  };
  find('quality-import').onclick = () => {
    try { void save(JSON.parse(json.value)); }
    catch { setText(status, message('quality.could-not-import-the-question-set-check')); }
  };

  find('quality-find').onclick = async () => {
    const query = editor.elements.passages.value.trim();
    if (!query || !selected) return;
    const vault = selected;
    const set = current();
    const id = editing;
    try {
      const data = await request('/api/knowledge/browse', { data: { vault: vault.id, query } });
      if (selected !== vault || current() !== set || editing !== id) return;
      matches.replaceChildren();
      if (!data.passages.length) matches.append(node('p', message('quality.no-passages-found')));
      for (const passage of data.passages) {
        const row = node('li');
        row.append(button(message('quality.select-evidence'), () => {
          if (!picked.includes(passage.id) && picked.length < 10) picked.push(passage.id);
          renderEvidence();
        }), ' ', button(passage.source + ' · ' + passage.locator, (event) => openPassage(passage, '', event.currentTarget)), node('p', passage.text.slice(0, 200)));
        matches.append(row);
      }
    } catch { setText(status, message('quality.could-not-search-passages-try-again')); }
  };

  find('quality-new-question').onclick = () => { openEditor(); editor.elements.query.focus(); };
  editor.onsubmit = (event) => {
    event.preventDefault();
    const set = current();
    if (!set || set.builtIn) return;
    const question = { id: editing ?? crypto.randomUUID(), query: editor.elements.query.value,
      answer: editor.elements.answer.value || null, class: editor.elements.kind.value, evidence: picked };
    if (question.class === 'answerable' && (!question.answer?.trim() || !question.evidence.length)) {
      setText(status, message('quality.answerable-questions-require-an-expected-answer-and'));
      return;
    }
    void save(editing ? set.questions.map((row) => row.id === editing ? question : row) : [...set.questions, question]);
  };

  stop.onclick = () => running?.abort();
  run.onclick = async () => {
    if (running || saving || run.disabled) return;
    const active = running = new AbortController();
    const { id: vault, revision } = selected;
    const { name, questions, builtIn } = current();
    const recallTarget = builtIn ? 1 : 0.85;
    const alias = aliases.value;
    run.disabled = true;
    sets.disabled = true;
    stop.disabled = false;
    editor.inert = rows.inert = true;
    find('quality-set-actions').inert = true;
    const title = node('p');
    const thresholds = node('details');
    thresholds.hidden = true;
    const metrics = node('p');
    thresholds.append(node('summary', message('quality.advanced-scoring')), metrics);
    const table = node('table');
    const header = table.createTHead().insertRow();
    for (const text of [message('ui.questions'), message('quality.status'), message('chat.available'), message('quality.citations-reproduced'), message('quality.duration')]) header.append(node('th', text));
    const body = table.createTBody();
    results.replaceChildren(title, table, thresholds);
    const pending = questions.map((question) => ({ question, row: body.insertRow() }));
    for (const { question, row } of pending) {
      setText(row.insertCell(), question.query);
      setText(row.insertCell(), message('quality.queued-to-run'));
    }
    const totals = { recall: 0, done: 0, usable: 0, refused: 0, citations: 0, reproduced: 0, unsupported: 0, errors: 0 };
    let index = 0;
    const answerable = questions.filter((question) => question.class === 'answerable').length;
    const unanswerable = questions.length - answerable;
    setText(title, message('quality.running-done-total', { done: 0, total: questions.length }));
    async function worker() {
      while (!active.signal.aborted && index < pending.length) {
        const { question, row } = pending[index++];
        setText(row.cells[1], message('chat.running'));
        try {
          const report = await request('/api/knowledge/benchmark-question', {
            data: { vault, revision, alias, name, id: question.id }, signal: active.signal,
          });
          if (active.signal.aborted) return;
          const { result, usable, abstained, unsupported, reproducible, recall, citations, elapsedMs } = report;
          totals.recall += recall ?? 0;
          totals.usable += Number(usable);
          totals.refused += Number(abstained);
          totals.unsupported += Number(unsupported);
          totals.errors += Number(result.state === 'error');
          totals.citations += citations;
          totals.reproduced += reproducible;
          const details = node('details');
          details.append(node('summary', result.state === 'verified' ? message('quality.answered') : result.state === 'abstain' ? message('quality.refused') : message('chat.failed')));
          details.append(node('p', usable || abstained ? message('quality.met-expectations') :
            result.state === 'verified' ? message('quality.the-answer-or-citations-differed-from-expectations') : message('quality.the-expected-answer-was-missing')));
          if (result.reason) details.append(node('p', messages[result.reason] ?? message('quality.could-not-complete-this-query')));
          if (question.answer) details.append(node('p', message('quality.expected-answer', { answer: question.answer })));
          if (result.answer) details.append(node('p', message('quality.actual-answer', { answer: result.answer })));
          for (const citation of result.citations ?? []) details.append(button(citation.source + ' · ' + citation.locator,
            (event) => openPassage({ ...citation, text: citation.context }, citation.quote, event.currentTarget)));
          row.cells[1].replaceChildren(details);
          setText(row.insertCell(), usable || abstained ? message('cards.yes') : message('cards.no'));
          setText(row.insertCell(), citations ? reproducible + '／' + citations : '—');
          setText(row.insertCell(), elapsedMs + ' ms');
        } catch (error) {
          if (active.signal.aborted) return;
          totals.errors++;
          setText(row.cells[1], errorText(error));
        }
        setText(title, message('quality.running-done-total', { done: ++totals.done, total: questions.length }));
      }
    }
    await Promise.all([worker(), worker()]);
    if (running !== active) return;
    running = undefined;
    const meets = answerable > 0 && unanswerable > 0 && totals.citations > 0 && totals.usable / answerable >= 0.9 &&
      totals.refused / unanswerable >= 0.95 && totals.recall / answerable >= recallTarget && totals.citations === totals.reproduced && totals.unsupported === 0 && totals.errors === 0;
    setText(title, active.signal.aborted ? message('quality.canceled-completed-done-total', { done: totals.done, total: questions.length }) :
      meets ? message('quality.question-set-passed') : message('quality.question-set-failed'));
    thresholds.hidden = active.signal.aborted;
    setText(metrics, message('quality.d03-result-top-five-evidence-recall-recall', { result: meets ? message('quality.passed') : message('quality.failed'), recall: answerable ? (100 * totals.recall / answerable).toFixed(0) + '%' : '—', target: recallTarget * 100, usable: totals.usable, answerable, refused: totals.refused, unanswerable, reproduced: totals.reproduced, citations: totals.citations, unsupported: totals.unsupported }));
    if (active.signal.aborted) {
      for (const { row } of pending) if (row.cells[1].textContent === t('chat.running') || row.cells[1].textContent === t('quality.queued-to-run')) setText(row.cells[1], message('quality.canceled'));
    }
    sets.disabled = false;
    editor.inert = rows.inert = false;
    find('quality-set-actions').inert = false;
    stop.disabled = true;
    run.disabled = false;
  };

  return {
    select(vault) {
      running?.abort();
      running = undefined;
      selected = vault;
      sets.disabled = false;
      editor.inert = rows.inert = false;
      find('quality-set-actions').inert = false;
      stop.disabled = true;
      results.replaceChildren();
      void refresh(vault && preferredSets.get(vault.id));
    },
  };
}
