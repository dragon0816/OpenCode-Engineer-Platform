import { request } from './api.js';

const find = (id) => document.getElementById(id);
const label = (tag, value) => {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
};
const messages = {
  'vault-unavailable': '找不到可查詢的已發布版本。',
  'no-evidence': '知識庫沒有能回答這個問題的證據。',
  'model-disabled': '這個版本尚未授權供模型使用。',
  unsupported: '已發布的證據不足以支持答案。',
  'invalid-citation': '模型回覆未通過引用驗證。',
  unavailable: '目前無法連線到模型。',
  empty: '模型未回傳內容。',
  busy: '知識詢問處理中，請稍後再試。',
  'evidence-changed-or-cancelled': '知識庫版本在查詢期間變更，或本次查詢已取消。',
};

export function bindKnowledge() {
  const open = find('open-knowledge');
  const chat = find('open-chat');
  const vault = find('vault');
  const question = find('knowledge-question');
  const ask = find('knowledge-ask');
  const details = find('vault-details');
  const status = find('knowledge-status');
  const answer = find('knowledge-answer');
  let models = new Map();
  let loading;
  let pending;

  function controls() {
    const selected = models.get(vault.value);
    vault.disabled = Boolean(loading || pending) || !models.size;
    question.disabled = !selected?.ready || !selected?.modelEnabled || Boolean(loading || pending);
    ask.disabled = question.disabled;
  }

  function describe() {
    answer.replaceChildren();
    const selected = models.get(vault.value);
    details.replaceChildren();
    if (!selected) {
      status.textContent = '目前沒有已發布的快照。';
      controls();
      return;
    }
    for (const [term, value] of [
      ['識別碼', selected.id], ['發布版本', selected.revision], ['結構版本', `${selected.schema} · ${selected.schemaVersion}`],
      ['發布時間', new Date(selected.publishedAt).toLocaleString('zh-Hant')],
      ['內容', `${selected.cards} 張卡片、${selected.sources} 個來源、${selected.passages} 段證據、${selected.relationships} 條關係`],
    ]) details.append(label('dt', term), label('dd', value));
    status.textContent = !selected.ready ? '索引目前無法查詢。' :
      selected.modelEnabled ? '' : '這個版本尚未授權供模型使用。';
    controls();
  }

  function showKnowledge(show) {
    find('knowledge-view').hidden = !show;
    find('chat-view').hidden = find('chat-files').hidden = show;
    if (show) {
      open.setAttribute('aria-current', 'page');
      chat.removeAttribute('aria-current');
      find('knowledge-title').focus();
    } else {
      loading?.abort();
      pending?.abort();
      loading = pending = undefined;
      chat.setAttribute('aria-current', 'page');
      open.removeAttribute('aria-current');
      chat.focus();
    }
  }

  chat.addEventListener('click', () => showKnowledge(false));
  open.addEventListener('click', async () => {
    if (!find('knowledge-view').hidden) return;
    showKnowledge(true);
    const previous = vault.value;
    const active = loading = new AbortController();
    models.clear();
    vault.replaceChildren(new Option('載入中', ''));
    status.textContent = '正在讀取已發布版本。';
    details.replaceChildren();
    answer.replaceChildren();
    controls();
    try {
      const { vaults } = await request('/api/knowledge/vaults', { signal: active.signal });
      if (active.signal.aborted) return;
      models = new Map(vaults.map((item) => [item.id, item]));
      vault.replaceChildren(...vaults.map((item) =>
        new Option(`${item.title} · ${item.kind === 'bi' ? 'BI' : 'Wiki'}`, item.id)));
      if (models.has(previous)) vault.value = previous;
      if (!vaults.length) vault.append(new Option('尚無已發布版本', ''));
      describe();
    } catch {
      if (!active.signal.aborted) status.textContent = '無法讀取已發布的知識庫。';
    } finally {
      if (loading === active) { loading = undefined; controls(); }
    }
  });
  vault.addEventListener('change', describe);
  find('knowledge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (ask.disabled || !question.value.trim()) return;
    const active = pending = new AbortController();
    controls();
    answer.replaceChildren();
    status.textContent = '正在檢索與核對引用。';
    try {
      const result = await request('/api/knowledge/ask', {
        data: { vault: vault.value, question: question.value }, signal: active.signal,
      });
      if (active.signal.aborted) return;
      if (result.state !== 'verified') {
        status.textContent = messages[result.reason] || '本次詢問無法完成。';
        return;
      }
      status.textContent = '引用已通過驗證。';
      const box = label('article', '');
      box.className = 'message';
      box.append(label('h2', '答案'), label('p', result.answer));
      answer.append(box, label('small', `發布版本 ${result.revision}`));
      for (const citation of result.citations) {
        const reference = label('details', '');
        reference.append(label('summary', `${citation.source} · ${citation.locator}`),
          label('blockquote', citation.context), label('small', `來源版本 ${citation.sourceVersion} · SHA-256 ${citation.sha256}`));
        answer.append(reference);
      }
    } catch {
      if (!active.signal.aborted) status.textContent = '本次詢問無法完成。';
    } finally {
      if (pending === active) { pending = undefined; controls(); }
    }
  });
  open.disabled = false;
  return () => {
    showKnowledge(false);
    open.disabled = true;
  };
}
