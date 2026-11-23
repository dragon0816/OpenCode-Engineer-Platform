import { errorText, request } from './api.js';
import { bindFilePicker, joinText, message, optionText, setText } from './i18n.js';

const endpoint = '/api/knowledge/bi-documents';
const active = new Set(['converting', 'extracting', 'validating']);
const find = id => document.getElementById('bi-document-' + id);
const states = {
  'converting': message('biDocument.state.converting'),
  'validating': message('biDocument.state.validating'),
  'awaiting-review': message('biDocument.state.awaiting-review'),
  'needs-attention': message('biDocument.state.needs-attention'),
  'failed': message('biDocument.state.failed'),
};
const candidateStates = {
  'pass': message('biDocument.candidate.pass'),
  'awaiting-review': message('biDocument.candidate.awaiting-review'),
  'needs-attention': message('biDocument.candidate.needs-attention'),
};
const issues = {
  'ocr': message('biDocument.issue.ocr'),
  'pdf-unavailable': message('biDocument.issue.pdf-unavailable'),
  'pdf-encrypted': message('biDocument.issue.pdf-encrypted'),
  'limit': message('biDocument.issue.limit'),
  'encoding': message('biDocument.issue.encoding'),
  'empty': message('biDocument.issue.empty'),
  'invalid': message('biDocument.issue.invalid'),
  'link': message('biDocument.issue.link'),
  'model': message('biDocument.issue.model'),
  'interrupted': message('biDocument.issue.interrupted'),
  'base-changed': message('biDocument.issue.base-changed'),
  'no-candidates': message('biDocument.issue.no-candidates'),
  'missing-evidence': message('biDocument.issue.missing-evidence'),
  'invalid-quote': message('biDocument.issue.invalid-quote'),
  'unsupported-value': message('biDocument.issue.unsupported-value'),
  'unknown-field': message('biDocument.issue.unknown-field'),
  'invalid-name': message('biDocument.issue.invalid-name'),
  'conflicting-value': message('biDocument.issue.conflicting-value'),
  'duplicate': message('biDocument.issue.duplicate'),
};

export function bindBiDocuments(openReview) {
  const panel = find('panel');
  const file = find('file');
  const url = find('url');
  const schema = find('schema');
  const run = find('run');
  const review = find('review');
  const status = find('status');
  const results = find('candidates');
  let current;
  let busy = false;
  let initialized = false;
  bindFilePicker(file);
  const picker = file.nextElementSibling.querySelector('button');

  function choices(items) {
    const previous = schema.value;
    schema.replaceChildren(...items.map(item => optionText(item.builtin ? message('biDocument.builtin') :
      joinText([item.title, item.title === item.schema ? '' : item.schema, item.version]), item.id)));
    if (items.some(item => item.id === previous)) schema.value = previous;
  }

  function controls() {
    run.disabled = busy || !schema.value;
    url.disabled = schema.disabled = find('consent').disabled = busy;
    picker.disabled = file.disabled = busy;
  }

  file.addEventListener('change', () => { if (file.files.length) url.value = ''; });
  url.addEventListener('input', () => {
    if (url.value.trim() && file.files.length) {
      file.value = '';
      file.dispatchEvent(new Event('change'));
    }
  });

  function draw(result) {
    current = result;
    const reviewState = { approved: message('jobs.approved'), rejected: message('jobs.rejected'), published: message('jobs.published') };
    const progress = result.state === 'extracting' ? message('biDocument.progress', {
      completed: result.completedChunks, total: result.totalChunks,
    }) : reviewState[result.reviewState] || states[result.state];
    setText(status, joinText([result.source.title || result.source.ref, progress,
      result.issue && issues[result.issue]], '\n'));
    const list = document.createElement('ul');
    for (const candidate of result.candidates) {
      const item = document.createElement('li');
      setText(item, joinText([candidate.name || message('biDocument.unnamed'),
        candidateStates[candidate.state]], ' · '));
      if (candidate.issues.length) {
        const findings = document.createElement('ul');
        for (const finding of candidate.issues) {
          const entry = document.createElement('li');
          setText(entry, joinText([finding.field, issues[finding.code]], ' · '));
          findings.append(entry);
        }
        item.append(findings);
      }
      list.append(item);
    }
    results.replaceChildren(...(list.childElementCount ? [list] : []));
    review.hidden = !result.reviewId;
  }

  async function watch(result) {
    draw(result);
    while (active.has(result.state)) {
      await new Promise(resolve => setTimeout(resolve, 450));
      result = await request(endpoint + '/runs/' + result.id);
      draw(result);
    }
  }

  panel.addEventListener('toggle', async () => {
    if (!panel.open || initialized) return;
    initialized = true;
    busy = true;
    controls();
    try {
      const [catalog, history] = await Promise.all([request(endpoint + '/schemas'), request(endpoint + '/runs')]);
      choices(catalog.choices);
      if (history.runs.length) await watch(history.runs[0]);
    } catch (error) {
      initialized = false;
      setText(status, errorText(error));
    } finally {
      busy = false;
      controls();
    }
  });

  find('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const selected = file.files[0];
    const link = url.value.trim();
    if (Boolean(selected) === Boolean(link)) {
      setText(status, message('biDocument.chooseOne'));
      return;
    }
    const allowModel = find('consent').checked;
    busy = true;
    controls();
    results.replaceChildren();
    review.hidden = true;
    setText(status, message('biDocument.state.converting'));
    try {
      const result = selected ? await request(endpoint + '/file/' + schema.value + '/' + Number(allowModel), { file: selected }) :
        await request(endpoint + '/link', { data: { url: link, schema: schema.value, allowModel } });
      await watch(result);
    } catch (error) {
      setText(status, errorText(error));
    } finally {
      busy = false;
      controls();
    }
  });

  find('import').addEventListener('submit', async event => {
    event.preventDefault();
    const feedback = find('import-status');
    event.submitter.disabled = true;
    try {
      const result = await request(endpoint + '/schemas', { data: { folder: find('folder').value.trim() } });
      choices(result.choices);
      controls();
      setText(feedback, message('biDocument.imported', { count: result.count }));
    } catch (error) { setText(feedback, errorText(error)); }
    finally { event.submitter.disabled = false; }
  });

  review.addEventListener('click', async () => {
    if (!current?.reviewId) return;
    const opener = document.getElementById('open-review');
    opener.click();
    try { await openReview(current.reviewId, opener, new AbortController().signal); }
    catch (error) { setText(document.getElementById('review-status'), errorText(error)); }
  });
}
