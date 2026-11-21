import { request } from './api.js';

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.className = 'clipboard-fallback';
    const focused = document.activeElement;
    document.body.append(field);
    field.select();
    try {
      if (!document.execCommand('copy')) throw new Error('無法複製文字。');
    } finally {
      field.remove();
      focused?.focus();
    }
  }
}

export function messageActions(context, item, content, reply, report, notify, updated) {
  const details = document.createElement('details');
  details.className = 'message-actions';
  const summary = document.createElement('summary');
  summary.textContent = '訊息操作';
  summary.setAttribute('aria-label', '開啟訊息操作');
  details.append(summary);
  const current = () => context.state.annotations?.find((entry) => entry.messageID === item.id);
  async function save(field, value, reason) {
    const { annotations } = await request(context.path + '/annotation', { data: { messageID: item.id, field, value, reason } });
    context.state.annotations = annotations;
    updated();
  }
  function add(label, action) {
    details.append(button(label, async () => {
      try {
        await action();
        details.open = false;
        if (details.contains(document.activeElement)) summary.focus();
      } catch (error) { report(error); }
    }));
  }
  add('複製文字', async () => { await copy(content.innerText); notify('已複製文字。'); });
  add('複製 Markdown', async () => {
    await copy(item.role === 'user' ? item.text.split('\n').map((line) => '> ' + line).join('\n') : item.text);
    notify('已複製 Markdown。');
  });
  add('回覆這則訊息', () => reply(item));
  for (const [value, label] of [['up', '讚'], ['down', '倒讚']]) {
    add(label, async () => {
      const reason = window.prompt('請輸入原因，可留空（最多 200 字）', current()?.reason ?? '');
      if (reason !== null) await save('rating', value, reason);
    });
  }
  add('刪除評價', () => save('rating', null));
  add('新增或編輯筆記', async () => {
    const value = window.prompt('請輸入筆記（最多 500 字）', current()?.note ?? '');
    if (value !== null) await save('note', value);
  });
  add('刪除筆記', () => save('note', null));
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && details.open) {
      event.preventDefault();
      details.open = false;
      summary.focus();
    }
  });
  return details;
}

export function bindNotes(filter, list, download, jump) {
  let active;
  let selection = new Set();
  function render(context = active) {
    if (context !== active) selection = new Set();
    active = context;
    const annotations = active?.state?.annotations ?? [];
    list.replaceChildren();
    for (const entry of annotations) {
      if (filter.value === 'rated' && !entry.rating || filter.value === 'noted' && !entry.note) continue;
      const row = document.createElement('li');
      if (entry.note) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selection.has(entry.messageID);
        check.addEventListener('change', () => {
          if (check.checked) selection.add(entry.messageID);
          else selection.delete(entry.messageID);
          download.disabled = !selection.size;
        });
        label.append(check, entry.note);
        row.append(label);
      }
      if (entry.rating) {
        const rating = document.createElement('p');
        rating.textContent = (entry.rating === 'up' ? '讚' : '倒讚') + (entry.reason ? ' · ' + entry.reason : '');
        row.append(rating);
      }
      row.append(button('前往訊息', () => jump(entry.messageID)));
      list.append(row);
    }
    if (!list.children.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '沒有符合的筆記或評價。';
      list.append(empty);
    }
    selection = new Set([...selection].filter((id) => annotations.some((entry) => entry.messageID === id && entry.note)));
    download.disabled = !selection.size;
  }
  filter.addEventListener('change', () => render());
  download.addEventListener('click', () => {
    const entries = active.state.annotations.filter((entry) => entry.note && selection.has(entry.messageID));
    const data = ['# 會話筆記', ...entries.map((entry) => entry.note.split('\n').map((line) => '> ' + line).join('\n'))].join('\n\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([data + '\n'], { type: 'text/markdown;charset=utf-8' }));
    link.download = 'notes.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  return render;
}
