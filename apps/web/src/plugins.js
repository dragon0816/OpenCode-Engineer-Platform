import { errorText, request } from './api.js';
import { getLocale, message, setText } from './i18n.js';

const find = (id) => document.getElementById(id);
const localized = (text) => () => text[getLocale()];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) setText(node, text);
  return node;
}

function button(text, action) {
  const node = element('button', text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function checkbox(text) {
  const box = element('input');
  box.type = 'checkbox';
  const label = element('label');
  label.append(box, element('span', text));
  return { box, label };
}

function permissionRows(permissions) {
  return [
    ...permissions.operations.map((operation) => ['operation:' + operation, message('plugins.permission.' + operation)]),
    ['scope:' + permissions.dataScope, message('plugins.scope.' + permissions.dataScope)],
    ['model:' + permissions.modelBroker, message('plugins.model.' + permissions.modelBroker)],
    ['source:' + permissions.sourceBroker, message('plugins.source.' + permissions.sourceBroker)],
    ...permissions.workers.map((id) => ['worker:' + id, message('plugins.worker', { id })]),
  ];
}

export function bindPlugins(showView) {
  const rail = find('open-capabilities');
  const capabilityView = find('capabilities-view');
  const pageView = find('plugin-page-view');
  const pageTitle = find('plugin-page-title');
  const pageContent = find('plugin-page-content');
  const file = find('plugin-file');
  const installFile = find('install-plugin');
  const list = find('plugins-list');
  const status = find('plugins-status');
  const dialog = find('plugin-dialog');
  let installed = [];
  let activePage;
  let fileTarget;
  let busy = false;

  function chooseFile(id) {
    if (busy) return;
    fileTarget = id;
    file.value = '';
    file.click();
  }

  function hide() {
    activePage = undefined;
    capabilityView.hidden = true;
    pageView.hidden = true;
    rail.removeAttribute('aria-current');
    for (const entry of document.querySelectorAll('[data-plugin-page]')) entry.removeAttribute('aria-current');
  }

  async function openPage(plugin, page, opener) {
    if (!showView(pageView, pageTitle, opener)) return;
    const selection = activePage = { id: page.id, digest: plugin.digest };
    setText(pageTitle, localized(page.title));
    setText(pageContent, message('plugins.loading'));
    try {
      const view = await request(`/api/plugins/${plugin.id}/pages/${page.id}/${plugin.digest}`);
      if (activePage !== selection) return;
      pageContent.replaceChildren(...view.paragraphs.map((text) => element('p', localized(text))));
    } catch (error) {
      if (activePage !== selection) return;
      setText(pageContent, errorText(error));
      void refresh().catch(() => {});
    }
  }

  function render() {
    for (const entry of document.querySelectorAll('[data-plugin-page]')) entry.remove();
    for (const plugin of installed.filter(({ status }) => status === 'enabled')) {
      for (const page of plugin.pages) {
        const entry = button(localized(page.title), () => void openPage(plugin, page, entry));
        entry.dataset.pluginPage = page.id;
        if (activePage?.id === page.id && activePage.digest === plugin.digest) entry.setAttribute('aria-current', 'page');
        rail.before(entry);
      }
    }
    list.replaceChildren(...installed.map((plugin) => {
      const row = element('li', undefined, 'plugin-row');
      const info = element('div');
      info.append(element('strong', localized(plugin.name)),
        element('span', message('plugins.list-info', { version: plugin.version, publisher: plugin.publisher })),
        element('span', message('plugins.status.' + plugin.status)));
      if (!plugin.compatible) info.append(element('span', message('plugins.compatibility', { range: plugin.oepCompatibility, version: plugin.oepVersion })));
      const actions = element('div', undefined, 'plugin-actions');
      if (plugin.status === 'integrity-failed') {
        actions.append(button(message('plugins.trust-current'), () => void change(plugin, 'trust-current')));
      } else {
        const action = plugin.status === 'enabled' ? 'disable' : 'enable';
        actions.append(button(message('plugins.' + action), () => confirmChange(plugin, action)));
      }
      actions.append(button(message('plugins.' + (plugin.status === 'integrity-failed' ? 'reinstall-file' : 'update-file')), () => chooseFile(plugin.id)));
      if (plugin.previousVersion) actions.append(button(message('plugins.rollback'), () => confirmChange(plugin, 'rollback')));
      actions.append(button(message('plugins.uninstall'), () => confirmChange(plugin, 'uninstall')));
      row.append(info, actions);
      return row;
    }));
    if (!installed.length) list.append(element('li', message('plugins.empty')));
  }

  async function refresh() {
    installed = await request('/api/plugins');
    render();
  }

  function openDialog(title, content, actionText, required, complete) {
    const opener = document.activeElement;
    const heading = element('h2', title);
    heading.id = 'plugin-dialog-title';
    const help = element('p');
    help.setAttribute('role', 'status');
    const controls = element('div', undefined, 'settings-actions');
    const cancel = button(message('ui.cancel'), () => dialog.close());
    cancel.autofocus = true;
    const confirm = button(actionText, async () => {
      confirm.disabled = cancel.disabled = true;
      for (const input of required) input.disabled = true;
      busy = true;
      try {
        await complete();
        dialog.close();
      } catch (error) { setText(help, errorText(error)); }
      finally {
        busy = false;
        for (const input of required) input.disabled = false;
        cancel.disabled = false;
        update();
      }
    });
    const update = () => { confirm.disabled = required.some((box) => !box.checked); };
    for (const input of required) input.addEventListener('change', update);
    update();
    controls.append(cancel, confirm);
    dialog.replaceChildren(heading, ...content, help, controls);
    dialog.addEventListener('close', () => (opener?.isConnected ? opener : installFile).focus(), { once: true });
    dialog.showModal();
  }

  function apply(result) {
    installed = result.plugins;
    render();
    setText(status, message(result.cleanupPending ? 'plugins.cleanup-pending' : 'plugins.saved'));
  }

  function review(preview) {
    const sections = [element('p', localized(preview.name)), element('p', message('plugins.package-info', {
      publisher: preview.publisher, version: preview.version, current: preview.currentVersion ?? '—',
    })), element('p', message('plugins.local-trust'))];
    const declared = element('ul');
    const previous = new Set(preview.previousPermissions ? permissionRows(preview.previousPermissions).map(([key]) => key) : []);
    for (const [key, label] of permissionRows(preview.permissions)) {
      declared.append(element('li', preview.previousPermissions && !previous.has(key) ? message('plugins.new-permission', { label }) : label));
    }
    sections.push(element('h3', message('plugins.permissions')), declared);
    const consent = checkbox(message('plugins.consent'));
    sections.push(consent.label);
    const override = checkbox(message('plugins.override'));
    if (!preview.compatible) sections.push(element('p', message('plugins.compatibility', {
      range: preview.oepCompatibility, version: preview.oepVersion,
    })), override.label);
    const action = preview.trustCurrent ? 'trust-current' : preview.currentVersion === preview.version ? 'reinstall-file' :
      preview.currentVersion ? 'update-file' : 'install';
    openDialog(message('plugins.review-install'), sections, message('plugins.' + action),
      preview.compatible ? [consent.box] : [consent.box, override.box], async () => {
        apply(await request('/api/plugins/install', { data: { token: preview.token, consent: consent.box.checked,
          allowIncompatible: override.box.checked } }));
      });
  }

  async function change(plugin, action, allowIncompatible = false) {
    const opener = document.activeElement;
    try {
      const result = await request(`/api/plugins/${plugin.id}/${action}`, { data: { allowIncompatible } });
      apply(result);
      if (result.preview) review(result.preview);
      else if (!dialog.open && !opener?.isConnected) installFile.focus();
    } catch (error) {
      if (dialog.open) throw error;
      setText(status, errorText(error));
      if (error.detail?.code === 'plugin-integrity-failed') void refresh().catch(() => {});
    }
  }

  function confirmChange(plugin, action) {
    const incompatible = action === 'enable' && !plugin.compatible || action === 'rollback' && !plugin.previousCompatible;
    if (action !== 'uninstall' && action !== 'rollback' && !incompatible) {
      void change(plugin, action);
      return;
    }
    const copy = [];
    const required = [];
    if (action === 'uninstall') copy.push(element('p', message('plugins.uninstall-help')));
    if (action === 'rollback') copy.push(element('p', message('plugins.rollback-help', { version: plugin.previousVersion })));
    if (incompatible) {
      const override = checkbox(message('plugins.override'));
      copy.push(element('p', message('plugins.selection-incompatible')), override.label);
      required.push(override.box);
    }
    openDialog(message('plugins.' + action), copy, message('plugins.' + action), required, () => change(plugin, action, incompatible));
  }

  rail.addEventListener('click', () => {
    if (showView(capabilityView, find('capabilities-title'), rail)) {
      void refresh().catch((error) => setText(status, errorText(error)));
    }
  });
  installFile.addEventListener('click', () => chooseFile());
  file.addEventListener('change', async () => {
    if (!file.files[0] || busy) return;
    busy = true;
    try {
      setText(status, message('plugins.loading'));
      const preview = await request('/api/plugins/preview', { bytes: file.files[0] });
      status.replaceChildren();
      if (fileTarget && fileTarget !== preview.id) setText(status, message('plugins.wrong-file'));
      else if (!capabilityView.hidden) review(preview);
    } catch (error) { setText(status, errorText(error)); }
    finally { busy = false; }
  });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });

  return { hide, connect: () => { rail.disabled = false; void refresh().catch(() => {}); } };
}
