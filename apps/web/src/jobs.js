import { request } from './api.js';

const find = (id) => document.getElementById(id);
const panel = find('jobs-content');
const view = find('jobs-view');
const open = find('open-jobs');
const labels = {
  pending: '等待送出', sent: '已送出', failed: '失敗', indeterminate: '送達未確認', sending: '傳送中',
  draft: '待批准', active: '已啟用', paused: '已暫停', rejected: '已拒絕', removed: '已移除',
  queued: '等待執行', missed: '已略過', expired: '超過補跑期限', ready: '待處理',
  awaiting_review: '待審核', blocked: '需要補件',
  approved: '已批准', published: '已發布', discarded: '已捨棄',
};

function jobState(row) {
  return row.completed ? row.review_status === 'pending' ? '待審核' : labels[row.review_status] ?? '已送審' :
      row.expires > Date.now() ? '執行中' : '等待執行';
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, action) {
  const element = node('button', label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function field(form, label, value = '', multiline = false) {
  const wrapper = node('label', label + ' ');
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

const localTime = (timestamp, zone) => new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: zone,
}).format(timestamp);
const botLabel = (bot) => bot === 'bi' ? '知識庫機器人' : '助理機器人';
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
  const say = (message) => { for (const region of feedback) region.textContent = message; };
  let status;
  let updating = false;
  let filterValue = '';

  function preview(key, title, opener, draw) {
    const tab = openPreview('jobs-' + key, title, opener);
    if (previews.has(key)) return;
    const notice = node('p', statusMessage.textContent);
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
    item.dataset.featureFocus = key;
    parent.append(item);
    return item;
  }

  async function update(data) {
    if (updating) return;
    updating = true;
    say('正在讀取…');
    try {
      status = await request('/api/jobs', data ? { data } : undefined);
      const focus = document.activeElement?.dataset.featureFocus;
      render();
      for (const draw of previews.values()) draw();
      if (focus) {
        const matches = document.querySelectorAll(`[data-feature-focus="${CSS.escape(focus)}"]`);
        [...matches].find((item) => item.getClientRects().length && !item.closest('[inert]'))?.focus({ preventScroll: true });
      }
      say(data ? '已更新。' : '');
    } catch (error) { say(error.message); }
    finally { updating = false; }
  }

  function history(body, schedule) {
    const rows = (status.occurrences ?? []).filter((row) => !schedule || row.schedule === schedule);
    if (!rows.length) body.append(node('p', '目前沒有執行紀錄。'));
    const list = node('ul');
    for (const row of rows) {
      const item = node('li', `${row.schedule} · ${localTime(row.utc, row.zone)} · ${labels[row.state] ?? row.state}`);
      const details = disclosure('進階', 'feature-advanced');
      details.append(node('p', `${row.wall} ${row.zone} · ${new Date(row.utc).toISOString()}`));
      item.append(details);
      list.append(item);
    }
    body.append(list);
  }

  function scheduleEditor(body, row) {
    const id = field(body, '排程名稱', row?.id);
    const time = field(body, '當地時間', row?.time ?? '09:00');
    time.type = 'time';
    const zone = field(body, '時區', row?.zone ?? 'Asia/Taipei');
    const advanced = disclosure('進階', 'feature-advanced');
    body.append(advanced);
    const candidate = field(advanced, '工作參數（JSON）', row ? JSON.stringify(JSON.parse(row.payload), null, 2) : '', true);
    const error = node('p');
    error.setAttribute('role', 'status');
    const save = (action) => {
      try {
        const payload = JSON.parse(candidate.value);
        void update(action === 'schedule' ? { action, id: id.value, zone: zone.value, time: time.value, candidate: payload }
          : { action, id: id.value, candidate: payload });
      } catch {
        advanced.open = true;
        error.textContent = '工作參數須為有效的 JSON。';
        candidate.focus();
      }
    };
    advanced.append(error);
    control(body, '儲存待核准排程', () => save('schedule'));
    control(body, '立即送出工作', () => save('immediate'));
  }

  function inbox(body) {
    body.append(node('p', `助理機器人${status.main ? '已設定' : '未設定'} · 知識庫機器人${status.bi ? '已設定' : '未設定'}`));
    const settings = disclosure('進階', 'feature-advanced');
    const domain = field(settings, '領域', status.domain || 'telegram');
    const origins = field(settings, '核准的 HTTPS 來源（每行一個）', status.origins.join('\n'), true);
    const target = field(settings, '目標知識庫代號（選填）', status.target);
    settings.append(node('p', '未指定目標時，每筆收件會建立獨立草稿。指定目標後，來源會送到模型服務產生提案，再由人工核准及發布。'));
    control(settings, '儲存收件設定', () => update({
      action: 'configure', domain: domain.value, origins: origins.value.split(/\s+/).filter(Boolean), target: target.value.trim(),
    }));
    const filter = node('select');
    filter.setAttribute('aria-label', '收件狀態篩選');
    filter.append(new Option('全部', ''), ...['ready', 'blocked', 'awaiting_review'].map((value) => new Option(labels[value], value)));
    filter.value = filterValue;
    const sources = node('div');
    const showSources = () => {
      const matches = status.sources.filter((source) => !filter.value || source.state === filter.value);
      sources.replaceChildren(node('p', `${matches.length} 筆`));
      for (const row of matches) control(sources, `收件 ${row.id} · ${labels[row.state]}`, (opener) =>
        preview('source-' + row.id, `收件 ${row.id}`, opener, (content) => showSource(content, row.id)));
    };
    filter.addEventListener('change', () => { filterValue = filter.value; showSources(); });
    body.append(settings, filter, sources);
    showSources();
  }

  function showSource(body, id) {
    const source = status.sources.find((row) => row.id === id);
    if (!source) { body.append(node('p', '找不到這筆收件。')); return; }
    body.append(node('p', `${source.domain} · ${labels[source.state]}`));
    const details = disclosure('進階', 'feature-advanced');
    details.append(node('p', source.ref), node('p', source.target ? '目標知識庫 ' + source.target : '獨立收件'));
    if (source.reason) details.append(node('p', source.reason));
    body.append(details);
    if (source.hasFile) {
      const download = node('a', '下載來源');
      download.href = '/api/jobs/source/' + source.id;
      body.append(download);
    }
    if (source.state === 'blocked') {
      const text = field(body, '補件文字', '', true);
      control(body, '送審', () => update({ action: 'supplement', id, text: text.value }));
    }
  }

  function delivery(body) {
    if (!status.delivery.length) body.append(node('p', '目前沒有通知紀錄。'));
    for (const row of status.delivery) body.append(node('p', `${botLabel(row.bot)} · ${labels[row.state] ?? row.state} · ${row.count} 筆`));
    if (status.unresolvedDelivery.length) {
      const unresolved = disclosure('需核對的通知', 'feature-more');
      for (const row of status.unresolvedDelivery) {
        const line = node('p', `${botLabel(row.bot)} · ${labels[row.state]} · 嘗試 ${row.attempts} 次 `);
        const details = disclosure('進階', 'feature-advanced');
        details.append(node('p', '通知代號 ' + row.id));
        unresolved.append(line, details);
        if (row.state === 'indeterminate') control(unresolved, '手動重送', () => {
          if (window.confirm('原通知可能已送達。重送可能產生重複訊息，仍要重送嗎？')) {
            void update({ action: 'resend', bot: row.bot, id: row.id });
          }
        }, 'resend-' + row.bot + '-' + row.id);
      }
      body.append(unresolved);
    }
    for (const row of status.failedIntakes) {
      body.append(node('p', `${botLabel(row.bot)} · 收件 ${row.id} 處理失敗 · 嘗試 ${row.attempts} 次 · ${localTime(row.firstSeen)}`));
    }
  }

  function render() {
    const { jobs, schedules = [], occurrences = [] } = status;
    const next = upcoming(schedules, occurrences, Date.now());
    const toolbar = node('div');
    toolbar.className = 'knowledge-pager';
    control(toolbar, '新增排程', (opener) => preview('editor', '新增排程', opener, (body) => scheduleEditor(body)));
    control(toolbar, '執行紀錄', (opener) => preview('history', '執行紀錄', opener, history));
    control(toolbar, '重新整理', () => update());
    const more = disclosure('更多', 'feature-more');
    more.querySelector('summary').dataset.featureFocus = 'jobs-more';
    control(more, 'Telegram 收件', (opener) => preview('inbox', 'Telegram 收件', opener, inbox));
    control(more, '通知紀錄', (opener) => preview('delivery', '通知紀錄', opener, delivery));
    toolbar.append(more);
    const list = node('ul');
    list.className = 'feature-list';
    for (const row of schedules.filter(({ state }) => state !== 'removed')) {
      const item = node('li');
      const state = labels[row.state];
      const when = next.has(row.id) ? '下次執行 ' + localTime(next.get(row.id), row.zone) : '目前沒有下次執行時間';
      control(item, row.id, (opener) => preview('schedule-' + row.id, row.id, opener, (body) => {
        const latest = (status.schedules ?? []).find(({ id }) => id === row.id);
        body.append(node('p', labels[latest?.state] ?? '已移除'));
        if (!latest || latest.state === 'removed') return;
        body.append(node('p', `每日 ${latest.time} · ${latest.zone}`));
        control(body, '執行紀錄', (trigger) => preview('history-' + row.id, '執行紀錄 · ' + row.id, trigger,
          (content) => history(content, row.id)), 'schedule-history-' + row.id);
      }), 'schedule-' + row.id);
      item.append(node('small', state + ' · ' + when));
      const actions = disclosure('更多', 'feature-more');
      actions.querySelector('summary').dataset.featureFocus = 'schedule-more-' + row.id;
      control(actions, '編輯', (opener) => preview('edit-' + row.id, '編輯排程 · ' + row.id, opener, (body) => {
        const latest = (status.schedules ?? []).find(({ id }) => id === row.id);
        if (latest?.state !== 'removed') scheduleEditor(body, latest);
      }), 'schedule-more-' + row.id);
      const changes = row.state === 'draft' ? [['active', '核准'], ['rejected', '拒絕']] :
        row.state === 'active' ? [['paused', '暫停']] : row.state === 'paused' ? [['active', '恢復']] : [];
      for (const [state, label] of [...changes, ['removed', '移除']]) {
        control(actions, label, () => update({ action: 'state', id: row.id, state }), 'schedule-more-' + row.id);
      }
      if (['active', 'paused'].includes(row.state)) {
        control(actions, '立即執行', () => update({ action: 'runNow', id: row.id }), 'schedule-more-' + row.id);
      }
      item.append(actions);
      list.append(item);
    }
    for (const [index, row] of jobs.entries()) {
      const item = node('li');
      const title = occurrences.find(({ job }) => job === row.id)?.schedule ?? `知識庫工作 ${jobs.length - index}`;
      control(item, title, (opener) => preview('job-' + row.id, title, opener, (body) => {
        const latest = status.jobs.find(({ id }) => id === row.id);
        if (!latest) { body.append(node('p', '找不到這項工作。')); return; }
        body.append(node('p', jobState(latest)));
        const details = disclosure('進階', 'feature-advanced');
        details.append(node('p', '工作代號 ' + latest.id));
        body.append(details);
      }), 'job-' + row.id);
      item.append(node('small', jobState(row)));
      if (!row.completed) {
        const actions = disclosure('更多', 'feature-more');
        actions.querySelector('summary').dataset.featureFocus = 'job-more-' + row.id;
        control(actions, '立即執行', () => update({ action: 'runJob', id: row.id }), 'job-more-' + row.id);
        item.append(actions);
      }
      list.append(item);
    }
    panel.replaceChildren(toolbar, list.childElementCount ? list : node('p', '目前沒有排程或工作。'));
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
  summary.textContent = '正在載入工作與排程…';
  try {
    const status = await request('/api/jobs');
    const counts = (rows, stateLabel) => {
      const totals = new Map();
      for (const row of rows) {
        const state = stateLabel(row);
        totals.set(state, (totals.get(state) ?? 0) + 1);
      }
      return [...totals].map(([state, count]) => `${state} ${count} 筆`).join('、') || '無';
    };
    summary.textContent = `BI 工作：${counts(status.jobs, jobState)}。排程：${counts(status.schedules ?? [], (row) => labels[row.state] ?? '其他狀態')}。`;
  } catch { summary.textContent = '目前無法讀取 BI 工作與排程。'; }
}
