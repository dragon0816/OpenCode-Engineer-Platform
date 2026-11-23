import { errorText, request } from './api.js';
import { getLocale, message, setText, t } from './i18n.js';

const find = (id) => document.getElementById(id);
const endpoint = '/api/capabilities/';

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) setText(node, content);
  if (className) node.className = className;
  return node;
}

function action(label, handler) {
  const button = element('button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function replaceList(list, rows, empty) {
  list.replaceChildren(...(rows.length ? rows : [element('li', empty)]));
}

function upload(button, input, send) {
  find(button).addEventListener('click', () => {
    find(input).value = '';
    find(input).click();
  });
  find(input).addEventListener('change', () => {
    const file = find(input).files[0];
    if (file) void send(file);
  });
}

export function bindCapabilityTabs(view, loadMcp) {
  const tabs = [...find('capability-tabs').querySelectorAll('[role="tab"]')];
  const assistant = find('skill-assistant');
  const skillList = find('skills-list');
  const workflowList = find('workflows-list');
  const knowledgeList = find('published-knowledge-list');
  const states = new Map();
  const sections = {
    skills: { status: 'skills-status', render: renderSkills },
    workflows: { status: 'workflows-status', render: renderWorkflows },
    knowledge: { status: 'published-knowledge-status', render: renderKnowledge },
  };
  const busy = new Set();
  const reads = new Map();
  let selected = 'plugins';
  let connected = false;

  function renderSkills({ skills, assistants, warningLimit }) {
    const current = assistant.value || 'main';
    assistant.replaceChildren(...assistants.map(({ id, name }) => {
      const option = element('option', name);
      option.value = id;
      return option;
    }));
    assistant.value = assistants.some(({ id }) => id === current) ? current : 'main';
    const enabled = skills.filter(({ enabledFor }) => enabledFor.includes(assistant.value));
    find('skills-warning').hidden = enabled.length <= warningLimit;
    replaceList(skillList, skills.map(({ name, description, source, bundled, enabledFor }) => {
      const id = assistant.value;
      const checked = enabledFor.includes(id);
      const row = element('li', undefined, 'plugin-row');
      const info = element('div');
      info.append(element('strong', name), element('span', description),
        element('span', bundled ? message('capabilities.skill-bundled', { source }) : message('capabilities.source', { source })));
      const controls = element('div', undefined, 'plugin-actions');
      const toggle = element('input');
      toggle.type = 'checkbox';
      toggle.checked = checked;
      const label = element('label');
      label.append(toggle, element('span', message('capabilities.skill-enable', { name })));
      toggle.addEventListener('change', () => {
        toggle.checked = checked;
        if (!checked && enabled.length >= warningLimit && !window.confirm(t('capabilities.skill-limit'))) return;
        void mutate('skills', 'enable', { data: { name, assistant: id, enabled: !checked } }, `skill-enable-${name}`);
      });
      toggle.id = `skill-enable-${name}`;
      controls.append(label, action(message('capabilities.uninstall'), () => {
        if (window.confirm(t('capabilities.skill-remove-confirm', { name }))) {
          void mutate('skills', 'remove', { data: { name } }, 'install-skill');
        }
      }));
      row.append(info, controls);
      return row;
    }), message('capabilities.skill-empty'));
  }

  function renderWorkflows(workflows) {
    replaceList(workflowList, workflows.map(({ id, description, parameters, steps }) => {
      const details = element('details');
      details.append(element('summary', id), element('p', description),
        element('h3', message('capabilities.workflow-parameters')), element('pre', JSON.stringify(parameters, null, 2)),
        element('h3', message('capabilities.workflow-steps')), element('pre', JSON.stringify(steps, null, 2)));
      const row = element('li');
      row.append(details);
      return row;
    }), message('capabilities.workflow-empty'));
  }

  function renderKnowledge(vaults) {
    replaceList(knowledgeList, vaults.map(({ id, title, revision, source, modelEnabled }) => {
      const row = element('li', undefined, 'plugin-row');
      const info = element('div');
      info.append(element('strong', title), element('span', message('capabilities.knowledge-version', { revision })),
        element('span', message('capabilities.source', { source })),
        element('span', modelEnabled ? message('capabilities.knowledge-bind') : message('capabilities.knowledge-local')));
      row.append(info, action(message('capabilities.remove'), () => {
        if (window.confirm(t('capabilities.knowledge-remove-confirm', { name: title }))) {
          void mutate('knowledge', 'remove', { data: { id, revision } }, 'import-published-knowledge');
        }
      }));
      return row;
    }), message('capabilities.knowledge-empty'));
  }

  async function refresh(section) {
    const config = sections[section];
    if (!config || busy.has(section)) return;
    const status = find(config.status);
    const read = Symbol();
    reads.set(section, read);
    try {
      const state = await request(endpoint + section);
      if (reads.get(section) !== read) return;
      states.set(section, state);
      config.render(state);
      status.replaceChildren();
    } catch (error) { if (reads.get(section) === read) setText(status, errorText(error)); }
    finally { if (reads.get(section) === read) reads.delete(section); }
  }

  async function mutate(section, operation, options, focus) {
    if (busy.has(section)) return;
    reads.delete(section);
    busy.add(section);
    const { status, render } = sections[section];
    const opener = document.activeElement;
    setText(find(status), message('capabilities.working'));
    try {
      const state = await request(`${endpoint}${section}/${operation}`, options);
      if (state !== null) {
        states.set(section, state);
        render(state);
        setText(find(status), message('capabilities.saved'));
      } else find(status).replaceChildren();
      if (focus && !opener?.isConnected && !view.hidden && selected === section) find(focus).focus();
    } catch (error) { setText(find(status), errorText(error)); }
    finally { busy.delete(section); }
  }

  function pick(section, operation, options = {}) {
    return mutate(section, operation, { data: { pick: true, locale: getLocale(), ...options } });
  }

  function select(tab, focus = false) {
    selected = tab.id.slice('capability-'.length);
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      find(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (connected && selected === 'mcp') void loadMcp();
    if (connected) void refresh(selected);
    if (focus) tab.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(tabs[(target + tabs.length) % tabs.length], true);
    });
  });
  assistant.addEventListener('change', () => { if (states.has('skills')) renderSkills(states.get('skills')); });
  upload('install-skill', 'skill-file', (file) => mutate('skills', 'zip', { bytes: file, pluginFile: file.name }));
  upload('import-workflow', 'workflow-file', (file) => mutate('workflows', 'import', { bytes: file, pluginFile: file.name }));
  upload('import-published-knowledge', 'published-knowledge-file', (file) => mutate('knowledge',
    find('published-knowledge-consent').checked ? 'package-model' : 'package', { bytes: file, pluginFile: file.name }));
  find('pick-skill-folder').addEventListener('click', () => void pick('skills', 'folder'));
  find('pick-published-knowledge-folder').addEventListener('click', () => void pick('knowledge', 'repository', {
    allowModel: find('published-knowledge-consent').checked,
  }));
  find('skill-folder-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void mutate('skills', 'folder', { data: { folder: find('skill-folder').value.trim() } });
  });
  find('published-knowledge-folder-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void mutate('knowledge', 'repository', { data: { folder: find('published-knowledge-folder').value.trim(),
      allowModel: find('published-knowledge-consent').checked } });
  });

  return {
    open: (section = 'plugins') => select(find('capability-' + section)),
    plugins: () => select(tabs[0]),
    connect() {
      connected = true;
      if (!view.hidden) select(find('capability-' + selected));
    },
  };
}
