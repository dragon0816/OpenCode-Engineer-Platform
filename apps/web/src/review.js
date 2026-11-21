import { request } from './api.js';

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
    const display = (value) => typeof value === 'string' ? value : value === undefined ? '（無）' : JSON.stringify(value);
    for (const field of new Set([...Object.keys(oldValues), ...Object.keys(newValues)])) {
      if (JSON.stringify(oldValues[field]) === JSON.stringify(newValues[field])) continue;
      changes.append(element('li', field + ' · ' + display(oldValues[field]) + ' → ' + display(newValues[field])));
      counts.fields++;
    }
    if (!changes.childElementCount) continue;
    const state = !old ? 'added' : !next ? 'removed' : 'changed';
    counts[state]++;
    parent.append(element('h4', { added: '新增', removed: '移除', changed: '變更' }[state] + ' · ' + (next ?? old).title), changes);
  }
  parent.prepend(element('p', '新增 ' + counts.added + ' · 變更 ' + counts.changed + ' · 移除 ' + counts.removed + ' · 欄位 ' + counts.fields));
  const evidence = element('details');
  evidence.append(element('summary', '證據 · ' + candidate.passages.length + ' 則'));
  const oldPassages = new Map(previous?.passages.map((item) => [item.id, item]));
  const sources = new Map(candidate.sources.map((item) => [item.id, item.ref]));
  for (const item of candidate.passages) {
    if (JSON.stringify(item) === JSON.stringify(oldPassages.get(item.id))) continue;
    evidence.append(element('p', sources.get(item.sourceId) + ' · ' + item.text));
  }
  parent.append(evidence);
}

export function bindReview(anchor, onPublish, openPreview) {
  const endpoint = '/api/knowledge/reviews';
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
    const list = element('div');

    function button(parent, label, work) {
      const control = element('button', label);
      control.type = 'button';
      control.addEventListener('click', async () => {
        control.disabled = true;
        status.textContent = '';
        try { await work(); }
        catch (error) { status.textContent = /[\u3400-\u9fff]/.test(error.message) ? error.message : '操作失敗。請檢查輸入後再試一次。'; }
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

    let refreshSequence = 0;
    async function refresh() {
      const sequence = ++refreshSequence;
      const [{ reviews, jobs }, { vaults }] = await Promise.all([request(endpoint), request('/api/knowledge/vaults')]);
      if (sequence !== refreshSequence) return;
      vaultChoices.replaceChildren(...vaults.filter((item) => item.kind === kind).map((item) => {
        const option = element('option', item.title);
        option.value = item.id;
        return option;
      }));
      list.replaceChildren();
      if (kind === 'bi') {
        for (const job of jobs) {
          const jobState = job.completed ? '已送審' : job.expires > Date.now() ? '執行中' : '待執行';
          list.append(element('p', [job.id, jobState].join(' · ')));
          if (!job.completed) {
            button(list, 'Run Now · ' + job.id, async () => {
              await submit({ action: 'run', id: job.id });
              await refresh();
            });
          }
        }
      }
      for (const row of reviews) {
        const draft = JSON.parse(row.draft);
        if (draft.vault.kind !== kind) continue;
        const section = element('details');
        section.append(element('summary', [row.vault, row.inactive ? '已停用' : statuses[row.status], row.id].join(' · ')));
        section.append(element('p', '前一版本 ' + (row.parent ?? '無')));
        const editor = inputLabel(advanced(section), '審核草稿', 'textarea');
        editor.rows = 12;
        editor.value = JSON.stringify(draft, null, 2);
        editor.readOnly = row.status !== 'pending';
        const action = (name, label, extra = () => ({})) => button(section, label, async () => {
          await submit({ action: name, id: row.id, edit: row.edit, ...extra() });
          await refresh();
          if (['publish', 'rollback', 'reactivate'].includes(name)) await onPublish();
        });
        const comparison = element('div');
        const showDiff = async () => {
          showComparison(comparison, await submit({ action: 'compare', id: row.id }));
        };
        if (row.status === 'pending' || row.status === 'approved') {
          button(section, '比較版本與證據', showDiff);
          if (kind === 'wiki') {
            const trial = inputLabel(section, '草稿證據搜尋');
            button(section, '搜尋草稿', async () => {
              const query = trial.value.trim().toLowerCase();
              if (!query) throw new Error('請輸入搜尋文字。');
              const { candidate } = await submit({ action: 'compare', id: row.id });
              const hits = candidate.passages.filter(({ text }) => text.toLowerCase().includes(query));
              comparison.textContent = hits.map(({ locator, text }) => locator + ' · ' + text).join('\n') || '草稿中找不到相符的證據。';
            });
          }
        }
        if (row.status === 'pending') {
          button(editor.parentElement.parentElement, '儲存修訂', async () => {
            await submit({ action: 'edit', id: row.id, edit: row.edit, draft: JSON.parse(editor.value) });
            await refresh();
          });
          action('approve', '核准', () => {
            if (JSON.stringify(JSON.parse(editor.value)) !== JSON.stringify(draft)) throw new Error('請先儲存草稿。');
            return {};
          });
          action('reject', '拒絕');
          if (kind === 'wiki') action('discard', '捨棄草稿');
        } else if (row.publication) {
          section.append(element('p', row.publication));
          if (row.active) action('rollback', '回復前一版本');
          if (row.inactive) action('reactivate', '重新啟用');
        } else if (row.status === 'approved') action('publish', '發布');
        section.append(comparison);
        list.append(section);
      }
    }

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
    const showSource = button(panel, '查看來源文字', () => {
      const { body } = openPreview(`build-source-${kind}`, '來源文字', showSource);
      if (!body.contains(sourceContent)) body.append(sourceContent);
    });
    showSource.hidden = true;
    const loadSource = button(panel, '載入來源至草稿', async () => {
      const file = source.files[0];
      if (file?.size > 1024 * 1024) throw new Error('請選擇不超過 1 MB 的文字檔。');
      sourceOriginal = file ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) : pasted.value;
      sourceText.value = sourceOriginal;
      sourceRef = file?.name ?? 'pasted.md';
      if (!sourceText.value.trim()) throw new Error('請選擇檔案或貼上來源文字。');
      showSource.hidden = false;
      if (loadSource.getClientRects().length) showSource.click();
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
      status.textContent = '已送交審核。';
      await refresh();
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
        status.textContent = '提案已送交人工審核。';
        await refresh();
        if (control.getClientRects().length) {
          const { body, signal } = openPreview('proposal-' + result.id, '模型提案', control);
          body.textContent = '正在讀取提案…';
          const comparison = await submit({ action: 'compare', id: result.id });
          if (!signal.aborted) showComparison(body, comparison);
        }
      });
      control.setAttribute('aria-describedby', note.id);
    }
    button(candidate.parentElement.parentElement, '送交 JSON 審核', async () => {
      const draft = JSON.parse(candidate.value);
      if (draft.vault.kind !== kind) throw new Error('草稿類型不符。');
      await submit({ action: 'parent' in draft ? 'stage-change' : 'stage', id: crypto.randomUUID(), draft });
      await refresh();
    });
    button(panel, '重新整理清單', refresh);
    panel.append(status, list);
    panel.addEventListener('toggle', () => {
      if (panel.open) refresh().catch(() => { status.textContent = '無法讀取審核清單。請重新整理。'; });
    });
  }
}
