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

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
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

function section(title) {
  const element = document.createElement('section');
  element.append(node('h2', title));
  panel.append(element);
  return element;
}

async function update(data) {
  try { render(await request('/api/jobs', data ? { data } : undefined)); }
  catch (error) { panel.prepend(node('p', error.message)); }
}

function render(status) {
  panel.replaceChildren(button('重新整理', () => update()));
  const inbox = section('BI Telegram 收件');
  inbox.append(node('p', `Main ${status.main ? '已設定' : '未設定'}　BI ${status.bi ? '已設定' : '未設定'}`));
  const settings = document.createElement('div');
  const domain = field(settings, '領域', status.domain || 'telegram');
  const origins = field(settings, '核准 HTTPS 來源（每行一個）', status.origins.join('\n'), true);
  const target = field(settings, '目標 BI 知識庫 ID（選填）', status.target);
  settings.append(node('p', '留空時，每筆收件建立獨立知識庫草稿。設定目標後，UTF-8 來源會送至模型產生待審提案，須由人工批准與發布。'));
  settings.append(button('儲存收件設定', () => update({
    action: 'configure', domain: domain.value, origins: origins.value.split(/\s+/).filter(Boolean), target: target.value.trim(),
  })));
  inbox.append(settings);
  const filter = document.createElement('select');
  filter.setAttribute('aria-label', '收件狀態篩選');
  for (const [value, text] of [['', '全部'], ['ready', '待處理'], ['blocked', '需要補件'], ['awaiting_review', '待審核']]) {
    const option = node('option', text);
    option.value = value;
    filter.append(option);
  }
  const sources = document.createElement('div');
  const showSources = () => {
    const matches = status.sources.filter((source) => !filter.value || source.state === filter.value);
    sources.replaceChildren(node('p', `${matches.length} 筆`));
    for (const source of matches) {
      const item = document.createElement('details');
      item.append(node('summary', `#${source.id} · ${source.domain} · ${labels[source.state]}`), node('p', source.ref),
        node('p', source.target ? '目標知識庫 ' + source.target : '獨立收件'));
      if (source.reason) item.append(node('p', source.reason));
      if (source.hasFile) {
        const download = node('a', '下載來源');
        download.href = '/api/jobs/source/' + source.id;
        item.append(download);
      }
      if (source.state === 'blocked') {
        const text = field(item, 'UTF-8 補件', '', true);
        item.append(button('送審', () => update({ action: 'supplement', id: source.id, text: text.value })));
      }
      sources.append(item);
    }
  };
  filter.addEventListener('change', showSources);
  inbox.append(filter, sources);
  showSources();

  const jobs = section('工作狀態');
  for (const row of status.jobs) {
    const state = row.completed ? row.review_status === 'pending' ? '待審核' : labels[row.review_status] ?? '已送審' :
      row.expires > Date.now() ? '執行中' : '等待執行';
    const line = node('p', `${row.id} · ${state} `);
    if (!row.completed) line.append(button('立即執行', () => update({ action: 'runJob', id: row.id })));
    jobs.append(line);
  }
  if (!status.jobs.length) jobs.append(node('p', '目前沒有工作。'));
  for (const row of status.delivery) jobs.append(node('p', `${row.bot} 通知 · ${labels[row.state] ?? row.state} · ${row.count} 筆`));
  if (status.unresolvedDelivery.length) {
    const unresolved = document.createElement('details');
    unresolved.append(node('summary', '需核對的通知'));
    for (const row of status.unresolvedDelivery) {
      const line = node('p', `${row.bot} · ${row.id} · ${labels[row.state]} · 嘗試 ${row.attempts} 次 `);
      if (row.state === 'indeterminate') line.append(button('手動重送', () => {
        if (window.confirm('原通知可能已送達。重送可能產生重複訊息，仍要重送嗎？')) {
          void update({ action: 'resend', bot: row.bot, id: row.id });
        }
      }));
      unresolved.append(line);
    }
    jobs.append(unresolved);
  }
  for (const row of status.failedIntakes) {
    jobs.append(node('p', `${row.bot} 收件 #${row.id} · 處理失敗 · 嘗試 ${row.attempts} 次 · ${new Date(row.firstSeen).toLocaleString('zh-TW')}`));
  }

  const schedules = section('每日排程');
  const id = field(schedules, '排程 ID');
  const zone = field(schedules, 'IANA 時區', 'Asia/Taipei');
  const time = field(schedules, '當地時間', '09:00');
  time.type = 'time';
  const candidate = field(schedules, 'BI 工作參數（JSON）', '', true);
  schedules.append(button('儲存待批准排程', () => {
    try { void update({ action: 'schedule', id: id.value, zone: zone.value, time: time.value, candidate: JSON.parse(candidate.value) }); }
    catch { schedules.append(node('p', '工作參數須為有效的 JSON。')); }
  }));
  schedules.append(button('立即送出 BI 工作', () => {
    try { void update({ action: 'immediate', id: id.value, candidate: JSON.parse(candidate.value) }); }
    catch { schedules.append(node('p', '工作參數須為有效的 JSON。')); }
  }));
  for (const row of status.schedules ?? []) {
    if (row.state === 'removed') continue;
    const line = node('p', `${row.id} · ${row.time} ${row.zone} · ${labels[row.state]} `);
    line.append(button('編輯', () => {
      id.value = row.id;
      zone.value = row.zone;
      time.value = row.time;
      candidate.value = JSON.stringify(JSON.parse(row.payload), null, 2);
      id.focus();
    }));
    const actions = row.state === 'draft' ? [['active', '批准'], ['rejected', '拒絕']] :
      row.state === 'active' ? [['paused', '暫停']] : row.state === 'paused' ? [['active', '恢復']] : [];
    for (const [state, label] of [...actions, ['removed', '移除']]) {
      line.append(button(label, () => update({ action: 'state', id: row.id, state })));
    }
    if (['active', 'paused'].includes(row.state)) line.append(button('立即執行', () => update({ action: 'runNow', id: row.id })));
    schedules.append(line);
  }
  const history = section('執行紀錄');
  for (const row of status.occurrences ?? []) {
    history.append(node('p', `${row.schedule} · ${row.wall} ${row.zone} · ${new Date(row.utc).toISOString()} · ${labels[row.state]}`));
  }
}

open.addEventListener('click', () => {
  const show = view.hidden;
  find('knowledge-view').hidden = true;
  find('chat-view').hidden = find('chat-files').hidden = show;
  view.hidden = !show;
  if (show) {
    find('jobs-title').focus();
    void update();
  }
});

find('open-knowledge').addEventListener('click', () => { view.hidden = true; });
