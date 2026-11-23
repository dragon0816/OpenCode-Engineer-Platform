import { errorText, request } from './api.js';
import { openBiBuilder } from './bi-builder.js';
import { bindCapabilityTabs } from './capabilities.js';
import { getLocale, message, setText } from './i18n.js';

const find = (id) => document.getElementById(id);
const localized = (text) => () => text[getLocale()];
const actionLabels = {
  install: message('plugins.install'),
  'update-file': message('plugins.update-file'),
  'reinstall-file': message('plugins.reinstall-file'),
  'trust-current': message('plugins.trust-current'),
  enable: message('plugins.enable'),
  disable: message('plugins.disable'),
  rollback: message('plugins.rollback'),
  uninstall: message('plugins.uninstall'),
};
const statusLabels = {
  enabled: message('plugins.status.enabled'),
  disabled: message('plugins.status.disabled'),
  'integrity-failed': message('plugins.status.integrity-failed'),
};
const operations = {
  'data.read': message('plugins.permission.data.read'),
  'data.write': message('plugins.permission.data.write'),
  'worker.run': message('plugins.permission.worker.run'),
  'review.submit': message('plugins.permission.review.submit'),
  'publish.request': message('plugins.permission.publish.request'),
  'progress.emit': message('plugins.permission.progress.emit'),
};
const scopes = { none: message('plugins.scope.none'), 'plugin-workspace': message('plugins.scope.plugin-workspace') };
const models = { none: message('plugins.model.none'), 'approved-gateway': message('plugins.model.approved-gateway') };
const sources = { none: message('plugins.source.none'), 'approved-sources': message('plugins.source.approved-sources') };

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
    ...permissions.operations.map((operation) => ['operation:' + operation, operations[operation]]),
    ['scope:' + permissions.dataScope, scopes[permissions.dataScope]],
    ['model:' + permissions.modelBroker, models[permissions.modelBroker]],
    ['source:' + permissions.sourceBroker, sources[permissions.sourceBroker]],
    ...permissions.workers.map((id) => ['worker:' + id, message('plugins.worker', { id })]),
  ];
}

function pageAPI(plugin, token, signal) {
  const path = `/api/plugins/${plugin.id}/runtime`;
  return {
    call: (method, params) => request(path, { data: { method, params }, pluginToken: token, signal }),
    source: (file) => request(path + '/sources', { bytes: file, pluginToken: token, pluginFile: file.name, signal }),
    panel: (id) => request(path + '/panels/' + id, { pluginToken: token }),
    async stream(id, signal, update) {
      const response = await fetch(path + '/events/' + id, { headers: { 'X-OEP-Plugin': token }, signal });
      if (!response.ok || !response.body) throw new Error('Plugin stream unavailable');
      let pending = '';
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (frame.startsWith('data: ')) update(JSON.parse(frame.slice(6)));
        }
      }
    },
  };
}

const jobLabels = {
  starting: message('plugins.job-starting'), running: message('plugins.job-running'),
  succeeded: message('plugins.job-succeeded'), failed: message('plugins.job-failed'),
  cancelled: message('plugins.job-cancelled'), 'timed-out': message('plugins.job-timed-out'),
};

export function bindPlugins(showView, openPanel, openBiReview, loadMcp) {
  const rail = find('open-capabilities');
  const capabilityView = find('capabilities-view');
  const pageView = find('plugin-page-view');
  const pageTitle = find('plugin-page-title');
  const pageContent = find('plugin-page-content');
  const pageActions = find('plugin-page-actions');
  const file = find('plugin-file');
  const installFile = find('install-plugin');
  const list = find('plugins-list');
  const status = find('plugins-status');
  const dialog = find('plugin-dialog');
  let installed = [];
  let activePage;
  let fileTarget;
  let busy = false;
  const biDraft = {};
  const tabs = bindCapabilityTabs(capabilityView, loadMcp);

  function chooseFile(id) {
    if (busy) return;
    fileTarget = id;
    file.value = '';
    file.click();
  }

  function hide() {
    activePage?.stop.abort();
    activePage = undefined;
    delete capabilityView.dataset.pluginDrop;
    capabilityView.hidden = true;
    pageView.hidden = true;
    rail.removeAttribute('aria-current');
    for (const entry of document.querySelectorAll('[data-plugin-page]')) entry.removeAttribute('aria-current');
  }

  async function openPage(plugin, page, opener) {
    if (!showView(pageView, pageTitle, opener)) return;
    const selection = activePage = { id: page.id, digest: plugin.digest, stop: new AbortController() };
    setText(pageTitle, localized(page.title));
    setText(pageContent, message('plugins.loading'));
    pageActions.replaceChildren();
    try {
      const view = await request(`/api/plugins/${plugin.id}/pages/${page.id}/${plugin.digest}`);
      if (activePage !== selection) return;
      pageContent.replaceChildren(...view.paragraphs.map((text) => element('p', localized(text))));
      const api = pageAPI(plugin, view.token, selection.stop.signal);
      if (view.biBuilder) {
        await openBiBuilder(pageActions, api, selection.stop.signal, (id) => openBiReview(id), biDraft, openPanel);
      } else if (view.actions?.length) {
        pageActions.replaceChildren(...view.actions.map((action) => jobAction(api, action, view.approvedSources, selection.stop.signal)));
      }
    } catch (error) {
      if (activePage !== selection) return;
      setText(pageContent, errorText(error));
      void refresh().catch(() => {});
    }
  }

  function jobAction(api, action, approvedSources, signal) {
    const form = element('div', undefined, 'plugin-actions');
    const source = element('input');
    source.type = 'file';
    const label = element('label');
    label.append(element('span', message('plugins.job-source')), source);
    const title = element('input');
    title.maxLength = 100;
    const titleLabel = element('label');
    titleLabel.append(element('span', message('plugins.draft-title')), title);
    const progress = element('progress');
    progress.max = 100;
    progress.value = 0;
    progress.hidden = true;
    const state = element('p');
    state.setAttribute('role', 'status');
    const openReview = button(message('plugins.open-review'), () => find('open-review').click());
    openReview.hidden = true;
    let job;
    const cancel = button(message('ui.cancel'), async () => {
      cancel.disabled = true;
      try { await api.call('jobs.cancel', { id: job }); }
      catch (error) { setText(state, errorText(error)); }
    });
    cancel.hidden = true;
    const start = button(localized(action.label), async () => {
      start.disabled = true;
      openReview.hidden = true;
      try {
        const files = [];
        if (source.files[0]) files.push((await api.source(source.files[0])).id);
        const input = {};
        if (action.reviewType) {
          input.draft = (await api.call('drafts.create', { reviewType: action.reviewType, title: title.value.trim() })).id;
        }
        signal.throwIfAborted();
        const created = await api.call('jobs.start', { worker: action.worker, sources: files, input });
        job = created.id;
        cancel.disabled = false;
        cancel.hidden = progress.hidden = false;
        await api.stream(job, signal, (update) => {
          progress.value = update.percent;
          setText(state, update.error === 'isolation-unavailable' ? message('plugins.isolation-unavailable') : jobLabels[update.state]);
          openReview.hidden = !update.review || find('open-review').hidden;
        });
      } catch (error) {
        if (!signal.aborted) setText(state, errorText(error));
      } finally { start.disabled = false; cancel.hidden = true; }
    });
    if (approvedSources) form.append(label);
    if (action.reviewType) form.append(titleLabel);
    form.append(start, cancel);
    if (action.panel) form.append(button(message('plugins.open-panel'), async (event) => {
      const opener = event.currentTarget;
      try {
        const view = await api.panel(action.panel);
        if (signal.aborted) return;
        const panel = openPanel(action.panel, localized(view.title), opener);
        panel.body.replaceChildren(...view.paragraphs.map((text) => element('p', localized(text))));
      } catch (error) { setText(state, errorText(error)); }
    }));
    form.append(progress, state, openReview);
    return form;
  }

  function render() {
    const fallback = find('bi-document-panel');
    fallback.hidden = installed.some(({ id }) => id === 'oep.bi-knowledge');
    for (const entry of document.querySelectorAll('[data-plugin-page]')) entry.remove();
    for (const plugin of installed.filter(({ status }) => status === 'enabled')) {
      for (const page of plugin.pages) {
        const entry = button(localized(page.title), () => void openPage(plugin, page, entry));
        entry.dataset.pluginPage = page.id;
        if (activePage?.id === page.id && activePage.digest === plugin.digest) entry.setAttribute('aria-current', 'page');
        find('open-settings').before(entry);
      }
    }
    list.replaceChildren(...installed.map((plugin) => {
      const row = element('li', undefined, 'plugin-row');
      const info = element('div');
      info.append(element('strong', localized(plugin.name)),
        element('span', message('plugins.list-info', { version: plugin.version, publisher: plugin.publisher })),
        element('span', statusLabels[plugin.status]));
      if (!plugin.compatible) info.append(element('span', message('plugins.compatibility', { range: plugin.oepCompatibility, version: plugin.oepVersion })));
      const actions = element('div', undefined, 'plugin-actions');
      if (plugin.status === 'integrity-failed') {
        actions.append(button(actionLabels['trust-current'], () => void change(plugin, 'trust-current')));
      } else {
        const action = plugin.status === 'enabled' ? 'disable' : 'enable';
        actions.append(button(actionLabels[action], () => confirmChange(plugin, action)));
      }
      actions.append(button(actionLabels[plugin.status === 'integrity-failed' ? 'reinstall-file' : 'update-file'], () => chooseFile(plugin.id)));
      if (plugin.previousVersion) actions.append(button(actionLabels.rollback, () => confirmChange(plugin, 'rollback')));
      actions.append(button(actionLabels.uninstall, () => confirmChange(plugin, 'uninstall')));
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
    dialog.addEventListener('close', () => (opener?.isConnected && opener.checkVisibility() ? opener : installFile).focus(), { once: true });
    dialog.showModal();
  }

  function apply(result) {
    installed = result.plugins;
    render();
    setText(status, result.cleanupPending ? message('plugins.cleanup-pending') : message('plugins.saved'));
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
    openDialog(message('plugins.review-install'), sections, actionLabels[action],
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
    openDialog(actionLabels[action], copy, actionLabels[action], required, () => change(plugin, action, incompatible));
  }

  function open(tab) {
    if (showView(capabilityView, find('capabilities-title'), rail)) {
      tabs.open(tab);
      void refresh().catch((error) => setText(status, errorText(error)));
    }
  }
  rail.addEventListener('click', () => open());
  installFile.addEventListener('click', () => chooseFile());
  async function previewFile(input, target) {
    if (!input || busy || dialog.open) return;
    busy = true;
    try {
      setText(status, message('plugins.loading'));
      const preview = await request('/api/plugins/preview', { bytes: input });
      status.replaceChildren();
      if (target && target !== preview.id) setText(status, message('plugins.wrong-file'));
      else if (!capabilityView.hidden) { tabs.plugins(); review(preview); }
    } catch (error) { setText(status, errorText(error)); }
    finally { busy = false; }
  }
  file.addEventListener('change', () => void previewFile(file.files[0], fileTarget));
  capabilityView.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    capabilityView.dataset.pluginDrop = '';
  });
  capabilityView.addEventListener('dragleave', (event) => {
    if (!capabilityView.contains(event.relatedTarget)) delete capabilityView.dataset.pluginDrop;
  });
  capabilityView.addEventListener('drop', (event) => {
    const files = event.dataTransfer.files;
    if (!files.length) return;
    event.preventDefault();
    delete capabilityView.dataset.pluginDrop;
    tabs.plugins();
    if (files.length === 1 && /\.oepplugin$/i.test(files[0].name)) void previewFile(files[0]);
    else setText(status, message('capabilities.plugin-file-required'));
  });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });

  return { hide, open, connect: () => {
    tabs.connect();
    void refresh().catch((error) => { if (!capabilityView.hidden) setText(status, errorText(error)); });
  } };
}
