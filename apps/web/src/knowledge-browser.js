import { request } from './api.js';

const find = (id) => document.getElementById(id);
function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, action) {
  const element = node('button', text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function valueView(value) {
  if (value === null || value === undefined) return node('span', '無資料');
  if (typeof value === 'boolean') return node('span', value ? '是' : '否');
  if (typeof value !== 'object') return node('span', String(value));
  if (Array.isArray(value)) {
    const list = node('ul');
    for (const item of value) {
      const row = node('li');
      row.append(valueView(item));
      list.append(row);
    }
    return value.length ? list : node('span', '無資料');
  }
  const list = node('dl');
  for (const [key, item] of Object.entries(value)) {
    const field = node('dd');
    field.append(valueView(item));
    list.append(node('dt', key), field);
  }
  return list.childElementCount ? list : node('span', '無資料');
}

function highlight(parent, content, query) {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) { parent.textContent = content.slice(0, 240); return; }
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
  const columns = [['title', '卡片'], ['key', '識別鍵'], ['type', '類型'], ['category', '分類'], ['domain', '領域／資料夾'], ['version', '版本']];
  const browse = (data, signal) => request('/api/knowledge/browse', { data: { vault: active, ...data }, signal });

  function openPassage(passage, query = '', opener) {
    const key = JSON.stringify(['passage', active, passage.sourceVersion, passage.id, passage.locator, query]);
    const { body } = openPreview(key, '來源段落', opener);
    const quote = node('blockquote', passage.text);
    body.replaceChildren(node('p', `${passage.source} · ${passage.locator}`), quote);
    if (passage.sourceVersion) {
      const details = node('details');
      details.append(node('summary', '進階'), node('p', `來源版本 ${passage.sourceVersion}`));
      body.append(details);
    }
    if (query) {
      const excerpt = node('p');
      highlight(excerpt, passage.text, query);
      body.prepend(excerpt);
    }
    if (passage.cardId) body.append(button('開啟卡片', (event) => void openCard(passage.cardId, event.currentTarget)));
  }

  async function openCard(id, opener) {
    const { body, signal, setTitle } = openPreview(JSON.stringify(['card', active, id]), opener.textContent, opener);
    if (body.childElementCount) return;
    body.append(node('p', '正在讀取卡片。'));
    try {
      const { card, related, passages, history, evidence, revisions } = await browse({ card: id }, signal);
      if (signal.aborted) return;
      setTitle(card.title);
      body.replaceChildren();
      const details = node('details');
      details.append(node('summary', '進階'), node('p', `${card.type} · ${card.key} · 版本 ${card.version}`));
      const fields = node('dl');
      for (const [key, value] of Object.entries(card.fields)) {
        const field = node('dd');
        field.append(valueView(value));
        const provenance = node('details');
        provenance.append(node('summary', '欄位出處'), valueView(card.fieldProvenance?.[key]));
        const state = node('details');
        state.append(node('summary', '欄位狀態'), valueView(card.fieldStates?.[key]));
        field.append(provenance, state);
        fields.append(node('dt', key), field);
      }
      body.append(node('h3', '欄位'), fields.childElementCount ? fields : node('p', '無資料'));
      body.append(node('h3', '證據'));
      if (!passages.length) body.append(node('p', '無資料'));
      for (const passage of passages) {
        const record = evidence?.find((item) => item.passageIds.includes(passage.id));
        const reference = [record?.field, passage.source, passage.locator].filter(Boolean).join(' · ');
        body.append(button(reference, (event) => openPassage(passage, '', event.currentTarget)),
          node('blockquote', passage.text));
      }
      for (const [direction, label] of [['from', '指向其他卡片'], ['to', '由其他卡片指向此卡片']]) {
        body.append(node('h3', label));
        const links = related.filter((relation) => relation[direction] === id);
        if (!links.length) body.append(node('p', '無資料'));
        const other = direction === 'from' ? 'to' : 'from';
        for (const relation of links) {
          const row = node('p');
          row.append(button(relation[other + 'Title'] || relation[other], (event) => void openCard(relation[other], event.currentTarget)),
            ' · ', relation.kind);
          body.append(row);
        }
      }
      const changes = node('details');
      changes.append(node('summary', '欄位變更紀錄'), valueView(history));
      const publications = node('details');
      publications.append(node('summary', '知識庫發布紀錄'));
      for (const revision of revisions) publications.append(node('p', revision.revision));
      details.append(changes, publications);
      body.append(details);
    } catch {
      if (!signal.aborted) body.textContent = '無法讀取卡片，請重新開啟。';
    }
  }

  async function load(focus) {
    listing?.abort();
    const current = listing = new AbortController();
    find('knowledge-prev').disabled = find('knowledge-next').disabled = true;
    const values = Object.fromEntries(new FormData(form));
    status.textContent = '正在讀取卡片。';
    try {
      const page = await browse({ ...values, offset, sort, descending }, current.signal);
      if (current.signal.aborted) return;
      for (const [field, choices] of filters) {
        const select = form.elements.namedItem(field);
        select.replaceChildren(new Option('全部', ''), ...page[choices].map((item) => new Option(item, item)));
        select.value = values[field];
        if (select.selectedIndex < 0) select.selectedIndex = 0;
      }
      const table = node('table');
      const headings = table.createTHead().insertRow();
      for (const [column, label] of columns) {
        const header = node('th');
        header.scope = 'col';
        if (column === sort) header.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
        const sortButton = button(label + (column === sort ? (descending ? ' ↓' : ' ↑') : ''), () => {
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
          else cell.textContent = card[column] || '無資料';
        }
      }
      results.replaceChildren(table);
      status.textContent = page.total ? `第 ${offset + 1}–${offset + page.cards.length} 張，共 ${page.total} 張` : '沒有符合條件的卡片。';
      find('knowledge-prev').disabled = offset === 0;
      find('knowledge-next').disabled = offset + page.cards.length >= page.total;
      if (focus === 'prev' || focus === 'next') {
        const control = find('knowledge-' + focus);
        (control.disabled ? results : control).focus();
      } else if (focus) results.querySelector(`[data-sort="${focus}"]`)?.focus();
    } catch {
      if (!current.signal.aborted) status.textContent = '無法讀取卡片。';
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
    matches.replaceChildren(node('p', '正在搜尋段落。'));
    try {
      const { passages, ready } = await browse({ query }, current.signal);
      if (current.signal.aborted) return;
      matches.replaceChildren();
      if (!passages.length) matches.append(node('p', ready ? '找不到符合的段落。' : '索引目前無法查詢。'));
      for (const passage of passages) {
        const row = node('article');
        const snippet = node('p');
        highlight(snippet, passage.text, query);
        row.append(button(`${passage.source} · ${passage.locator}`, (event) => openPassage(passage, query, event.currentTarget)), snippet);
        matches.append(row);
      }
    } catch {
      if (!current.signal.aborted) matches.replaceChildren(node('p', '無法搜尋段落。'));
    }
  });

  rebuild.addEventListener('click', async () => {
    if (!confirm('要重建所有知識庫的搜尋索引嗎？')) return;
    rebuild.disabled = true;
    const result = find('knowledge-rebuild-status');
    result.textContent = '正在重建搜尋索引。';
    try {
      const { rebuilt } = await request('/api/knowledge/rebuild', { data: { confirmed: true } });
      await refreshVaults();
      result.textContent = `已重建 ${rebuilt} 個發布版本的搜尋索引。`;
    } catch {
      result.textContent = '無法重建搜尋索引。';
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
