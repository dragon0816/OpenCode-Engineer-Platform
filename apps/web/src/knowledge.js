import { bindKnowledgeQuality } from './knowledge-quality.js';
import { bindKnowledgeBrowser } from './knowledge-browser.js';
import { bindReview } from './review.js';
import { RequestError, request } from './api.js';

const tabPreference = 'oep.knowledge.tab';
const vaultPreference = 'oep.knowledge.vault';
const vaultTitle = (item) => item.id === 'oep-synthetic-demo' ? '範例知識庫' : item.title;
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
  'gateway-rejected': '模型服務拒絕處理這個問題，系統未再次傳送證據。請換個問法再試。',
  empty: '模型未回傳內容。',
  busy: '知識詢問處理中，請稍後再試。',
  'evidence-changed-or-cancelled': '知識庫版本在查詢期間變更，或本次查詢已取消。',
};

export function bindKnowledge(openPreview, closePreviews) {
  const browser = bindKnowledgeBrowser(() => refreshVaults(), openPreview);
  const quality = bindKnowledgeQuality(browser.openPassage, messages);
  const refreshReviews = bindReview(find('knowledge-repository'), () => refreshVaults(), openPreview);
  const tabs = [...find('knowledge-view').querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      find(item.getAttribute('aria-controls')).hidden = !selected;
    }
    localStorage.setItem(tabPreference, tab.id);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      selectTab(tabs[(target + tabs.length) % tabs.length], true);
    });
  });
  selectTab(tabs.find((tab) => tab.id === localStorage.getItem(tabPreference)) ?? tabs[0]);
  const open = find('open-knowledge');
  const chat = find('open-chat');
  const vault = find('vault');
  const question = find('knowledge-question');
  const ask = find('knowledge-ask');
  const details = find('vault-details');
  const technical = find('vault-technical');
  const vaultStatus = find('vault-status');
  const status = find('knowledge-status');
  const answer = find('knowledge-answer');
  const repositoryStatus = find('knowledge-repository-status');
  const repositoryForm = find('knowledge-repository-form');
  const folder = find('knowledge-folder');
  const consent = find('knowledge-model-consent');
  const checkFolder = find('knowledge-check-folder');
  const importFolder = find('knowledge-import-folder');
  let models = new Map();
  let loading;
  let pending;
  let importing;
  const demoLoad = find('knowledge-demo-load');
  const demoRemove = find('knowledge-demo-remove');
  async function demo(load) {
    demoLoad.disabled = demoRemove.disabled = true;
    const feedback = find('knowledge-demo-status');
    try {
      const { vault: id } = await request('/api/knowledge/demo', { data: { load, allowModel: find('demo-model-consent').checked } });
      await refreshVaults(load ? id : vault.value);
      feedback.textContent = load ? '已載入範例知識庫。' : '已移除範例知識庫。';
    } catch (error) { feedback.textContent = error.message; }
    finally { demoLoad.disabled = demoRemove.disabled = false; }
  }
  demoLoad.addEventListener('click', () => void demo(true));
  demoRemove.addEventListener('click', () => void demo(false));

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
    technical.replaceChildren();
    find('knowledge-overview-empty').hidden = Boolean(selected);
    find('knowledge-rebuild').hidden = !selected;
    if (selected) localStorage.setItem(vaultPreference, selected.id);
    browser.select(selected?.id);
    quality.select(selected);
    if (!selected) {
      status.textContent = vaultStatus.textContent = '目前沒有已發布的知識庫。';
      controls();
      return;
    }
    for (const [term, value] of [
      ...(selected.tag ? [['發布標籤', selected.tag]] : []),
      ['發布時間', new Date(selected.publishedAt).toLocaleString('zh-Hant')],
      ['內容', `${selected.cards} 張卡片、${selected.sources} 個來源、${selected.passages} 段證據、${selected.relationships} 條關係`],
    ]) details.append(label('dt', term), label('dd', value));
    for (const [term, value] of [
      ['識別碼', selected.id], ['發布版本', selected.revision], ['結構版本', `${selected.schema} · ${selected.schemaVersion}`],
      ['搜尋索引', selected.ready ? '可用' : '需要檢查'],
    ]) technical.append(label('dt', term), label('dd', value));
    vaultStatus.textContent = selected.ready ? '可搜尋' : '搜尋需要維護';
    status.textContent = !selected.ready ? '目前無法搜尋此知識庫。' :
      selected.modelEnabled ? '' : '這個版本尚未授權供模型使用。';
    controls();
  }

  function showKnowledge(show) {
    find('knowledge-view').hidden = !show;
    find('chat-view').hidden = show;
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

  async function refreshVaults(previous = vault.value || localStorage.getItem(vaultPreference)) {
    loading?.abort();
    pending?.abort();
    pending = undefined;
    const active = loading = new AbortController();
    models.clear();
    browser.select(undefined);
    quality.select(undefined);
    vault.replaceChildren(new Option('載入中', ''));
    status.textContent = vaultStatus.textContent = '正在讀取已發布版本。';
    find('knowledge-rebuild').hidden = true;
    details.replaceChildren();
    technical.replaceChildren();
    answer.replaceChildren();
    controls();
    try {
      const { vaults } = await request('/api/knowledge/vaults', { signal: active.signal });
      if (active.signal.aborted) return;
      models = new Map(vaults.map((item) => [item.id, item]));
      const hasDemo = models.has('oep-synthetic-demo');
      demoLoad.hidden = find('demo-model-label').hidden = hasDemo;
      demoRemove.hidden = !hasDemo;
      vault.replaceChildren(...vaults.map((item) =>
        new Option([vaultTitle(item), item.tag, new Date(item.publishedAt).toLocaleString('zh-Hant')].filter(Boolean).join(' · '), item.id)));
      if (models.has(previous)) vault.value = previous;
      if (!vaults.length) vault.append(new Option('尚無已發布版本', ''));
      describe();
    } catch {
      if (!active.signal.aborted) status.textContent = vaultStatus.textContent = '無法讀取已發布的知識庫。';
    } finally {
      if (loading === active) { loading = undefined; controls(); }
    }
  }
  chat.addEventListener('click', () => showKnowledge(false));
  open.addEventListener('click', () => {
    if (!find('knowledge-view').hidden) return;
    showKnowledge(true);
    void refreshVaults();
  });
  repositoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const diagnostics = find('knowledge-repository-diagnostics');
    const path = folder.value.trim();
    if (!path || importing) return;
    importing = true;
    diagnostics.hidden = true;
    for (const element of [folder, consent, checkFolder, importFolder]) element.disabled = true;
    const write = event.submitter === importFolder;
    repositoryStatus.textContent = write ? '正在驗證及匯入發布版本。' : '正在檢查資料夾。';
    try {
      if (write) {
        const report = await request('/api/knowledge/import', { data: { folder: path, allowModel: consent.checked } });
        repositoryStatus.textContent = [
          `發布標籤 ${report.tag} · 版本 ${report.revision}`,
          report.active ? (report.state === 'existing' ? '已匯入，索引可用。' : '匯入完成，索引已就緒。') :
            '已保留此版本，目前仍使用較新的發布紀錄。',
          `${report.cards} 張卡片、${report.sources} 個來源、${report.passages} 段證據、${report.relationships} 條關係`,
        ].join('\n');
        if (!find('knowledge-view').hidden) await refreshVaults(report.vault);
      } else {
        const { publication, repository, errors } = await request('/api/knowledge/inspect', { data: { folder: path } });
        const states = { resolved: '已解析發布標籤與快照。', 'no published version': '找不到發布紀錄。',
          unresolved: '無法解析發布紀錄。', 'artifact unavailable': '已解析發布標籤，快照尚不可用。' };
        repositoryStatus.textContent = [states[publication.state],
          repository.type === 'wiki' ? '文章資料夾目前僅支援檢查。' : '',
        ].filter(Boolean).join('\n');
        diagnostics.hidden = !errors.length;
        diagnostics.querySelector('p').textContent =
          errors.map((issue) => `${issue.sqlite ? `SQLite ${issue.sqlite}` : issue.area} · ${issue.message}`).join('\n');
      }
    } catch (error) {
      repositoryStatus.textContent = error instanceof RequestError ? error.message : '無法處理此資料夾。';
    } finally {
      importing = false;
      for (const element of [folder, consent, checkFolder, importFolder]) element.disabled = false;
    }
  });
  vault.addEventListener('change', () => { closePreviews(); describe(); });
  find('knowledge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (ask.disabled || !question.value.trim()) return;
    const active = pending = new AbortController();
    const selected = models.get(vault.value);
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
      const release = label('details', '');
      release.append(label('summary', '進階'), label('p', `發布版本 ${result.revision}`));
      answer.append(box, label('small', [vaultTitle(selected), selected?.tag].filter(Boolean).join(' · ')));
      for (const citation of result.citations) {
        const trigger = label('button', `${citation.source} · ${citation.locator}`);
        trigger.type = 'button';
        trigger.className = 'knowledge-reference';
        trigger.addEventListener('click', () =>
          browser.openPassage({ ...citation, text: citation.context }, citation.quote, trigger));
        answer.append(trigger);
      }
      answer.append(release);
    } catch {
      if (!active.signal.aborted) status.textContent = '本次詢問無法完成。';
    } finally {
      if (pending === active) { pending = undefined; controls(); }
    }
  });
  open.disabled = false;
  return {
    refreshReviews,
    disable() {
      showKnowledge(false);
      open.disabled = true;
    },
    async ask(id, text) {
      if (pending) throw new Error('知識詢問處理中，請稍後再試。');
      showKnowledge(true);
      await refreshVaults();
      if (!models.has(id)) {
        status.textContent = messages['vault-unavailable'];
        return;
      }
      vault.value = id;
      describe();
      selectTab(find('knowledge-tab-ask'));
      question.value = text;
      if (!ask.disabled) find('knowledge-form').requestSubmit(ask);
    },
  };
}
