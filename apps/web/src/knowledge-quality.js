import { modelLabel, request } from './api.js';

const find = (id) => document.getElementById(id);
const kinds = { answerable: '可回答', 'no-evidence': '缺乏證據', conflict: '證據衝突', injection: '含注入指令' };
function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text ?? '';
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
    find('quality-builtin-note').hidden = !set?.builtIn || selected?.id === 'oep-synthetic-demo';
    run.disabled = !set?.questions.length || !selected?.modelEnabled || (set.builtIn && selected.id !== 'oep-synthetic-demo');
    rows.replaceChildren();
    if (!set) return;
    for (const question of set.questions) {
      const row = node('li', question.query + ' · ' + kinds[question.class]);
      if (!set.builtIn) {
        row.append(' ', button('編輯', () => openEditor(question)), ' ', button('刪除', () => {
          if (confirm('要刪除這道題目嗎？')) void save(set.questions.filter(({ id }) => id !== question.id));
        }));
      }
      rows.append(row);
    }
    if (!set.questions.length) rows.append(node('li', '請新增題目。'));
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
    status.textContent = selected ? '正在讀取題集。' : '請先在建置中匯入知識庫。';
    catalog = [];
    render();
    if (!selected) return;
    try {
      const data = await setRequest({}, active.signal);
      if (active.signal.aborted) return;
      catalog = data.sets;
      sets.replaceChildren(...catalog.map(({ name }) => new Option(name, name)));
      if (catalog.some(({ name }) => name === preferred)) sets.value = preferred;
      aliases.replaceChildren(...data.aliases.map((alias) => new Option(modelLabel(alias), alias)));
      status.textContent = selected.modelEnabled ? '' : '此發布版本尚未授權使用模型。';
      render();
    } catch {
      if (!active.signal.aborted) status.textContent = '無法讀取題集。';
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
      if (selected === vault) status.textContent = error.message;
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
    if (catalog.some((set) => set.name === name)) status.textContent = '已有同名題集。';
    else {
      form.reset();
      void save([], name);
    }
  };
  find('quality-remove-set').onclick = () => { if (confirm('要刪除此題集嗎？')) void save(null); };
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
      status.textContent = '題集 JSON 檔案太大。';
      return;
    }
    const set = current();
    try {
      const text = await file.text();
      if (current() === set) json.value = text;
    } catch { status.textContent = '無法讀取題集 JSON。'; }
  };
  find('quality-import').onclick = () => {
    try { void save(JSON.parse(json.value)); }
    catch { status.textContent = '請輸入有效的 JSON 題集。'; }
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
      if (!data.passages.length) matches.append(node('p', '找不到段落。'));
      for (const passage of data.passages) {
        const row = node('li');
        row.append(button('選取證據', () => {
          if (!picked.includes(passage.id) && picked.length < 10) picked.push(passage.id);
          renderEvidence();
        }), ' ', button(passage.source + ' · ' + passage.locator, () => openPassage(passage)), node('p', passage.text.slice(0, 200)));
        matches.append(row);
      }
    } catch { status.textContent = '無法搜尋段落。'; }
  };

  find('quality-new-question').onclick = () => { openEditor(); editor.elements.query.focus(); };
  editor.onsubmit = (event) => {
    event.preventDefault();
    const set = current();
    if (!set || set.builtIn) return;
    const question = { id: editing ?? crypto.randomUUID(), query: editor.elements.query.value,
      answer: editor.elements.answer.value || null, class: editor.elements.kind.value, evidence: picked };
    if (question.class === 'answerable' && (!question.answer?.trim() || !question.evidence.length)) {
      status.textContent = '可回答題目需要預期答案與證據。';
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
    const table = node('table');
    const header = table.createTHead().insertRow();
    for (const text of ['題目', '狀態', '可用', '引用重現', '耗時']) header.append(node('th', text));
    const body = table.createTBody();
    results.replaceChildren(title, table);
    const pending = questions.map((question) => ({ question, row: body.insertRow() }));
    for (const { question, row } of pending) {
      row.insertCell().textContent = question.query;
      row.insertCell().textContent = '待執行';
    }
    const totals = { recall: 0, done: 0, usable: 0, refused: 0, citations: 0, reproduced: 0, unsupported: 0, errors: 0 };
    let index = 0;
    const answerable = questions.filter((question) => question.class === 'answerable').length;
    const unanswerable = questions.length - answerable;
    title.textContent = `執行中 · 0／${questions.length}`;
    async function worker() {
      while (!active.signal.aborted && index < pending.length) {
        const { question, row } = pending[index++];
        row.cells[1].textContent = '執行中';
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
          details.append(node('summary', result.state === 'verified' ? '已回答' : result.state === 'abstain' ? '已拒答' : '失敗'));
          details.append(node('p', usable || abstained ? '符合預期。' :
            result.state === 'verified' ? '答案或引用與預期不符。' : '未取得預期答案。'));
          if (result.reason) details.append(node('p', messages[result.reason] ?? '本次詢問無法完成。'));
          if (question.answer) details.append(node('p', '預期：' + question.answer));
          if (result.answer) details.append(node('p', '實際：' + result.answer));
          for (const citation of result.citations ?? []) details.append(button(citation.source + ' · ' + citation.locator,
            () => openPassage({ ...citation, text: citation.context }, citation.quote)));
          row.cells[1].replaceChildren(details);
          row.insertCell().textContent = usable || abstained ? '是' : '否';
          row.insertCell().textContent = citations ? reproducible + '／' + citations : '—';
          row.insertCell().textContent = elapsedMs + ' ms';
        } catch (error) {
          if (active.signal.aborted) return;
          totals.errors++;
          row.cells[1].textContent = error.message;
        }
        title.textContent = `執行中 · ${++totals.done}／${questions.length}`;
      }
    }
    await Promise.all([worker(), worker()]);
    if (running !== active) return;
    running = undefined;
    const meets = answerable > 0 && unanswerable > 0 && totals.citations > 0 && totals.usable / answerable >= 0.9 &&
      totals.refused / unanswerable >= 0.95 && totals.recall / answerable >= recallTarget && totals.citations === totals.reproduced && totals.unsupported === 0 && totals.errors === 0;
    title.textContent = active.signal.aborted ? `已取消 · 完成 ${totals.done}／${questions.length}` :
      `D03 ${meets ? '通過' : '未通過'} · 前五段證據召回率 ${answerable ? (100 * totals.recall / answerable).toFixed(0) + '%' : '—'}（≥${recallTarget * 100}%） · 可答可用 ${totals.usable}／${answerable}（≥90%） · 不可答拒答 ${totals.refused}／${unanswerable}（≥95%） · 引用重現 ${totals.reproduced}／${totals.citations}（100%） · 關鍵無證據答案 ${totals.unsupported}（0）`;
    if (active.signal.aborted) {
      for (const { row } of pending) if (row.cells[1].textContent === '執行中' || row.cells[1].textContent === '待執行') row.cells[1].textContent = '已取消';
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
