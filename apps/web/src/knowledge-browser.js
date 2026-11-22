import { joinText, message, optionText, setText, t } from './i18n.js';
import { request } from './api.js';

const find = (id) => document.getElementById(id);
function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) setText(element, text);
  return element;
}
function content(tag, text) {
  const value = node(tag, text);
  value.dataset.uiContent = '';
  return value;
}

function button(text, action) {
  const element = node('button', text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function valueView(value) {
  if (value === null || value === undefined) return node('span', message('cards.no-data'));
  if (typeof value === 'boolean') return node('span', value ? message('cards.yes') : message('cards.no'));
  if (typeof value !== 'object') return node('span', String(value));
  if (Array.isArray(value)) {
    const list = node('ul');
    for (const item of value) {
      const row = node('li');
      row.append(valueView(item));
      list.append(row);
    }
    return value.length ? list : node('span', message('cards.no-data'));
  }
  const list = node('dl');
  for (const [key, item] of Object.entries(value)) {
    const field = node('dd');
    field.append(valueView(item));
    list.append(node('dt', key), field);
  }
  return list.childElementCount ? list : node('span', message('cards.no-data'));
}

function highlight(parent, content, query) {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) { setText(parent, content.slice(0, 240)); return; }
  const pattern = new RegExp(terms.join('|'), 'giu');
  const match = pattern.exec(content);
  const start = Math.max(0, (match?.index ?? 0) - 55);
  const snippet = content.slice(start, start + 240);
  if (start) parent.append('…');
  let cursor = 0;
  for (const part of snippet.matchAll(new RegExp(pattern.source, 'giu'))) {
    parent.append(snippet.slice(cursor, part.index), node('mark', part[0]));
    cursor = part.index + part[0].length;
  }
  parent.append(snippet.slice(cursor), start + snippet.length < content.length ? '…' : '');
}

export function bindKnowledgeBrowser(refreshVaults, openPreview) {
  const root = find('knowledge-browser');
  const form = find('knowledge-filters');
  const results = find('knowledge-cards');
  const search = find('knowledge-fts');
  const matches = find('knowledge-matches');
  const status = find('knowledge-browser-status');
  const rebuild = find('knowledge-rebuild');
  let active;
  let listing;
  let searching;
  let offset = 0;
  let sort = 'title';
  let descending = false;
  const filters = [['type', 'types'], ['category', 'categories'], ['domain', 'domains']];
  const columns = [['title', message('ui.cards')], ['key', message('cards.key')], ['type', message('ui.type')], ['category', message('ui.category')], ['domain', message('ui.domain-folder')], ['version', message('cards.version')]];
  const browse = (data, signal) => request('/api/knowledge/browse', { data: { vault: active, ...data }, signal });

  function openPassage(passage, query = '', opener) {
    const key = JSON.stringify(['passage', active, passage.sourceVersion, passage.id, passage.locator, query]);
    const { body } = openPreview(key, message('cards.source-passage'), opener);
    const quote = node('blockquote', passage.text);
    body.replaceChildren(content('p', `${passage.source} · ${passage.locator}`), quote);
    if (passage.sourceVersion) {
      const details = node('details');
      details.append(node('summary', message('ui.advanced')), node('p', message('cards.source-version-version', { version: passage.sourceVersion })));
      body.append(details);
    }
    if (query) {
      const excerpt = content('p');
      highlight(excerpt, passage.text, query);
      body.prepend(excerpt);
    }
    if (passage.cardId) body.append(button(message('cards.open-card'), (event) => void openCard(passage.cardId, event.currentTarget)));
  }

  async function openCard(id, opener) {
    const { body, signal, setTitle } = openPreview(JSON.stringify(['card', active, id]), message('cards.loading-card'), opener);
    if (body.childElementCount) return;
    body.append(node('p', message('cards.loading-card')));
    try {
      const { card, related, passages, history, evidence, revisions } = await browse({ card: id }, signal);
      if (signal.aborted) return;
      setTitle(card.title);
      body.replaceChildren();
      const details = node('details');
      details.append(node('summary', message('ui.advanced')), node('p', message('cards.type-key-version-version', { type: card.type, key: card.key, version: card.version })));
      const fields = node('dl');
      for (const [key, value] of Object.entries(card.fields)) {
        const field = node('dd');
        field.append(valueView(value));
        const provenance = node('details');
        provenance.append(node('summary', message('cards.field-source')), valueView(card.fieldProvenance?.[key]));
        const state = node('details');
        state.append(node('summary', message('cards.field-status')), valueView(card.fieldStates?.[key]));
        field.append(provenance, state);
        fields.append(content('dt', key), field);
      }
      body.append(node('h3', message('cards.fields')), fields.childElementCount ? fields : node('p', message('cards.no-data')));
      body.append(node('h3', message('cards.evidence')));
      if (!passages.length) body.append(node('p', message('cards.no-data')));
      for (const passage of passages) {
        const record = evidence?.find((item) => item.passageIds.includes(passage.id));
        const reference = [record?.field, passage.source, passage.locator].filter(Boolean).join(' · ');
        body.append(button(reference, (event) => openPassage(passage, '', event.currentTarget)),
          node('blockquote', passage.text));
      }
      for (const [direction, label] of [['from', message('cards.links-to-other-cards')], ['to', message('cards.linked-from-other-cards')]]) {
        body.append(node('h3', label));
        const links = related.filter((relation) => relation[direction] === id);
        if (!links.length) body.append(node('p', message('cards.no-data')));
        const other = direction === 'from' ? 'to' : 'from';
        for (const relation of links) {
          const row = node('p');
          row.append(button(relation[other + 'Title'] || relation[other], (event) => void openCard(relation[other], event.currentTarget)),
            ' · ', relation.kind);
          body.append(row);
        }
      }
      const changes = node('details');
      changes.append(node('summary', message('cards.field-change-history')), valueView(history));
      const publications = node('details');
      publications.append(node('summary', message('cards.knowledge-base-release-history')));
      for (const revision of revisions) publications.append(node('p', revision.revision));
      details.append(changes, publications);
      body.append(details);
    } catch {
      if (!signal.aborted) setText(body, message('cards.could-not-load-this-card-open-it'));
    }
  }

  async function load(focus) {
    listing?.abort();
    const current = listing = new AbortController();
    find('knowledge-prev').disabled = find('knowledge-next').disabled = true;
    const values = Object.fromEntries(new FormData(form));
    setText(status, message('cards.loading-card'));
    try {
      const page = await browse({ ...values, offset, sort, descending }, current.signal);
      if (current.signal.aborted) return;
      for (const [field, choices] of filters) {
        const select = form.elements.namedItem(field);
        select.replaceChildren(optionText(message('ui.all'), ''), ...page[choices].map(item => {
          const option = content('option', item);
          option.value = item;
          return option;
        }));
        select.value = values[field];
        if (select.selectedIndex < 0) select.selectedIndex = 0;
      }
      const table = node('table');
      const headings = table.createTHead().insertRow();
      for (const [column, label] of columns) {
        const header = node('th');
        header.scope = 'col';
        if (column === sort) header.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
        const sortButton = button(joinText([label, column === sort ? (descending ? ' ↓' : ' ↑') : ''], ''), () => {
          descending = sort === column && !descending;
          sort = column;
          offset = 0;
          void load(column);
        });
        sortButton.dataset.sort = column;
        header.append(sortButton);
        headings.append(header);
      }
      const body = table.createTBody();
      for (const card of page.cards) {
        const row = body.insertRow();
        for (const [column] of columns) {
          const cell = row.insertCell();
          if (column === 'title') cell.append(button(card.title, (event) => void openCard(card.id, event.currentTarget)));
          else setText(cell, card[column] || message('cards.no-data'));
        }
      }
      results.replaceChildren(table);
      setText(status, page.total ? message('cards.cards-start-end-of-total', { start: offset + 1, end: offset + page.cards.length, total: page.total }) : message('cards.no-matching-cards'));
      find('knowledge-prev').disabled = offset === 0;
      find('knowledge-next').disabled = offset + page.cards.length >= page.total;
      if (focus === 'prev' || focus === 'next') {
        const control = find('knowledge-' + focus);
        (control.disabled ? results : control).focus();
      } else if (focus) results.querySelector(`[data-sort="${focus}"]`)?.focus();
    } catch {
      if (!current.signal.aborted) setText(status, message('cards.could-not-load-cards-apply-the-filters'));
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); offset = 0; void load(); });
  form.addEventListener('change', () => { offset = 0; void load(); });
  find('knowledge-prev').addEventListener('click', () => { offset -= 25; void load('prev'); });
  find('knowledge-next').addEventListener('click', () => { offset += 25; void load('next'); });
  search.addEventListener('submit', async (event) => {
    event.preventDefault();
    searching?.abort();
    const current = searching = new AbortController();
    const query = search.elements.query.value.trim();
    matches.replaceChildren(node('p', message('cards.searching-passages')));
    try {
      const { passages, ready } = await browse({ query }, current.signal);
      if (current.signal.aborted) return;
      matches.replaceChildren();
      if (!passages.length) matches.append(node('p', ready ? message('cards.no-matching-passages') : message('cards.the-search-index-is-unavailable')));
      for (const passage of passages) {
        const row = node('article');
        const snippet = content('p');
        highlight(snippet, passage.text, query);
        row.append(button(`${passage.source} · ${passage.locator}`, (event) => openPassage(passage, query, event.currentTarget)), snippet);
        matches.append(row);
      }
    } catch {
      if (!current.signal.aborted) matches.replaceChildren(node('p', message('cards.could-not-search-passages')));
    }
  });

  rebuild.addEventListener('click', async () => {
    if (!confirm(t('cards.rebuild-the-search-index-for-all-knowledge'))) return;
    rebuild.disabled = true;
    const result = find('knowledge-rebuild-status');
    setText(result, message('cards.rebuilding-the-search-index'));
    try {
      const { rebuilt } = await request('/api/knowledge/rebuild', { data: { confirmed: true } });
      await refreshVaults();
      setText(result, message('cards.rebuilt-search-indexes-releases-count', { count: rebuilt }));
    } catch {
      setText(result, message('cards.could-not-rebuild-the-search-index-try'));
    } finally { rebuild.disabled = false; }
  });

  return {
    openPassage,
    select(vault) {
      if (active !== vault) {
        sort = 'title';
        descending = false;
      }
      active = vault;
      listing?.abort();
      searching?.abort();
      root.hidden = !vault;
      offset = 0;
      form.reset();
      search.reset();
      matches.replaceChildren();
      results.replaceChildren();
      if (vault) void load();
    },
  };
}
