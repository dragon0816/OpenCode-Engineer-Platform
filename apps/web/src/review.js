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

export function bindReview(anchor, onPublish) {
  const endpoint = '/api/knowledge/reviews';
  for (const kind of ['bi', 'wiki']) {
    const panel = element('details');
    panel.id = kind === 'bi' ? 'ingest-review' : 'wiki-review';
    panel.append(element('summary', kind === 'bi' ? 'BI 匯入與審核' : 'Wiki 草稿與審核'));
    anchor.after(panel);
    const vault = inputLabel(panel, '知識庫 ID');
    const version = inputLabel(panel, 'Schema 版本');
    const fields = kind === 'bi' ? inputLabel(panel, '必要欄位（逗號分隔）') : null;
    const source = inputLabel(panel, '選擇 UTF-8 文字或 Markdown');
    source.type = 'file';
    source.accept = '.txt,.md,.markdown';
    const candidate = inputLabel(panel, '候選 JSON', 'textarea');
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
        catch (error) { status.textContent = error.message; }
        finally { control.disabled = false; }
      });
      parent.append(control);
    }

    const submit = (data) => request(endpoint, { data });
    let refreshSequence = 0;
    async function refresh() {
      const sequence = ++refreshSequence;
      const { reviews, jobs } = await request(endpoint);
      if (sequence !== refreshSequence) return;
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
        section.append(element('summary', [row.vault, row.status, row.id].join(' · ')));
        section.append(element('p', '前一版本 ' + (row.parent ?? '無')));
        const editor = inputLabel(section, '審核草稿', 'textarea');
        editor.rows = 12;
        editor.value = JSON.stringify(draft, null, 2);
        editor.readOnly = row.status !== 'pending';
        const action = (name, label, extra = () => ({})) => button(section, label, async () => {
          await submit({ action: name, id: row.id, edit: row.edit, ...extra() });
          await refresh();
          if (name === 'publish' || name === 'rollback') await onPublish();
        });
        const comparison = element('pre');
        const showDiff = async () => {
          const { previous, candidate } = await submit({ action: 'compare', id: row.id });
          comparison.textContent = ['前一版本', JSON.stringify(previous, null, 2),
            '候選版本', JSON.stringify(candidate, null, 2)].join('\n');
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
          action('edit', '儲存修訂', () => ({ draft: JSON.parse(editor.value) }));
          action('approve', '核准', () => {
            if (JSON.stringify(JSON.parse(editor.value)) !== JSON.stringify(draft)) throw new Error('請先儲存草稿。');
            return {};
          });
          action('reject', '拒絕');
          if (kind === 'wiki') action('discard', '捨棄草稿');
        } else if (row.publication) {
          section.append(element('p', row.publication));
          action('rollback', '回復前一版本');
        } else if (row.status === 'approved') action('publish', '發布');
        section.append(comparison);
        list.append(section);
      }
    }

    button(panel, '安裝 Schema 並建立草稿範本', async () => {
      const names = fields ? fields.value.split(',').map((value) => value.trim()).filter(Boolean) : [];
      const schema = await submit({ action: 'schema', vault: vault.value, schema: 'local-' + kind, version: version.value, fields: names });
      const text = 'Synthetic source';
      candidate.value = JSON.stringify({
        vault: { id: vault.value, title: vault.value, kind },
        schema: schema.sha256,
        sources: [{ id: 'source', ref: 'source.md', original: text, markdown: text }],
        cards: kind === 'bi' ? [{ id: 'card', type: 'record', key: 'card', title: 'Record', version: '1',
          fields: Object.fromEntries(names.map((name) => [name, text])) }] : [],
        relationships: [],
        evidence: kind === 'bi' ? names.map((field) => ({ sourceId: 'source', cardId: 'card', field, start: 0, end: text.length }))
          : [{ sourceId: 'source', start: 0, end: text.length }],
      }, null, 2);
    });
    button(panel, '載入來源至草稿', async () => {
      const file = source.files[0];
      if (!file || file.size > 24_000) throw new Error('請選擇 24 KB 以內的 UTF-8 來源。');
      const draft = JSON.parse(candidate.value);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      draft.sources[0] = { id: 'source', ref: file.name, original: content, markdown: content };
      for (const item of draft.evidence.filter((item) => item.sourceId === 'source')) {
        item.start = 0;
        item.end = Math.min(content.length, 4000);
        const card = draft.cards.find((card) => card.id === item.cardId);
        if (card && Object.hasOwn(card.fields, item.field)) card.fields[item.field] = content.slice(0, item.end);
      }
      candidate.value = JSON.stringify(draft, null, 2);
    });
    button(panel, '送交審核', async () => {
      const draft = JSON.parse(candidate.value);
      if (draft.vault.kind !== kind) throw new Error('草稿類型不符。');
      await submit({ action: 'stage', id: crypto.randomUUID(), draft });
      await refresh();
    });
    button(panel, '重新整理清單', refresh);
    panel.append(status, list);
    panel.addEventListener('toggle', () => {
      if (panel.open) refresh().catch((error) => { status.textContent = error.message; });
    });
  }
}
