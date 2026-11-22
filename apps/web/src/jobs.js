import { formatDate, formatList, joinText, message, optionText, setAttribute, setText, t } from './i18n.js';
import { errorText, request, serverText } from './api.js';

const find = (id) => document.getElementById(id);
const panel = find('jobs-content');
const view = find('jobs-view');
const open = find('open-jobs');
const labels = {
  pending: message('jobs.queued-for-delivery'), sent: message('jobs.sent'), failed: message('chat.failed'), indeterminate: message('jobs.delivery-unconfirmed'), sending: message('jobs.sending'),
  draft: message('jobs.awaiting-approval'), active: message('jobs.enabled'), paused: message('jobs.paused'), rejected: message('jobs.rejected'), removed: message('jobs.removed'),
  queued: message('jobs.queued'), missed: message('jobs.skipped'), expired: message('jobs.missed-retry-window'), ready: message('ui.pending'),
  awaiting_review: message('jobs.pending-review'), blocked: message('jobs.more-information-needed'),
  approved: message('jobs.approved'), published: message('jobs.published'), discarded: message('jobs.discarded'),
};

const submitted = message('jobs.submitted-for-review');
const running = message('chat.running');
const otherStatus = message('jobs.other-status');

function jobState(row) {
  return row.completed ? row.review_status === 'pending' ? labels.awaiting_review : labels[row.review_status] ?? submitted :
    row.expires > Date.now() ? running : labels.queued;
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) setText(element, text);
  return element;
}

function content(tag, text) {
  const element = node(tag, text);
  element.dataset.uiContent = '';
  return element;
}

function button(label, action) {
  const element = node('button', label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function field(form, label, value = '', multiline = false) {
  const wrapper = node('label', label);
  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.value = value;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function disclosure(label, className) {
  const menu = node('details');
  menu.className = className;
  menu.append(node('summary', label));
  return menu;
}

const localTime = (timestamp, zone) => formatDate(timestamp, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: zone,
});
const botLabel = (bot) => bot === 'bi' ? message('jobs.knowledge-base-bot') : message('jobs.assistant-bot');
const minute = 60_000;

function upcoming(schedules, occurrences, now) {
  const next = new Map();
  const zones = new Map();
  const admitted = new Set(occurrences.map(({ schedule, wall }) => JSON.stringify([schedule, wall])));
  for (const row of schedules.filter(({ state }) => state === 'active')) {
    if (!zones.has(row.zone)) zones.set(row.zone, []);
    zones.get(row.zone).push(row);
  }
  for (const [zone, rows] of zones) {
    const clock = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const first = (Math.floor(now / minute) + 1) * minute;
    let waiting = rows;
    // Scan actual minutes so daylight saving gaps and repeated times follow the scheduler.
    for (let at = first; waiting.length && at < first + 72 * 60 * minute; at += minute) {
      const wall = clock.format(at).replace(', ', 'T');
      waiting = waiting.filter((row) => {
        if (at < row.since || wall.slice(11) !== row.time || admitted.has(JSON.stringify([row.id, wall]))) return true;
        next.set(row.id, at);
        return false;
      });
    }
  }
  return next;
}

export function bindJobs(openPreview) {
  const statusMessage = find('jobs-status');
  const previews = new Map();
  const feedback = new Set([statusMessage]);
  let currentMessage;
  const say = (text) => {
    currentMessage = text;
    for (const region of feedback) setText(region, text);
  };
  let status;
  let updating = false;
  let filterValue = '';

  function preview(key, title, opener, draw) {
    const tab = openPreview('jobs-' + key, title, opener);
    if (previews.has(key)) return;
    const notice = node('p', currentMessage);
    notice.setAttribute('role', 'status');
    tab.body.before(notice);
    feedback.add(notice);
    const render = () => {
      const disclosures = [...tab.body.querySelectorAll('details')].map(({ open }) => open);
      tab.body.replaceChildren();
      draw(tab.body);
      [...tab.body.querySelectorAll('details')].forEach((details, index) => { details.open = disclosures[index] ?? false; });
    };
    previews.set(key, render);
    tab.signal.addEventListener('abort', () => {
      previews.delete(key);
      feedback.delete(notice);
    }, { once: true });
    render();
  }

  function control(parent, label, work, key = label) {
    const item = button(label, (event) => work(event.currentTarget));
    item.toggleAttribute('data-ui-content', typeof label === 'string');
    setAttribute(item, 'data-feature-focus', key);
    parent.append(item);
    return item;
  }

  async function update(data) {
    if (updating) return;
    updating = true;
    say(message('ui.loading'));
    try {
      status = await request('/api/jobs', data ? { data } : undefined);
      const focus = document.activeElement?.dataset.featureFocus;
      render();
      for (const draw of previews.values()) draw();
      if (focus) {
        const matches = document.querySelectorAll(`[data-feature-focus="${CSS.escape(focus)}"]`);
        [...matches].find((item) => item.getClientRects().length && !item.closest('[inert]'))?.focus({ preventScroll: true });
      }
      say(data ? message('jobs.updated') : '');
    } catch (error) { say(errorText(error)); }
    finally { updating = false; }
  }

  function history(body, schedule) {
    const rows = (status.occurrences ?? []).filter((row) => !schedule || row.schedule === schedule);
    if (!rows.length) body.append(node('p', message('jobs.no-run-history-yet')));
    const list = node('ul');
    for (const row of rows) {
      const item = node('li');
      item.append(content('span', row.schedule), ' · ', node('span', joinText([localTime(row.utc, row.zone), labels[row.state] ?? message('chat.unknown-status')])));
      const details = disclosure(message('ui.advanced'), 'feature-advanced');
      details.append(content('p', `${row.wall} ${row.zone} · ${new Date(row.utc).toISOString()}`));
      item.append(details);
      list.append(item);
    }
    body.append(list);
  }

  function scheduleEditor(body, row) {
    const id = field(body, message('jobs.schedule-name'), row?.id);
    const time = field(body, message('jobs.local-time'), row?.time ?? '09:00');
    time.type = 'time';
    const zone = field(body, message('jobs.time-zone'), row?.zone ?? 'Asia/Taipei');
    const advanced = disclosure(message('ui.advanced'), 'feature-advanced');
    body.append(advanced);
    const candidate = field(advanced, message('jobs.job-parameters-json'), row ? JSON.stringify(JSON.parse(row.payload), null, 2) : '', true);
    const error = node('p');
    error.setAttribute('role', 'status');
    const save = (action) => {
      try {
        const payload = JSON.parse(candidate.value);
        void update(action === 'schedule' ? { action, id: id.value, zone: zone.value, time: time.value, candidate: payload }
          : { action, id: id.value, candidate: payload });
      } catch {
        advanced.open = true;
        setText(error, message('jobs.could-not-read-the-job-settings-check'));
        candidate.focus();
      }
    };
    advanced.append(error);
    control(body, message('jobs.save-schedule-for-approval'), () => save('schedule'));
    control(body, message('jobs.submit-job-now'), () => save('immediate'));
  }

  function inbox(body) {
    body.append(node('p', message('jobs.assistant-bot-assistant-knowledge-base-bot-knowledge', { assistant: status.main ? message('chat.configured') : message('chat.unconfigured'), knowledge: status.bi ? message('chat.configured') : message('chat.unconfigured') })));
    const settings = disclosure(message('ui.advanced'), 'feature-advanced');
    const domain = field(settings, message('jobs.domain'), status.domain || 'telegram');
    const origins = field(settings, message('jobs.approved-https-sources-one-per-line'), status.origins.join('\n'), true);
    const target = field(settings, message('jobs.target-knowledge-base-id-optional'), status.target);
    settings.append(node('p', message('jobs.with-no-target-selected-each-intake-item')));
    control(settings, message('jobs.save-intake-settings'), () => update({
      action: 'configure', domain: domain.value, origins: origins.value.split(/\s+/).filter(Boolean), target: target.value.trim(),
    }));
    const filter = node('select');
    setAttribute(filter, 'aria-label', message('jobs.filter-by-intake-status'));
    filter.append(optionText(message('ui.all'), ''), ...['ready', 'blocked', 'awaiting_review'].map((value) => optionText(labels[value], value)));
    filter.value = filterValue;
    const sources = node('div');
    const showSources = () => {
      const matches = status.sources.filter((source) => !filter.value || source.state === filter.value);
      sources.replaceChildren(node('p', message('jobs.results-count', { count: matches.length })));
      for (const row of matches) control(sources, message('jobs.intake-id-status', { id: row.id, status: labels[row.state] }), (opener) =>
        preview('source-' + row.id, message('jobs.intake-id', { id: row.id }), opener, (content) => showSource(content, row.id)));
    };
    filter.addEventListener('change', () => { filterValue = filter.value; showSources(); });
    body.append(settings, filter, sources);
    showSources();
  }

  function showSource(body, id) {
    const source = status.sources.find((row) => row.id === id);
    if (!source) { body.append(node('p', message('jobs.could-not-find-this-intake-item'))); return; }
    const summary = node('p');
    summary.append(content('span', source.domain), ' · ', node('span', labels[source.state]));
    body.append(summary);
    const details = disclosure(message('ui.advanced'), 'feature-advanced');
    details.append(content('p', source.ref), node('p', source.target ? message('jobs.target-knowledge-base-target', { target: source.target }) : message('jobs.standalone-intake')));
    if (source.reason) details.append(node('p', serverText(source.reasonDetail, errorText(source.reason))));
    body.append(details);
    if (source.hasFile) {
      const download = node('a', message('jobs.download-source'));
      download.href = '/api/jobs/source/' + source.id;
      body.append(download);
    }
    if (source.state === 'blocked') {
      const text = field(body, message('jobs.additional-information'), '', true);
      control(body, message('jobs.submit-for-review'), () => update({ action: 'supplement', id, text: text.value }));
    }
  }

  function delivery(body) {
    if (!status.delivery.length) body.append(node('p', message('jobs.no-notification-history-yet')));
    for (const row of status.delivery) body.append(node('p', message('jobs.bot-status-count-count', { bot: botLabel(row.bot), status: labels[row.state] ?? message('chat.unknown-status'), count: row.count })));
    if (status.unresolvedDelivery.length) {
      const unresolved = disclosure(message('jobs.notifications-to-verify'), 'feature-more');
      for (const row of status.unresolvedDelivery) {
        const line = node('p', message('jobs.bot-status-attempts-count', { bot: botLabel(row.bot), status: labels[row.state], count: row.attempts }));
        const details = disclosure(message('ui.advanced'), 'feature-advanced');
        details.append(node('p', message('jobs.notification-id-id', { id: row.id })));
        unresolved.append(line, details);
        if (row.state === 'indeterminate') control(unresolved, message('jobs.resend-manually'), () => {
          if (window.confirm(t('jobs.the-original-notification-may-have-arrived-resending'))) {
            void update({ action: 'resend', bot: row.bot, id: row.id });
          }
        }, 'resend-' + row.bot + '-' + row.id);
      }
      body.append(unresolved);
    }
    for (const row of status.failedIntakes) {
      body.append(node('p', message('jobs.bot-intake-id-failed-attempts-count-date', { bot: botLabel(row.bot), id: row.id, count: row.attempts, date: localTime(row.firstSeen) })));
    }
  }

  function render() {
    const { jobs, schedules = [], occurrences = [] } = status;
    const next = upcoming(schedules, occurrences, Date.now());
    const toolbar = node('div');
    toolbar.className = 'knowledge-pager';
    control(toolbar, message('jobs.new-schedule'), (opener) => preview('editor', message('jobs.new-schedule'), opener, (body) => scheduleEditor(body)));
    control(toolbar, message('jobs.run-history'), (opener) => preview('history', message('jobs.run-history'), opener, history));
    control(toolbar, message('jobs.refresh'), () => update());
    const more = disclosure(message('ui.more'), 'feature-more');
    more.querySelector('summary').dataset.featureFocus = 'jobs-more';
    control(more, message('jobs.telegram-intake'), (opener) => preview('inbox', message('jobs.telegram-intake'), opener, inbox));
    control(more, message('jobs.notification-history'), (opener) => preview('delivery', message('jobs.notification-history'), opener, delivery));
    toolbar.append(more);
    const list = node('ul');
    list.className = 'feature-list';
    for (const row of schedules.filter(({ state }) => state !== 'removed')) {
      const item = node('li');
      const state = labels[row.state];
      const when = next.has(row.id) ? message('jobs.next-run-time', { time: localTime(next.get(row.id), row.zone) }) : message('jobs.no-upcoming-run');
      control(item, row.id, (opener) => preview('schedule-' + row.id, row.id, opener, (body) => {
        const latest = (status.schedules ?? []).find(({ id }) => id === row.id);
        body.append(node('p', labels[latest?.state] ?? message('jobs.removed')));
        if (!latest || latest.state === 'removed') return;
        body.append(node('p', message('jobs.daily-at-time-zone', { time: latest.time, zone: latest.zone })));
        control(body, message('jobs.run-history'), (trigger) => preview('history-' + row.id, message('jobs.run-history-name', { name: row.id }), trigger,
          (content) => history(content, row.id)), 'schedule-history-' + row.id);
      }), 'schedule-' + row.id);
      item.append(node('small', joinText([state, when])));
      const actions = disclosure(message('ui.more'), 'feature-more');
      actions.querySelector('summary').dataset.featureFocus = 'schedule-more-' + row.id;
      control(actions, message('jobs.edit'), (opener) => preview('edit-' + row.id, message('jobs.edit-schedule-name', { name: row.id }), opener, (body) => {
        const latest = (status.schedules ?? []).find(({ id }) => id === row.id);
        if (latest?.state !== 'removed') scheduleEditor(body, latest);
      }), 'schedule-more-' + row.id);
      const changes = row.state === 'draft' ? [['active', message('jobs.approve')], ['rejected', message('jobs.reject')]] :
        row.state === 'active' ? [['paused', message('jobs.pause')]] : row.state === 'paused' ? [['active', message('jobs.resume')]] : [];
      for (const [state, label] of [...changes, ['removed', message('chat.remove')]]) {
        control(actions, label, () => update({ action: 'state', id: row.id, state }), 'schedule-more-' + row.id);
      }
      if (['active', 'paused'].includes(row.state)) {
        control(actions, message('jobs.run-now'), () => update({ action: 'runNow', id: row.id }), 'schedule-more-' + row.id);
      }
      item.append(actions);
      list.append(item);
    }
    for (const [index, row] of jobs.entries()) {
      const item = node('li');
      const title = occurrences.find(({ job }) => job === row.id)?.schedule ?? message('jobs.knowledge-base-job-number', { number: jobs.length - index });
      control(item, title, (opener) => preview('job-' + row.id, title, opener, (body) => {
        const latest = status.jobs.find(({ id }) => id === row.id);
        if (!latest) { body.append(node('p', message('jobs.could-not-find-this-job'))); return; }
        body.append(node('p', jobState(latest)));
        const details = disclosure(message('ui.advanced'), 'feature-advanced');
        details.append(node('p', message('jobs.job-id-id', { id: latest.id })));
        body.append(details);
      }), 'job-' + row.id);
      item.append(node('small', jobState(row)));
      if (!row.completed) {
        const actions = disclosure(message('ui.more'), 'feature-more');
        actions.querySelector('summary').dataset.featureFocus = 'job-more-' + row.id;
        control(actions, message('jobs.run-now'), () => update({ action: 'runJob', id: row.id }), 'job-more-' + row.id);
        item.append(actions);
      }
      list.append(item);
    }
    panel.replaceChildren(toolbar, list.childElementCount ? list : node('p', message('jobs.no-schedules-or-jobs-yet')));
  }

  open.addEventListener('click', () => {
    const show = view.hidden;
    find('knowledge-view').hidden = true;
    find('chat-view').hidden = show;
    view.hidden = !show;
    if (show) {
      find('jobs-title').focus();
      void update();
    }
  });
  find('open-knowledge').addEventListener('click', () => { view.hidden = true; });
  find('panel-jobs-link').addEventListener('click', () => open.click());
}

export async function loadJobSummary() {
  const summary = find('panel-jobs');
  setText(summary, message('jobs.loading-schedules-and-jobs'));
  try {
    const status = await request('/api/jobs');
    const counts = (rows, stateLabel) => {
      const totals = new Map();
      for (const row of rows) {
        const state = stateLabel(row);
        totals.set(state, (totals.get(state) ?? 0) + 1);
      }
      return totals.size ? formatList([...totals].map(([state, count]) => message('jobs.status-count', { status: state, count }))) : message('jobs.none');
    };
    setText(summary, message('jobs.knowledge-base-jobs-jobs-schedules-schedules', { jobs: counts(status.jobs, jobState), schedules: counts(status.schedules ?? [], (row) => labels[row.state] ?? otherStatus) }));
  } catch { setText(summary, message('jobs.could-not-load-schedules-and-jobs-refresh')); }
}
