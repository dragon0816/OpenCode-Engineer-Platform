import { LocalizedError, message, resolveText, setAttribute, setText, t } from './i18n.js';
import { request } from './api.js';

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  setText(element, label);
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
      if (!document.execCommand('copy')) throw new LocalizedError(message('messages.could-not-copy-the-text-select-it'));
    } finally {
      field.remove();
      focused?.focus();
    }
  }
}

export function messageActions(context, item, content, reply, report, notify, updated, openNotes) {
  const details = document.createElement('details');
  details.className = 'message-actions';
  const summary = document.createElement('summary');
  setText(summary, message('ui.more'));
  setAttribute(summary, 'aria-label', message('messages.more-message-actions'));
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
  add(message('messages.copy-text'), async () => { await copy(content.innerText); notify(message('messages.text-copied')); });
  add(message('messages.copy-markdown'), async () => {
    await copy(item.role === 'user' ? item.text.split('\n').map((line) => '> ' + line).join('\n') : item.text);
    notify(message('messages.markdown-copied'));
  });
  add(message('messages.reply-to-this-message'), () => reply(item));
  for (const [value, label] of [['up', message('messages.thumbs-up')], ['down', message('messages.thumbs-down')]]) {
    add(label, async () => {
      const reason = window.prompt(t('messages.enter-an-optional-reason-up-to-200'), resolveText(current()?.reason ?? ''));
      if (reason !== null) await save('rating', value, reason);
    });
  }
  add(message('messages.remove-rating'), () => save('rating', null));
  add(message('messages.add-or-edit-note'), async () => {
    const value = window.prompt(t('messages.enter-a-note-up-to-500-characters'), resolveText(current()?.note ?? ''));
    if (value !== null) await save('note', value);
  });
  add(message('messages.delete-note'), () => save('note', null));
  add(message('messages.view-session-notes'), () => openNotes(summary));
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
        setText(rating, entry.rating === 'up' ? message('messages.thumbs-up') : message('messages.thumbs-down'));
        if (entry.reason) {
          const reason = document.createElement('span');
          reason.dataset.uiContent = '';
          reason.textContent = entry.reason;
          rating.append(' · ', reason);
        }
        row.append(rating);
      }
      row.append(button(message('messages.go-to-message'), () => jump(entry.messageID)));
      list.append(row);
    }
    if (!list.children.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      setText(empty, message('messages.no-matching-notes-or-ratings'));
      list.append(empty);
    }
    selection = new Set([...selection].filter((id) => annotations.some((entry) => entry.messageID === id && entry.note)));
    download.disabled = !selection.size;
  }
  filter.addEventListener('change', () => render());
  download.addEventListener('click', () => {
    const entries = active.state.annotations.filter((entry) => entry.note && selection.has(entry.messageID));
    const data = [t('messages.session-notes'), ...entries.map((entry) => entry.note.split('\n').map((line) => '> ' + line).join('\n'))].join('\n\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([data + '\n'], { type: 'text/markdown;charset=utf-8' }));
    link.download = 'notes.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  return render;
}
