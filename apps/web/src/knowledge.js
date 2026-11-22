import { formatDate, joinText, LocalizedError, message, optionText, setText } from './i18n.js';
import { bindKnowledgeQuality } from './knowledge-quality.js';
import { bindKnowledgeBrowser } from './knowledge-browser.js';
import { bindReview } from './review.js';
import { errorText, request, RequestError, sampleKnowledgeID, serverText } from './api.js';

const tabPreference = 'oep.knowledge.tab';
const vaultPreference = 'oep.knowledge.vault';
const vaultTitle = (item) => item.id === sampleKnowledgeID ? message('knowledge.sample-knowledge-base') : item.title;
const find = (id) => document.getElementById(id);
const label = (tag, value) => {
  const element = document.createElement(tag);
  setText(element, value);
  return element;
};
const messages = {
  'vault-unavailable': message('knowledge.no-searchable-release-found-select-a-published'),
  'no-evidence': message('knowledge.no-relevant-information-found-try-rephrasing-the'),
  'model-disabled': message('knowledge.model-access-is-disabled-for-this-release'),
  unsupported: message('knowledge.the-knowledge-base-has-too-little-information'),
  'invalid-citation': message('knowledge.could-not-verify-the-sources-for-this'),
  unavailable: message('knowledge.could-not-reach-the-model-try-again'),
  'gateway-rejected': message('knowledge.the-model-service-declined-this-question-the'),
  empty: message('knowledge.the-model-didnt-reply-send-the-question'),
  busy: message('knowledge.a-knowledge-base-query-is-in-progress'),
  'evidence-changed-or-cancelled': message('knowledge.the-knowledge-base-release-changed-during-the'),
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
      setText(feedback, load ? message('knowledge.sample-knowledge-base-loaded') : message('knowledge.sample-knowledge-base-removed'));
    } catch (error) {
      setText(feedback, errorText(error));
    } finally { demoLoad.disabled = demoRemove.disabled = false; }
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
      [status, vaultStatus].forEach(element => setText(element, message('knowledge.no-knowledge-bases-have-been-published-yet')));
      controls();
      return;
    }
    for (const [term, value] of [
      ...(selected.tag && selected.id !== sampleKnowledgeID ? [[message('knowledge.release-tag'), selected.tag]] : []),
      [message('knowledge.published-at'), formatDate(selected.publishedAt)],
      [message('knowledge.contents'), message('knowledge.cards-cards-sources-sources-evidence-passages-passages', { cards: selected.cards, sources: selected.sources, passages: selected.passages, relationships: selected.relationships })],
    ]) details.append(label('dt', term), label('dd', value));
    for (const [term, value] of [
      ...(selected.id === sampleKnowledgeID ? [] : [
        [message('knowledge.id'), selected.id], [message('knowledge.release'), selected.revision], [message('knowledge.schema-version'), `${selected.schema} · ${selected.schemaVersion}`],
      ]),
      [message('knowledge.search-index'), selected.ready ? message('chat.available') : message('knowledge.needs-attention')],
    ]) technical.append(label('dt', term), label('dd', value));
    setText(vaultStatus, selected.ready ? message('knowledge.searchable') : message('knowledge.search-needs-maintenance'));
    setText(status, !selected.ready ? message('knowledge.search-is-unavailable-rebuild-the-search-index') :
      selected.modelEnabled ? '' : message('knowledge.model-access-is-disabled-for-this-release'));
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
    vault.replaceChildren(optionText(message('ui.loading-2'), ''));
    [status, vaultStatus].forEach(element => setText(element, message('knowledge.loading-published-releases')));
    find('knowledge-rebuild').hidden = true;
    details.replaceChildren();
    technical.replaceChildren();
    answer.replaceChildren();
    controls();
    try {
      const { vaults } = await request('/api/knowledge/vaults', { signal: active.signal });
      if (active.signal.aborted) return;
      models = new Map(vaults.map((item) => [item.id, item]));
      const hasDemo = models.has(sampleKnowledgeID);
      demoLoad.hidden = find('demo-model-label').hidden = hasDemo;
      demoRemove.hidden = !hasDemo;
      vault.replaceChildren(...vaults.map((item) =>
        optionText(item.id === sampleKnowledgeID ? vaultTitle(item) :
          joinText([vaultTitle(item), item.tag, formatDate(item.publishedAt)]), item.id)));
      if (models.has(previous)) vault.value = previous;
      if (!vaults.length) vault.append(optionText(message('knowledge.no-published-releases'), ''));
      describe();
    } catch {
      if (!active.signal.aborted) [status, vaultStatus].forEach(element => setText(element, message('knowledge.could-not-load-published-knowledge-bases-refresh')));
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
    setText(repositoryStatus, write ? message('knowledge.verifying-and-importing-the-release') : message('knowledge.checking-the-folder'));
    try {
      if (write) {
        const report = await request('/api/knowledge/import', { data: { folder: path, allowModel: consent.checked } });
        setText(repositoryStatus, joinText([
          message('knowledge.release-tag-tag', { tag: report.tag }),
          report.active ? (report.state === 'existing' ? message('knowledge.this-release-is-already-imported-and-searchable') : message('knowledge.import-complete-search-is-available')) :
            message('knowledge.this-release-was-kept-a-newer-release'),
          message('knowledge.cards-cards-sources-sources-evidence-passages-passages', { cards: report.cards, sources: report.sources, passages: report.passages, relationships: report.relationships }),
        ], '\n'));
        diagnostics.hidden = false;
        setText(diagnostics.querySelector('p'), message('knowledge.release-version', { version: report.revision }));
        if (!find('knowledge-view').hidden) await refreshVaults(report.vault);
      } else {
        const { publication, repository, errors } = await request('/api/knowledge/inspect', { data: { folder: path } });
        const states = { resolved: message('knowledge.release-tag-and-snapshot-verified'), 'no published version': message('knowledge.no-release-record-found'),
          unresolved: message('knowledge.could-not-read-the-release-record'), 'artifact unavailable': message('knowledge.release-tag-verified-the-snapshot-is-unavailable') };
        setText(repositoryStatus, joinText([states[publication.state],
          repository.type === 'wiki' ? message('knowledge.article-folders-currently-support-validation-only') : '',
        ], '\n'));
        diagnostics.hidden = !errors.length;
        setText(diagnostics.querySelector('p'), joinText(errors.map(issue => joinText([issue.sqlite ? `SQLite ${issue.sqlite}` : issue.area, serverText(issue.detail, errorText(issue.message))])), '\n'));
      }
    } catch (error) {
      setText(repositoryStatus, error instanceof RequestError ? errorText(error) : message('knowledge.could-not-read-the-folder-check-its'));
    } finally {
      importing = false;
      for (const element of [folder, consent, checkFolder, importFolder]) element.disabled = false;
    }
  });
  vault.addEventListener('change', () => { closePreviews(); describe(); });
  let slashAskPath;
  find('knowledge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const path = slashAskPath ?? '/api/knowledge/ask';
    slashAskPath = undefined;
    if (ask.disabled || !question.value.trim()) return;
    const active = pending = new AbortController();
    const selected = models.get(vault.value);
    controls();
    answer.replaceChildren();
    setText(status, message('knowledge.finding-evidence-and-verifying-citations'));
    try {
      const result = await request(path, {
        data: { vault: vault.value, question: question.value }, signal: active.signal,
      });
      if (active.signal.aborted) return;
      if (result.state !== 'verified') {
        setText(status, messages[result.reason] || message('knowledge.could-not-complete-this-query-try-again'));
        return;
      }
      setText(status, message('knowledge.citations-verified'));
      const box = label('article', '');
      box.className = 'message';
      box.append(label('h2', message('knowledge.answer')), label('p', result.answer));
      const release = label('details', '');
      release.append(label('summary', message('ui.advanced')), label('p', message('knowledge.release-version', { version: result.revision })));
      answer.append(box, label('small', joinText([vaultTitle(selected), selected?.tag])));
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
      if (!active.signal.aborted) setText(status, message('knowledge.could-not-complete-this-query-try-again'));
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
    async ask(id, text, path) {
      if (pending) throw new LocalizedError(message('knowledge.a-knowledge-base-query-is-in-progress'));
      showKnowledge(true);
      await refreshVaults();
      if (!models.has(id)) {
        setText(status, messages['vault-unavailable']);
        return;
      }
      vault.value = id;
      describe();
      selectTab(find('knowledge-tab-ask'));
      question.value = text;
      if (!ask.disabled) {
        slashAskPath = path;
        try { find('knowledge-form').requestSubmit(ask); }
        finally { slashAskPath = undefined; }
      }
    },
  };
}
