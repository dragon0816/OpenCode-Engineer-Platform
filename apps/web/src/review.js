import { bindFilePicker, joinText, LocalizedError, message, setText } from './i18n.js';
import { errorText, request, sampleKnowledgeID } from './api.js';

const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text) setText(node, text);
  return node;
};

function inputLabel(parent, text, tag = 'input') {
  const label = element('label', text);
  const input = element(tag);
  label.append(input);
  parent.append(label);
  return input;
}

const statuses = { pending: message('jobs.pending-review'), approved: message('jobs.approved'), rejected: message('jobs.rejected'), discarded: message('jobs.discarded') };

function advanced(parent) {
  const fold = element('details');
  fold.append(element('summary', message('ui.advanced')));
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
    const changes = element('ul');
    const technical = element('ul');
    const display = (value) => typeof value === 'string' ? value : value === undefined ? message('review.none') : JSON.stringify(value);
    const compareField = (list, label, oldValue, newValue) => {
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
      const entry = element('li');
      const parts = [label, display(oldValue), display(newValue)].map(text => {
        const span = element('span', text);
        span.toggleAttribute('data-ui-content', typeof text === 'string');
        return span;
      });
      entry.append(parts[0], ' · ', parts[1], ' → ', parts[2]);
      list.append(entry);
      counts.fields++;
    };
    compareField(changes, message('review.title'), old?.title, next?.title);
    compareField(technical, message('ui.type'), old?.type, next?.type);
    compareField(technical, message('cards.key'), old?.key, next?.key);
    compareField(technical, message('cards.version'), old?.version, next?.version);
    for (const field of new Set([...Object.keys(old?.fields ?? {}), ...Object.keys(next?.fields ?? {})])) {
      compareField(changes, field, old?.fields[field], next?.fields[field]);
    }
    if (!changes.childElementCount && !technical.childElementCount) continue;
    const state = !old ? 'added' : !next ? 'removed' : 'changed';
    counts[state]++;
    const heading = element('h4', { added: message('review.add'), removed: message('chat.remove'), changed: message('review.change') }[state]);
    const title = element('span', (next ?? old).title);
    title.dataset.uiContent = '';
    heading.append(' · ', title);
    parent.append(heading);
    if (changes.childElementCount) parent.append(changes);
    if (technical.childElementCount) advanced(parent).append(technical);
  }
  parent.prepend(element('p', message('review.change-counts', counts)));
  const evidence = element('div');
  evidence.append(element('h3', message('review.evidence-count', { count: candidate.passages.length })));
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
    panel.append(element('summary', kind === 'bi' ? message('review.create-cards-from-a-source') : message('review.create-an-article-from-a-source')));
    anchor.after(panel);
    const vault = inputLabel(panel, message('review.knowledge-base-id'));
    const vaultChoices = element('datalist');
    vaultChoices.id = panel.id + '-vaults';
    vault.setAttribute('list', vaultChoices.id);
    panel.append(vaultChoices);
    const schemaOptions = advanced(panel);
    const version = inputLabel(schemaOptions, message('review.schema-version'));
    const fields = kind === 'bi' ? inputLabel(schemaOptions, message('review.required-fields-comma-separated')) : null;
    const source = element('input');
    panel.append(source);
    source.type = 'file';
    source.accept = '.txt,.md,.markdown';
    bindFilePicker(source, message('review.choose-a-text-file'));
    const pasted = inputLabel(panel, message('review.or-paste-source-text'), 'textarea');
    const sourceContent = element('div');
    const sourceText = inputLabel(sourceContent, message('review.source-preview-select-text-to-quote'), 'textarea');
    sourceText.readOnly = true;
    const cardList = element('div');
    panel.append(cardList);
    const candidate = inputLabel(advanced(panel), message('review.candidate-json'), 'textarea');
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
        catch (error) { setText(feedback, errorText(error, message('review.could-not-complete-the-operation-check-your'))); }
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
      group.append(element('legend', existing ? existing.title : message('review.add-card')));
      const operation = inputLabel(group, message('review.action'), 'select');
      for (const [value, text] of existing ? [['keep', message('review.keep')], ['update', message('review.change')], ['remove', message('chat.remove')]] : [['add', message('review.add')], ['keep', message('review.skip')]]) {
        const option = element('option', text);
        option.value = value;
        operation.append(option);
      }
      const details = element('div');
      group.append(details);
      const title = inputLabel(details, message('review.card-title'));
      title.value = existing?.title ?? '';
      const entries = base.schema.document.fields.map((field) => {
        const value = inputLabel(details, field);
        value.value = existing?.fields[field] ?? '';
        const quote = inputLabel(details, message('review.quote', { field }), 'textarea');
        button(details, message('review.use-selected-text', { field }), () => {
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
        button(cardList, message('review.add-card'), () => addCard());
        for (const card of base.cards) addCard(card);
      }
    }

    const previews = new Map();
    let reviewRows = new Map();

    function agentSource(row) {
      if (!row.agentSource) return;
      const name = row.agentSource === 'BI 資料處理' ? message('agents.bi') : row.agentSource;
      const label = element('small', message('reviews.agentSource', { name }));
      label.className = 'review-agent-source';
      return label;
    }

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
      if (!row) { body.append(element('p', message('review.could-not-open-this-review-item-refresh'))); return; }
      const draft = JSON.parse(row.draft);
      const heading = element('p', displayedState(row));
      heading.tabIndex = -1;
      const metadata = advanced(body);
      metadata.append(element('p', message('review.review-id-id', { id })), element('p', message('review.previous-release-version', { version: row.parent ?? message('jobs.none') })));
      if (row.publication) metadata.append(element('p', message('review.published-release-version', { version: row.publication })));
      const editor = inputLabel(metadata, message('review.review-draft-json'), 'textarea');
      editor.rows = 12;
      editor.value = JSON.stringify(draft, null, 2);
      editor.readOnly = row.status !== 'pending';
      const feedback = element('p');
      feedback.setAttribute('role', 'status');
      const controls = element('div');
      controls.className = 'review-actions';
      const comparison = element('div');
      body.prepend(heading, feedback, controls);
      const source = agentSource(row);
      if (source) heading.after(source);
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
        button(controls, message('review.compare-versions-and-evidence'), compare, feedback);
        setText(comparison, message('review.loading-versions-and-evidence'));
        compare().catch(() => { setText(comparison, message('review.could-not-load-versions-and-evidence-select')); });
        if (kind === 'wiki') {
          const trial = inputLabel(controls, message('review.search-draft-evidence'));
          button(controls, message('review.search-draft'), async () => {
            const query = trial.value.trim().toLowerCase();
            if (!query) throw new LocalizedError(message('review.enter-a-search-term'));
            const sequence = ++comparisonRequest;
            const { candidate } = await submit({ action: 'compare', id });
            if (signal.aborted || sequence !== comparisonRequest) return;
            const hits = candidate.passages.filter(({ text }) => text.toLowerCase().includes(query));
            comparison.replaceChildren(...hits.map(({ locator, text }) => {
              const passage = element('div');
              passage.append(element('p', locator), element('blockquote', text));
              return passage;
            }));
            if (!hits.length) setText(comparison, message('review.no-matching-evidence-in-the-draft'));
          }, feedback);
        }
      }
      if (row.status === 'pending') {
        action('edit', message('review.save-edits'), () => ({ draft: JSON.parse(editor.value) }), metadata);
        action('approve', message('jobs.approve'), () => {
          if (JSON.stringify(JSON.parse(editor.value)) !== JSON.stringify(draft)) throw new LocalizedError(message('review.save-the-draft-first'));
          return {};
        });
        action('reject', message('jobs.reject'));
        if (kind === 'wiki') action('discard', message('review.discard-draft'));
      } else if (row.publication && (row.active || row.inactive)) {
        const more = element('details');
        more.className = 'feature-more';
        more.append(element('summary', message('ui.more')));
        controls.append(more);
        if (row.active) action('rollback', message('review.restore-previous-release'), undefined, more);
        if (row.inactive) action('reactivate', message('review.re-enable'), undefined, more);
      } else if (row.status === 'approved' && !row.publication) action('publish', message('review.publish'));
    }

    function displayedState(row) {
      return row.inactive ? message('chat.disabled') : row.publication ? message('jobs.published') : statuses[row.status];
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
        item.append(element('small', joinText([displayedState(row), subject])));
        const source = agentSource(row);
        if (source) item.append(source);
        (row.status === 'pending' || row.status === 'approved' && !row.publication ? pending : history).append(item);
      }
      if (!pending.childElementCount) pending.append(element('li', message('review.no-drafts-awaiting-review')));
      if (!history.childElementCount) history.append(element('li', message('review.no-review-history-yet')));
      if (kind === 'bi') {
        const work = document.getElementById('review-import-jobs');
        work.replaceChildren();
        for (const job of jobs) {
          const jobState = job.completed ? message('jobs.submitted-for-review') : job.expires > Date.now() ? message('chat.running') : message('quality.queued-to-run');
          const item = element('li');
          const details = advanced(item);
          details.append(element('p', job.id));
          item.prepend(element('p', jobState));
          if (!job.completed) button(item, message('jobs.run-now'), async () => {
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

    button(schemaOptions, message('review.install-schema-and-create-a-draft-template'), async () => {
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
    button(panel, message('review.load-existing-knowledge-base'), async () => {
      setBase(await submit({ action: 'base', vault: vault.value }));
      version.value = base.schema.version;
      if (fields) fields.value = base.schema.document.fields.join(', ');
      setText(status, message('review.knowledge-base-loaded'));
    });
    function showSourcePreview(opener) {
      const { body } = openPreview(`build-source-${kind}`, message('review.source-text'), opener);
      if (!body.contains(sourceContent)) body.append(sourceContent);
    }
    const showSource = button(panel, message('review.view-source-text'), () => showSourcePreview(showSource));
    showSource.hidden = true;
    const loadSource = button(panel, message('review.load-source-into-draft'), async () => {
      const file = source.files[0];
      if (file?.size > 1024 * 1024) throw new LocalizedError(message('review.choose-a-text-file-up-to-1'));
      sourceOriginal = file ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) : pasted.value;
      sourceText.value = sourceOriginal;
      sourceRef = file?.name ?? 'pasted.md';
      if (!sourceText.value.trim()) throw new LocalizedError(message('review.choose-a-file-or-paste-source-text'));
      showSource.hidden = false;
      if (loadSource.getClientRects().length) showSourcePreview(loadSource);
    });
    button(panel, message('review.submit-for-review'), async () => {
      if (!base || baseVaultId !== vault.value) throw new LocalizedError(message('review.load-a-knowledge-base-first-or-create'));
      const metadata = base.vault ?? { id: vault.value, title: vault.value, kind };
      const id = crypto.randomUUID();
      if (kind === 'wiki') {
        if (metadata.kind !== 'wiki') throw new LocalizedError(message('review.select-an-article-knowledge-base'));
        const text = sourceOriginal ?? '';
        if (!text.trim() || text.length > 4000) throw new LocalizedError(message('review.load-an-article-draft-up-to-4'));
        await submit({ action: 'stage', id, draft: { vault: metadata, schema: base.schema.sha256,
          sources: [{ id: 'source', ref: sourceRef, original: text, markdown: text }], cards: [], relationships: [],
          evidence: [{ sourceId: 'source', start: 0, end: text.length }] } });
      } else {
        if (metadata.kind !== 'bi') throw new LocalizedError(message('review.select-a-card-knowledge-base'));
        const draft = { vault: metadata, parent: base.parent, schema: base.schema.sha256, allowModel: base.allowModel,
          addCards: [], updateCards: [], removeCards: [], sources: [], evidence: [], relationships: [] };
        const sourceId = crypto.randomUUID();
        for (const { existing, operation, title, entries } of cardForms) {
          if (operation.value === 'keep') continue;
          if (operation.value === 'remove') { draft.removeCards.push(existing.id); continue; }
          if (!title.value.trim()) throw new LocalizedError(message('review.enter-a-card-title'));
          const cardId = existing?.id ?? crypto.randomUUID();
          const card = { id: cardId, type: existing?.type ?? 'record', key: existing?.key ?? cardId,
            title: title.value.trim(), version: existing?.version ?? '1', fields: {} };
          for (const { field, value, quote } of entries) {
            const position = sourceText.value.indexOf(quote.value);
            const start = position < 0 ? -1 : originalOffset(position);
            const end = position < 0 ? -1 : originalOffset(position + quote.value.length);
            if (!value.value.trim() || !quote.value.trim() || end - start > 4000 || start < 0) {
              throw new LocalizedError(message('review.field-requires-a-value-and-a-quote', { field }));
            }
            Object.defineProperty(card.fields, field, { value: value.value, enumerable: true });
            draft.evidence.push({ sourceId, cardId, field, start, end });
          }
          (existing ? draft.updateCards : draft.addCards).push(card);
        }
        if (!draft.evidence.length && !draft.removeCards.length) throw new LocalizedError(message('review.change-at-least-one-card'));
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
      const note = element('p', message('review.generating-a-proposal-sends-the-source-text'));
      note.id = 'bi-proposal-note';
      panel.append(note);
      const control = button(panel, message('review.generate-model-proposal'), async () => {
        if (!base?.vault || base.vault.id !== vault.value) throw new LocalizedError(message('review.load-a-published-card-knowledge-base-first'));
        if (!sourceText.value.trim() || new TextEncoder().encode(sourceOriginal).length > 24_000) {
          throw new LocalizedError(message('review.load-a-source-up-to-24-000'));
        }
        const result = await submit({ action: 'propose', id: crypto.randomUUID(), vault: vault.value,
          parent: base.parent, schema: base.schema.sha256, ref: sourceRef, sha256: await uploadSource() });
        if (result.rejected) throw new LocalizedError(message('review.could-not-verify-the-proposals-quotes-check', { fields: result.rejected.join(', ') }));
        await submitted(result.id);
        setText(status, message('review.proposal-submitted-for-human-review'));
        if (control.getClientRects().length) openReview(result.id, control, message('review.model-proposal'));
      });
      control.setAttribute('aria-describedby', note.id);
    }
    button(candidate.parentElement.parentElement, message('review.submit-json-for-review'), async () => {
      const draft = JSON.parse(candidate.value);
      if (draft.vault.kind !== kind) throw new LocalizedError(message('review.the-draft-type-doesnt-match-submit-it'));
      const id = crypto.randomUUID();
      await submit({ action: 'parent' in draft ? 'stage-change' : 'stage', id, draft });
      await submitted(id);
    });
    let submittedId;
    const openSubmitted = button(panel, message('review.view-submitted-draft'), () => openReview(submittedId, openSubmitted, message('review.submitted-draft')));
    openSubmitted.hidden = true;
    panel.append(status);
    async function submitted(id) {
      setText(status, message('review.submitted-for-review'));
      await refresh();
      submittedId = id;
      openSubmitted.hidden = !reviewRows.has(id);
    }
    panel.addEventListener('toggle', () => {
      if (panel.open) refresh().catch(() => { setText(status, message('review.could-not-load-the-list-close-and')); });
    });
  }
  async function refreshQueue() {
    setText(queueStatus, message('review.loading-review-list'));
    try {
      await Promise.all(refreshers.map((refresh) => refresh()));
      queueStatus.textContent = '';
    } catch { setText(queueStatus, message('review.could-not-load-the-review-list-refresh')); }
  }
  document.getElementById('review-refresh').addEventListener('click', () => void refreshQueue());
  return refreshQueue;
}
