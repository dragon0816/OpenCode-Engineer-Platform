const commands = [
  ['/new', '', '新增會話'],
  ['/stop', '', '停止處理'],
  ['/model', ' <模型>', '切換模型'],
  ['/theme', ' light|dark', '切換主題'],
  ['/attach', '', '選擇附件'],
  ['/ask', ' <知識庫> <問題>', '詢問知識庫'],
  ['/clear-search', '', '清除會話搜尋'],
  ['/help', '', '顯示指令說明'],
];

export function bindCommands(prompt, list, toast, handlers, report) {
  let active = 0;
  let options = [];
  let busy = false;

  function close() {
    list.hidden = true;
    prompt.setAttribute('aria-expanded', 'false');
    prompt.removeAttribute('aria-activedescendant');
  }

  function select(index) {
    active = index;
    for (const [position, option] of [...list.children].entries()) {
      option.setAttribute('aria-selected', String(position === active));
    }
    const selected = list.children[active];
    if (selected) {
      prompt.setAttribute('aria-activedescendant', selected.id);
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  function open() {
    if (!prompt.value.startsWith('/') || /\s/.test(prompt.value)) {
      close();
      return;
    }
    options = commands.filter(([name]) => name.startsWith(prompt.value));
    list.replaceChildren();
    for (const [index, entry] of options.entries()) {
      const option = document.createElement('li');
      option.id = 'slash-option-' + index;
      option.setAttribute('role', 'option');
      option.textContent = entry[0] + entry[1] + ' · ' + entry[2];
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => choose(entry));
      list.append(option);
    }
    if (!options.length) { close(); return; }
    list.hidden = false;
    prompt.setAttribute('aria-expanded', 'true');
    select(0);
  }

  function notify(text, undo) {
    toast.textContent = text;
    if (!undo) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '復原';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await undo();
        notify('已復原。');
      } catch (error) {
        report(error);
        button.disabled = false;
      }
    });
    toast.append(' ', button);
  }

  async function execute() {
    if (busy) return;
    const original = prompt.value;
    const [, name, argument = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(original.trim()) ?? [];
    const command = commands.find(([key]) => key === name);
    if (!command) { report('無法辨識這個指令。輸入 /help 查看可用指令。'); return; }
    if (!command[1] && argument) { report('這個指令不接受參數。'); return; }
    busy = true;
    close();
    report();
    prompt.value = '';
    try {
      if (name === '/help') notify(commands.map(([key, args, label]) => key + args + ' · ' + label).join('\n'));
      else {
        const result = await handlers[name](argument);
        if (result) notify(result.text, result.undo);
      }
    } catch (error) {
      if (!prompt.value) prompt.value = original;
      report(error);
    } finally { busy = false; }
  }

  function choose([name, args]) {
    prompt.value = name + (args ? ' ' : '');
    close();
    prompt.focus();
    if (!args) void execute();
  }

  prompt.addEventListener('input', open);
  prompt.addEventListener('blur', close);
  prompt.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229 || !prompt.value.startsWith('/')) return;
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      close();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && !list.hidden && options.length) {
      event.preventDefault();
      select((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!list.hidden && options[active]?.[0] !== prompt.value) choose(options[active]);
      else if (!list.hidden && options[active]?.[1]) choose(options[active]);
      else void execute();
    }
  });
  return execute;
}
