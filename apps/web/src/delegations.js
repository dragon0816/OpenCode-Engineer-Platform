import { errorText, request } from './api.js';
import { formatDate, message, resolveText, setText, t } from './i18n.js';
import { confirmExternal } from './external-helpers.js';

const statuses = {
  queued: message('delegations.status.queued'),
  awaiting_confirmation: message('externalHelpers.confirm.awaiting'),
  running: message('delegations.status.running'),
  succeeded: message('delegations.status.succeeded'),
  needs_input: message('delegations.status.needs_input'),
  failed: message('delegations.status.failed'),
  timed_out: message('delegations.status.timed_out'),
  cancelled: message('delegations.status.cancelled'),
  indeterminate: message('delegations.status.indeterminate'),
  accepted: message('delegations.status.accepted'),
  awaiting_permission: message('delegations.status.awaiting_permission'),
  background: message('delegations.status.background'),
  verified: message('delegations.status.verified'),
  deduplicated: message('delegations.status.deduplicated'),
};
const reasons = {
  'accepted': () => message('delegations.event.accepted'),
  'claimed': () => message('delegations.event.claimed'),
  'completed-during-cancellation': () => message('delegations.event.completed-during-cancellation'),
  'cancellation-requested': () => message('delegations.event.cancellation-requested'),
  'outcome-already-recorded': () => message('delegations.event.outcome-already-recorded'),
  'cancelled-before-dispatch': () => message('delegations.event.cancelled-before-dispatch'),
  'cancelled-by-owner': () => message('delegations.event.cancelled-by-owner'),
  'queue-expired': () => message('delegations.event.queue-expired'),
  'execution-deadline': () => message('delegations.event.execution-deadline'),
  'same-key': () => message('delegations.event.same-key'),
  'same-content': () => message('delegations.event.same-content'),
  'notice-pending': () => message('delegations.event.notice-pending'),
  'owner-resolved': () => message('delegations.event.owner-resolved'),
  'child-model-cap': () => message('delegations.event.child-model-cap'),
  'child-tool-cap': () => message('delegations.event.child-tool-cap'),
  'child-tool-or-turn-limit': () => message('delegations.event.child-tool-or-turn-limit'),
  'bi-source-required': () => message('delegations.event.bi-source-required'),
  'restart-reconciliation': () => message('delegations.event.restart-reconciliation'),
  requests: (metrics) => message('delegations.event.requests', metrics),
  tools: (metrics) => message('delegations.event.tools', metrics),
  'external-owner-confirmed': () => message('externalHelpers.confirm.recorded'),
  'external-confirmation-required': () => message('externalHelpers.confirm.awaiting'),
  'external-owner-selection': () => message('externalHelpers.confirm.selected'),
  'external-gate-passed': () => message('externalHelpers.gate.passed'),
  'external-budget-unavailable': () => message('externalHelpers.event.budgetUnavailable'),
  'external-budget-charged': () => message('externalHelpers.event.budgetCharged'),
  'external-job-stopped': () => message('externalHelpers.event.jobStopped'),
  'external-copy-discarded': () => message('externalHelpers.event.copyDiscarded'),
  'external-copy-unsafe': () => message('externalHelpers.event.copyUnsafe'),
  'external-output-limit': () => message('externalHelpers.event.outputLimit'),
  'external-cli-output-limit': () => message('externalHelpers.event.outputLimit'),
  'external-cli-invalid-output': () => message('externalHelpers.event.invalidOutput'),
  'external-cli-failed': () => message('externalHelpers.event.cliFailed'),
  'external-stop-unverified': () => message('externalHelpers.event.stopUnverified'),
};
const statusText = (status) => statuses[status] ?? message('delegations.status.indeterminate');
const route = (id) => '/api/delegations/' + id;
const pending = (status) => status === 'running' || status === 'queued' || status === 'awaiting_confirmation';

export function bindDelegationResults({ node, action, openPreview, openRunTab, openReview, toolCard, showError, refresh }) {
  function control(label, id, key, handler) {
    const button = action(label, handler);
    button.dataset.featureFocus = 'delegation-' + id + '-' + key;
    return button;
  }

  function appendFiles(container, item, context) {
    if (!item.files?.length) return;
    const list = node('ul', undefined, 'delegation-files');
    for (const file of item.files) {
      const url = route(item.delegationId) + '/files/' + file.fileId;
      const row = node('li');
      const name = node('span', file.name);
      name.setAttribute('data-ui-content', '');
      const download = node('a', message('chat.download'));
      download.href = url;
      download.download = file.name;
      download.dataset.featureFocus = 'delegation-download-' + file.fileId;
      const preview = control(message('chat.preview'), file.fileId, 'preview', () => {
        void openPreview(file, url, context, preview, { plainText: true });
      });
      row.append(name, preview, download);
      list.append(row);
    }
    container.append(list);
  }

  function reviewControl(item, context, signal = context.abort.signal) {
    return control(message('delegations.open-review'), item.delegationId, 'review',
      (event) => void openReview(item.reviewRef.reviewId, event.currentTarget, signal).catch((error) => {
        if (!signal.aborted) showError(error);
      }));
  }

  function renderRun(body, detail, context, signal) {
    const focused = body.contains(document.activeElement) && document.activeElement;
    const tools = new Map([...body.querySelectorAll('.tool-card')].map((tool) => [tool.dataset.tool, tool]));
    const awaiting = detail.receipt.status === 'queued' && detail.externalApproval?.decision === null;
    body.replaceChildren(node('p', statusText(awaiting ? 'awaiting_confirmation' : detail.receipt.status)));
    const { run, events, result, receipt } = detail;
    if (run?.model) body.append(node('p', message('delegations.model', { model: run.model })));
    if (run?.task) {
      const task = node('p', run.task, 'delegation-transcript');
      task.setAttribute('data-ui-content', '');
      body.append(node('strong', message('delegations.task')), task);
    }
    if (run?.intake) {
      const { id, hasFile } = run.intake;
      body.append(node('p', message('jobs.intake-id', { id })));
      if (hasFile) {
        const link = node('a', message('delegations.download-source'));
        link.href = '/api/jobs/source/' + id;
        body.append(link);
      }
    }
    if (result?.reviewRef) body.append(reviewControl(result, context, signal));
    appendFiles(body, result ?? receipt, context);
    body.append(node('h3', message('delegations.timeline')));
    const timeline = node('ol', undefined, 'delegation-timeline');
    const transitions = (run?.timeline ?? []).map(({ at, state }) => ({ at, label: statusText(state) }));
    for (const event of events) {
      const label = Object.hasOwn(reasons, event.reasonCode) ? reasons[event.reasonCode](event.metrics) : statusText(event.state);
      transitions.push({ at: event.at, label });
    }
    for (const { at, label } of transitions.sort((left, right) => left.at - right.at)) {
      const row = node('li');
      row.append(node('time', formatDate(at)), node('span', label));
      timeline.append(row);
    }
    body.append(timeline);
    if (run?.messagesUnavailable) body.append(node('p', message('delegations.transcript-unavailable')));
    if (run?.messages?.length) {
      body.append(node('h3', message('delegations.transcript')));
      for (const item of run.messages) {
        const entry = node('div', undefined, 'delegation-transcript');
        entry.append(node('strong', item.role === 'user' ? message('delegations.task') : message('delegations.response')));
        if (item.text) {
          const text = node('p', item.text);
          text.setAttribute('data-ui-content', '');
          entry.append(text);
        }
        for (const tool of item.tools ?? []) entry.append(toolCard(tool, tools.get(tool.id)));
        body.append(entry);
      }
    }
    if (focused) {
      const key = focused.dataset.featureFocus;
      const replacement = key && body.querySelector(`[data-feature-focus="${CSS.escape(key)}"]`);
      (focused.isConnected ? focused : replacement || body.closest('[role="tabpanel"]'))?.focus({ preventScroll: true });
    }
  }

  function updateRun(context, id) {
    const entry = context.delegationRuns?.get(id);
    if (!entry) return;
    if (entry.loading) { entry.dirty = true; return; }
    entry.loading = true;
    const { body, signal } = entry.tab;
    void request(route(id), { signal }).then((detail) => {
      if (signal.aborted) return;
      const signature = JSON.stringify(detail);
      if (signature !== entry.signature) {
        renderRun(body, detail, context, signal);
        entry.signature = signature;
      }
    }).catch((error) => {
      if (signal.aborted) return;
      entry.signature = undefined;
      body.replaceChildren(node('p', errorText(error)));
    }).finally(() => {
      entry.loading = false;
      if (entry.dirty) { entry.dirty = false; updateRun(context, id); }
    });
  }

  function seen(context, id) {
    return request(`${context.path}/delegation-seen`, { data: { id }, signal: context.abort.signal })
      .then(() => refresh(context)).catch((error) => {
        if (!context.abort.signal.aborted) showError(error);
      });
  }

  function card(item, context) {
    const id = item.delegationId;
    const name = item.targetAgentId === 'bi' && item.specialistName === 'BI 資料處理'
      ? message('agents.bi') : item.specialistName;
    const section = node('section', undefined, 'delegation-card');
    section.dataset.delegation = id;
    section.dataset.status = item.status;
    const header = node('div', undefined, 'delegation-header');
    const title = node('strong', name);
    title.toggleAttribute('data-ui-content', typeof name === 'string');
    header.append(title, node('span', statusText(item.status), 'delegation-status'));
    if (item.unread) header.append(node('span', message('delegations.unread'), 'delegation-unread'));
    section.append(header);
    if (item.externalConfirmation) section.append(node('p',
      item.externalConfirmation.decision === 'confirmed' ? message('externalHelpers.confirm.recorded') : message('externalHelpers.confirm.selected')));
    if (!pending(item.status)) {
      const status = node('p', message('delegations.completion', { status: statusText(item.status) }));
      status.setAttribute('role', 'status');
      section.append(status);
    }
    if (item.completedDuringCancellation) section.append(node('p', message('delegations.event.completed-during-cancellation')));
    if (item.reviewRef) section.append(node('p', message('delegations.submitted')));
    else if (item.changes) section.append(node('p', item.changes.count
      ? message('externalHelpers.result.changes', { count: item.changes.count }) : message('externalHelpers.result.noChanges')));
    else if (item.summary) {
      const summary = node('p', item.summary);
      summary.setAttribute('data-ui-content', '');
      section.append(summary);
    }
    if (item.published) {
      const publication = node('p', message('delegations.published'));
      publication.setAttribute('role', 'status');
      section.append(publication);
    }
    appendFiles(section, item, context);
    const actions = node('div', undefined, 'delegation-actions');
    const open = control(message('delegations.view-run'), id, 'run', () => {
      context.delegationRuns ??= new Map();
      const tab = openRunTab('delegation-' + id, name, open);
      if (!context.delegationRuns.has(id)) {
        context.delegationRuns.set(id, { tab });
        tab.signal.addEventListener('abort', () => context.delegationRuns.delete(id), { once: true });
        setText(tab.body, message('delegations.loading'));
      }
      updateRun(context, id);
      if (item.unread) void seen(context, id);
    });
    actions.append(open);
    if (item.status === 'awaiting_confirmation') actions.append(control(message('externalHelpers.confirm.review'), id, 'confirm',
      (event) => void confirmExternal(id, resolveText(name), event.currentTarget, context.abort.signal, () => refresh(context))
        .catch((error) => { if (!context.abort.signal.aborted) showError(error); })));
    if (item.reviewRef) actions.append(reviewControl(item, context));
    if (item.unread) actions.append(control(message('delegations.mark-read'), id, 'read', () => void seen(context, id)));
    if (pending(item.status)) actions.append(control(message('delegations.cancel'), id, 'cancel', async (event) => {
      if (!window.confirm(t('delegations.confirm-cancel', { name: resolveText(name) }))) return;
      const button = event.currentTarget;
      button.disabled = true;
      setText(button, message('delegations.cancelling'));
      try {
        await request(route(id) + '/cancel', { data: {}, signal: context.abort.signal });
        refresh(context);
      } catch (error) {
        if (!context.abort.signal.aborted) showError(error);
      } finally {
        button.disabled = false;
        setText(button, message('delegations.cancel'));
      }
    }));
    section.append(actions);
    return section;
  }

  return {
    place(context, fragment, anchors) {
      const previous = context.delegationCards ?? new Map();
      const next = new Map();
      for (const item of context.state.delegations ?? []) {
        const id = item.delegationId;
        const signature = JSON.stringify(item);
        const old = previous.get(id);
        const element = old?.signature === signature ? old.element : card(item, context);
        (anchors.get(item.parentRunId) ?? fragment).append(element);
        next.set(id, { element, signature });
        if (old?.signature !== signature) updateRun(context, id);
      }
      context.delegationCards = next;
    },
    updateOpen(context) {
      for (const id of context.delegationRuns?.keys() ?? []) updateRun(context, id);
    },
  };
}
