import { request, sampleKnowledgeID } from './api.js';

const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
};

function inputLabel(parent, text, tag = 'input') {
  const label = element('label', text);
  const input = element(tag);
  label.append(input);
  parent.append(label);
  return input;
}

const statuses = { pending: '待審核', approved: '已核准', rejected: '已拒絕', discarded: '已捨棄' };

function advanced(parent) {
  const fold = element('details');
  fold.append(element('summary', '進階'));
  parent.append(fold);
  return fold;
}

function showComparison(parent, { previous, candidate }) {
  parent.replaceChildren();
  const before = new Map(previous?.cards.map((card) => [card.id, card]));
  const after = new Map(candidate.cards.map((card) => [card.id, card]));
  const counts = { added: 0, changed: 0, removed: 0, fields: 0 };
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const next = after.get(id);
    const oldValues = old ? { '標題': old.title, '類型': old.type, '識別鍵': old.key, '版本': old.version, ...old.fields } : {};
    const newValues = next ? { '標題': next.title, '類型': next.type, '識別鍵': next.key, '版本': next.version, ...next.fields } : {};
    const changes = element('ul');
    const technical = element('ul');
    const display = (value) => typeof value === 'string' ? value : value === undefined ? '（無）' : JSON.stringify(value);
    for (const field of new Set([...Object.keys(oldValues), ...Object.keys(newValues)])) {
      if (JSON.stringify(oldValues[field]) === JSON.stringify(newValues[field])) continue;
      const list = ['類型', '識別鍵', '版本'].includes(field) ? technical : changes;
      list.append(element('li', field + ' · ' + display(oldValues[field]) + ' → ' + display(newValues[field])));
      counts.fields++;
    }
    if (!changes.childElementCount && !technical.childElementCount) continue;
    const state = !old ? 'added' : !next ? 'removed' : 'changed';
    counts[state]++;
    parent.append(element('h4', { added: '新增', removed: '移除', changed: '變更' }[state] + ' · ' + (next ?? old).title));
    if (changes.childElementCount) parent.append(changes);
    if (technical.childElementCount) advanced(parent).append(technical);
  }
  parent.prepend(element('p', '新增 ' + counts.added + ' · 變更 ' + counts.changed + ' · 移除 ' + counts.removed + ' · 欄位 ' + counts.fields));
  const evidence = element('div');
  evidence.append(element('h3', '證據 · ' + candidate.passages.length + ' 則'));
  const oldPassages = new Map(previous?.passages.map((item) => [item.id, item]));
  const sources = new Map(candidate.sources.map((item) => [item.id, item.ref]));
  for (const item of candidate.passages) {
    if (JSON.stringify(item) === JSON.stringify(oldPassages.get(item.id))) continue;
    evidence.append(element('p', sources.get(item.sourceId)), element('blockquote', item.text));
    if (item.locator) advanced(evidence).append(element('p', item.locator));
  }
  parent.append(evidence);
}

export function bindReview(anchor, onPublish, openPreview) {
  const endpoint = '/api/knowledge/reviews';
  const refreshers = [];
  const queueStatus = document.getElementById('review-status');
  for (const kind of ['bi', 'wiki']) {
    const panel = element('details');
    panel.id = kind === 'bi' ? 'ingest-review' : 'wiki-review';
    panel.append(element('summary', kind === 'bi' ? '從來源建立卡片' : '從來源建立文章'));
    anchor.after(panel);
    const vault = inputLabel(panel, '知識庫代號');
    const vaultChoices = element('datalist');
    vaultChoices.id = panel.id + '-vaults';
    vault.setAttribute('list', vaultChoices.id);
    panel.append(vaultChoices);
    const schemaOptions = advanced(panel);
    const version = inputLabel(schemaOptions, 'Schema 版本');
    const fields = kind === 'bi' ? inputLabel(schemaOptions, '必要欄位（逗號分隔）') : null;
    const source = inputLabel(panel, '選擇文字檔');
    source.type = 'file';
    source.accept = '.txt,.md,.markdown';
    const pasted = inputLabel(panel, '或貼上來源文字', 'textarea');
    const sourceContent = element('div');
    const sourceText = inputLabel(sourceContent, '來源預覽（選取文字可作為引文）', 'textarea');
    sourceText.readOnly = true;
    const cardList = element('div');
    panel.append(cardList);
    const candidate = inputLabel(advanced(panel), '候選 JSON', 'textarea');
    candidate.rows = 12;
    const status = element('p');
    status.setAttribute('role', 'status');
    const pending = document.getElementById(`review-${kind}-pending`);
    const history = document.getElementById(`review-${kind}-history`);

    function button(parent, label, work, feedback = status) {
      const control = element('button', label);
      control.type = 'button';
      control.addEventListener('click', async () => {
        control.disabled = true;
        feedback.textContent = '';
        try { await work(); }
        catch (error) { feedback.textContent = /[\u3400-\u9fff]/.test(error.message) ? error.message : '操作失敗。請檢查輸入後再試一次。'; }
        finally { control.disabled = false; }
      });
      parent.append(control);
      return control;
    }

    const submit = (data) => request(endpoint, { data });
    let base;
    let baseVaultId;
    let cardForms = [];
    let sourceRef;
    let sourceOriginal;
    function addCard(existing) {
      const group = element('fieldset');
      group.append(element('legend', existing ? existing.title : '新增卡片'));
      const operation = inputLabel(group, '操作', 'select');
      for (const [value, text] of existing ? [['keep', '保留'], ['update', '變更'], ['remove', '移除']] : [['add', '新增'], ['keep', '略過']]) {
        const option = element('option', text);
        option.value = value;
        operation.append(option);
      }
      const details = element('div');
      group.append(details);
      const title = inputLabel(details, '卡片標題');
      title.value = existing?.title ?? '';
      const entries = base.schema.document.fields.map((field) => {
        const value = inputLabel(details, field);
        value.value = existing?.fields[field] ?? '';
        const quote = inputLabel(details, field + '引文', 'textarea');
        button(details, field + '採用選取文字', () => {
          quote.value = sourceText.value.slice(sourceText.selectionStart, sourceText.selectionEnd);
        });
        return { field, value, quote };
      });
      const toggle = () => { details.hidden = !['update', 'add'].includes(operation.value); };
      toggle();
      operation.addEventListener('change', toggle);
      cardList.append(group);
      cardForms.push({ existing, operation, title, entries });
    }

    function setBase(next) {
      base = next;
      baseVaultId = vault.value;
      cardForms = [];
      cardList.replaceChildren();
      if (kind === 'bi') {
        button(cardList, '新增卡片', () => addCard());
        for (const card of base.cards) addCard(card);
      }
    }

    const previews = new Map();
    let reviewRows = new Map();

    function openReview(id, opener, title) {
      const row = reviewRows.get(id);
      if (!row) return;
      const tab = openPreview('review-' + id, title ?? row.vault, opener);
      if (!previews.has(id)) {
        const draw = () => drawReview(tab, reviewRows.get(id), id);
        previews.set(id, draw);
        tab.signal.addEventListener('abort', () => previews.delete(id), { once: true });
        draw();
      }
    }

    function drawReview(tab, row, id) {
      const { body, signal } = tab;
      body.replaceChildren();
      if (!row) { body.append(element('p', '無法開啟這筆審核。請重新整理審核清單。')); return; }
      const draft = JSON.parse(row.draft);
      const heading = element('p', displayedState(row));
      heading.tabIndex = -1;
      const metadata = advanced(body);
      metadata.append(element('p', '審核代號 ' + id), element('p', '前一版本 ' + (row.parent ?? '無')));
      if (row.publication) metadata.append(element('p', '發布版本 ' + row.publication));
      const editor = inputLabel(metadata, '審核草稿（JSON）', 'textarea');
      editor.rows = 12;
      editor.value = JSON.stringify(draft, null, 2);
      editor.readOnly = row.status !== 'pending';
      const feedback = element('p');
      feedback.setAttribute('role', 'status');
      const controls = element('div');
      controls.className = 'review-actions';
      const comparison = element('div');
      body.prepend(heading, feedback, controls);
      body.append(comparison);

      const action = (name, label, extra = () => ({}), parent = controls) => button(parent, label, async () => {
        await submit({ action: name, id, edit: row.edit, ...extra() });
        await refresh();
        if (['publish', 'rollback', 'reactivate'].includes(name)) await onPublish();
        if (!signal.aborted && !feedback.isConnected && !document.activeElement.closest('#chat-files')) {
          body.firstElementChild?.focus({ preventScroll: true });
        }
      }, feedback);

      let comparisonRequest = 0;
      async function compare() {
        const sequence = ++comparisonRequest;
        const result = await submit({ action: 'compare', id });
        if (!signal.aborted && comparison.isConnected && sequence === comparisonRequest) showComparison(comparison, result);
      }
      if (row.status === 'pending' || row.status === 'approved') {
        button(controls, '比較版本與證據', compare, feedback);
        comparison.textContent = '正在讀取版本與證據…';
        compare().catch(() => { comparison.textContent = '無法讀取版本與證據。請再按一次「比較版本與證據」。'; });
        if (kind === 'wiki') {
          const trial = inputLabel(controls, '草稿證據搜尋');
          button(controls, '搜尋草稿', async () => {
            const query = trial.value.trim().toLowerCase();
            if (!query) throw new Error('請輸入搜尋文字。');
            const sequence = ++comparisonRequest;
            const { candidate } = await submit({ action: 'compare', id });
            if (signal.aborted || sequence !== comparisonRequest) return;
            const hits = candidate.passages.filter(({ text }) => text.toLowerCase().includes(query));
            comparison.replaceChildren(...hits.map(({ locator, text }) => {
              const passage = element('div');
              passage.append(element('p', locator), element('blockquote', text));
              return passage;
            }));
            if (!hits.length) comparison.textContent = '草稿中找不到相符的證據。';
          }, feedback);
        }
      }
      if (row.status === 'pending') {
        action('edit', '儲存修訂', () => ({ draft: JSON.parse(editor.value) }), metadata);
        action('approve', '核准', () => {
          if (JSON.stringify(JSON.parse(editor.value)) !== JSON.stringify(draft)) throw new Error('請先儲存草稿。');
          return {};
        });
        action('reject', '拒絕');
        if (kind === 'wiki') action('discard', '捨棄草稿');
      } else if (row.publication && (row.active || row.inactive)) {
        const more = element('details');
        more.className = 'feature-more';
        more.append(element('summary', '更多'));
        controls.append(more);
        if (row.active) action('rollback', '回復前一版本', undefined, more);
        if (row.inactive) action('reactivate', '重新啟用', undefined, more);
      } else if (row.status === 'approved' && !row.publication) action('publish', '發布');
    }

    function displayedState(row) {
      return row.inactive ? '已停用' : row.publication ? '已發布' : statuses[row.status];
    }

    let refreshSequence = 0;
    async function refresh() {
      const sequence = ++refreshSequence;
      const [{ reviews, jobs }, { vaults }] = await Promise.all([request(endpoint), request('/api/knowledge/vaults')]);
      if (sequence !== refreshSequence) return;
      vaultChoices.replaceChildren(...vaults.filter((item) => item.kind === kind && item.id !== sampleKnowledgeID).map((item) => {
        const option = element('option', item.title);
        option.value = item.id;
        return option;
      }));
      const before = reviewRows;
      reviewRows = new Map();
      pending.replaceChildren();
      history.replaceChildren();
      for (const row of reviews) {
        const draft = JSON.parse(row.draft);
        if (draft.vault.kind !== kind) continue;
        reviewRows.set(row.id, row);
        const item = element('li');
        const name = draft.vault.title || row.vault;
        const entry = button(item, name, () => openReview(row.id, entry, name), queueStatus);
        entry.dataset.featureFocus = 'review-' + row.id;
        const subject = (draft.cards ?? draft.addCards)?.[0]?.title || draft.updateCards?.[0]?.title || draft.sources?.[0]?.ref;
        item.append(element('small', [displayedState(row), subject].filter(Boolean).join(' · ')));
        (row.status === 'pending' || row.status === 'approved' && !row.publication ? pending : history).append(item);
      }
      if (!pending.childElementCount) pending.append(element('li', '目前沒有待處理的草稿。'));
      if (!history.childElementCount) history.append(element('li', '目前沒有審核紀錄。'));
      if (kind === 'bi') {
        const work = document.getElementById('review-import-jobs');
        work.replaceChildren();
        for (const job of jobs) {
          const jobState = job.completed ? '已送審' : job.expires > Date.now() ? '執行中' : '待執行';
          const item = element('li');
          const details = advanced(item);
          details.append(element('p', job.id));
          item.prepend(element('p', jobState));
          if (!job.completed) button(item, '立即執行', async () => {
            await submit({ action: 'run', id: job.id });
            await refresh();
          }, queueStatus);
          work.append(item);
        }
        work.parentElement.hidden = !jobs.length;
      }
      for (const [id, draw] of previews) {
        if (JSON.stringify(before.get(id)) !== JSON.stringify(reviewRows.get(id))) draw();
      }
    }
    refreshers.push(refresh);

    button(schemaOptions, '安裝 Schema 並建立草稿範本', async () => {
      const names = fields ? fields.value.split(',').map((value) => value.trim()).filter(Boolean) : [];
      const schema = await submit({ action: 'schema', vault: vault.value, schema: 'local-' + kind, version: version.value, fields: names });
      setBase(await submit({ action: 'base', vault: vault.value }));
      const text = sourceOriginal ?? '';
      candidate.value = JSON.stringify({
        vault: { id: vault.value, title: vault.value, kind },
        schema: schema.sha256,
        sources: [{ id: 'source', ref: sourceRef ?? '來源.txt', original: text, markdown: text }],
        cards: kind === 'bi' ? [{ id: 'card', type: 'record', key: 'card', title: '', version: '1',
          fields: Object.fromEntries(names.map((name) => [name, text])) }] : [],
        relationships: [],
        evidence: kind === 'bi' ? names.map((field) => ({ sourceId: 'source', cardId: 'card', field, start: 0, end: text.length }))
          : [{ sourceId: 'source', start: 0, end: text.length }],
      }, null, 2);
    });
    button(panel, '載入既有知識庫', async () => {
      setBase(await submit({ action: 'base', vault: vault.value }));
      version.value = base.schema.version;
      if (fields) fields.value = base.schema.document.fields.join(', ');
      status.textContent = '已載入知識庫。';
    });
    function showSourcePreview(opener) {
      const { body } = openPreview(`build-source-${kind}`, '來源文字', opener);
      if (!body.contains(sourceContent)) body.append(sourceContent);
    }
    const showSource = button(panel, '查看來源文字', () => showSourcePreview(showSource));
    showSource.hidden = true;
    const loadSource = button(panel, '載入來源至草稿', async () => {
      const file = source.files[0];
      if (file?.size > 1024 * 1024) throw new Error('請選擇不超過 1 MB 的文字檔。');
      sourceOriginal = file ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) : pasted.value;
      sourceText.value = sourceOriginal;
      sourceRef = file?.name ?? 'pasted.md';
      if (!sourceText.value.trim()) throw new Error('請選擇檔案或貼上來源文字。');
      showSource.hidden = false;
      if (loadSource.getClientRects().length) showSourcePreview(loadSource);
    });
    button(panel, '送交審核', async () => {
      if (!base || baseVaultId !== vault.value) throw new Error('請先載入知識庫，或到進階建立草稿範本。');
      const metadata = base.vault ?? { id: vault.value, title: vault.value, kind };
      const id = crypto.randomUUID();
      if (kind === 'wiki') {
        if (metadata.kind !== 'wiki') throw new Error('請選擇文章知識庫。');
        const text = sourceOriginal ?? '';
        if (!text.trim() || text.length > 4000) throw new Error('請載入 4,000 字元以內的文章草稿。');
        await submit({ action: 'stage', id, draft: { vault: metadata, schema: base.schema.sha256,
          sources: [{ id: 'source', ref: sourceRef, original: text, markdown: text }], cards: [], relationships: [],
          evidence: [{ sourceId: 'source', start: 0, end: text.length }] } });
      } else {
        if (metadata.kind !== 'bi') throw new Error('請選擇卡片知識庫。');
        const draft = { vault: metadata, parent: base.parent, schema: base.schema.sha256, allowModel: base.allowModel,
          addCards: [], updateCards: [], removeCards: [], sources: [], evidence: [], relationships: [] };
        const sourceId = crypto.randomUUID();
        for (const { existing, operation, title, entries } of cardForms) {
          if (operation.value === 'keep') continue;
          if (operation.value === 'remove') { draft.removeCards.push(existing.id); continue; }
          if (!title.value.trim()) throw new Error('請輸入卡片標題。');
          const cardId = existing?.id ?? crypto.randomUUID();
          const card = { id: cardId, type: existing?.type ?? 'record', key: existing?.key ?? cardId,
            title: title.value.trim(), version: existing?.version ?? '1', fields: {} };
          for (const { field, value, quote } of entries) {
            const position = sourceText.value.indexOf(quote.value);
            const start = position < 0 ? -1 : originalOffset(position);
            const end = position < 0 ? -1 : originalOffset(position + quote.value.length);
            if (!value.value.trim() || !quote.value.trim() || end - start > 4000 || start < 0) {
              throw new Error(field + '需要欄位值，以及來源中完整相符的引文。');
            }
            Object.defineProperty(card.fields, field, { value: value.value, enumerable: true });
            draft.evidence.push({ sourceId, cardId, field, start, end });
          }
          (existing ? draft.updateCards : draft.addCards).push(card);
        }
        if (!draft.evidence.length && !draft.removeCards.length) throw new Error('請至少變更一張卡片。');
        if (draft.evidence.length) {
          draft.sources.push({ id: sourceId, ref: sourceRef, sha256: await uploadSource() });
        }
        await submit({ action: 'stage-change', id, draft });
      }
      await submitted(id);
    });
    function originalOffset(previewOffset) {
      let offset = previewOffset;
      for (let index = 0; index < offset; index++) {
        if (sourceOriginal[index] === '\r' && sourceOriginal[index + 1] === '\n') offset++;
      }
      return offset;
    }

    async function uploadSource() {
      const bytes = new TextEncoder().encode(sourceOriginal);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      await request('/api/knowledge/review-sources', { bytes, sha256 });
      return sha256;
    }
    if (kind === 'bi') {
      const note = element('p', '產生提案會將來源文字送到本機以外的模型服務。提案須由人工核准。');
      note.id = 'bi-proposal-note';
      panel.append(note);
      const control = button(panel, '產生模型提案', async () => {
        if (!base?.vault || base.vault.id !== vault.value) throw new Error('請先載入已發布的卡片知識庫。');
        if (!sourceText.value.trim() || new TextEncoder().encode(sourceOriginal).length > 24_000) {
          throw new Error('請載入 24,000 位元組以內的來源以產生提案。');
        }
        const result = await submit({ action: 'propose', id: crypto.randomUUID(), vault: vault.value,
          parent: base.parent, schema: base.schema.sha256, ref: sourceRef, sha256: await uploadSource() });
        if (result.rejected) throw new Error('提案的引文無法核對。請檢查欄位 ' + result.rejected.join('、') + '。');
        await submitted(result.id);
        status.textContent = '提案已送交人工審核。';
        if (control.getClientRects().length) openReview(result.id, control, '模型提案');
      });
      control.setAttribute('aria-describedby', note.id);
    }
    button(candidate.parentElement.parentElement, '送交 JSON 審核', async () => {
      const draft = JSON.parse(candidate.value);
      if (draft.vault.kind !== kind) throw new Error('草稿類型不符。請從對應的卡片或文章區送交審核。');
      const id = crypto.randomUUID();
      await submit({ action: 'parent' in draft ? 'stage-change' : 'stage', id, draft });
      await submitted(id);
    });
    let submittedId;
    const openSubmitted = button(panel, '查看已送審草稿', () => openReview(submittedId, openSubmitted, '送審草稿'));
    openSubmitted.hidden = true;
    panel.append(status);
    async function submitted(id) {
      status.textContent = '已送交審核。';
      await refresh();
      submittedId = id;
      openSubmitted.hidden = !reviewRows.has(id);
    }
    panel.addEventListener('toggle', () => {
      if (panel.open) refresh().catch(() => { status.textContent = '無法讀取清單。請收合後重新開啟。'; });
    });
  }
  async function refreshQueue() {
    queueStatus.textContent = '正在讀取審核清單…';
    try {
      await Promise.all(refreshers.map((refresh) => refresh()));
      queueStatus.textContent = '';
    } catch { queueStatus.textContent = '無法讀取審核清單。請重新整理。'; }
  }
  document.getElementById('review-refresh').addEventListener('click', () => void refreshQueue());
  return refreshQueue;
}
