import { joinText, message, setText } from './i18n.js';
const commands = [
  ['/new', '', message('commands.new-session')],
  ['/stop', '', message('ui.stop-processing')],
  ['/model', message('commands.model'), message('commands.switch-model')],
  ['/theme', ' light|dark', message('commands.switch-theme')],
  ['/attach', '', message('commands.choose-attachments')],
  ['/ask', message('commands.knowledge-base-question'), message('ui.ask-knowledge-base')],
  ['/clear-search', '', message('commands.clear-session-search')],
  ['/help', '', message('commands.show-command-help')],
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
      setText(option, commandHelp(entry));
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => choose(entry));
      list.append(option);
    }
    if (!options.length) { close(); return; }
    list.hidden = false;
    prompt.setAttribute('aria-expanded', 'true');
    select(0);
  }

  const commandHelp = ([name, args, label]) => joinText([joinText([name, args], ''), label]);

  function notify(text, undo) {
    setText(toast, text);
    if (!undo) return;
    const button = document.createElement('button');
    button.type = 'button';
    setText(button, message('commands.undo'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await undo();
        notify(message('commands.undone'));
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
    if (!command) { report(message('commands.unknown-command-enter-help-for-available-commands')); return; }
    if (!command[1] && argument) { report(message('commands.this-command-takes-no-arguments-remove-the')); return; }
    busy = true;
    close();
    report();
    prompt.value = '';
    try {
      if (name === '/help') notify(joinText(commands.map(commandHelp), '\n'));
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
