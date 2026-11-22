import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, validateHeaderValue } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { jsonInput, send } from '../../../scripts/phase0/probe-http.ts';
import { testCustomMcp } from '../../launcher/src/custom-mcp-probe.ts';
import { atRepo } from '../../launcher/src/paths.ts';
import type { Runtime } from '../../launcher/src/runtime.ts';
import { goldFixture } from '../../../tests/fixtures/knowledge/gold.ts';
import { benchmarkQuestions } from '../../../packages/knowledge/src/benchmark.ts';
import { canonical, sha256 } from '../../../packages/knowledge/src/snapshot.ts';
import { parseAsk } from '../../../packages/knowledge/src/ask.ts';
import { repositoryErrorReport } from '../../../packages/knowledge/src/repository.ts';
import { isLocalAbsoluteFolder, RepositoryError } from '../../../packages/knowledge/src/repository-files.ts';
import { call } from './opencode/client.ts';
import { knowledgeMcpName, knowledgeToolName } from './opencode/knowledge-mcp.ts';
import { parseTurnLimits, turnLimitFields } from './opencode/turn-limits.ts';
import { maxSelectedModels } from './opencode/gateway.ts';
import { parseAvatar } from './http/avatar.ts';
import { LocalAuth, header } from './http/auth.ts';
import { ChatService, publicSession } from './http/chat.ts';
import type { Turn } from './http/chat.ts';
import { proposeReview, reviewAction, uploadReviewSource } from './http/review.ts';
import { HttpError, WebMessageError } from './http/errors.ts';
import { codeForFallback, describeRepositoryIssue, webMessage } from './http/messages.ts';
import { WebEvents } from './http/events.ts';
import { download, sendDownload, upload } from './http/files.ts';
import { convertWorkbook, uploadType, uuid } from './runs/attachments.ts';
import { projects, WebStore } from './runs/web-store.ts';
import { customMcpName, customMcpTool, pinCustomRemoteMcp, validateCustomRemoteMcp, validateCustomStdioMcp } from './runs/custom-mcp.ts';
import { configuredCustomMcpCredentials, saveCustomMcpCredential } from './runs/custom-mcp-credentials.ts';
import { foldersOverlap, validateProjectFolder } from './runs/project-folders.ts';
import { checkDirectory, openWorkspaceFile } from './runs/workspace.ts';
import { startTelegram } from './telegram/service.ts';
import { prepareBiWorkspace } from './runs/agent-ledger.ts';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/voice.js', ['src/voice.js', 'text/javascript; charset=utf-8']],
  ['/commands.js', ['src/commands.js', 'text/javascript; charset=utf-8']],
  ['/message-operations.js', ['src/message-operations.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/mcp-settings.js', ['src/mcp-settings.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['src/api.js', 'text/javascript; charset=utf-8']],
  ['/review.js', ['src/review.js', 'text/javascript; charset=utf-8']],
  ['/knowledge-quality.js', ['src/knowledge-quality.js', 'text/javascript; charset=utf-8']],
  ['/knowledge-browser.js', ['src/knowledge-browser.js', 'text/javascript; charset=utf-8']],
  ['/knowledge.js', ['src/knowledge.js', 'text/javascript; charset=utf-8']],
  ['/jobs.js', ['src/jobs.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['src/i18n.js', 'text/javascript; charset=utf-8']],
  ['/i18n/en.js', ['src/i18n/en.js', 'text/javascript; charset=utf-8']],
  ['/i18n/zh-TW.js', ['src/i18n/zh-TW.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['src/style.css', 'text/css; charset=utf-8']],
]);

const agents = ['inspector', 'workbook'] as const;

async function body(request: IncomingMessage) {
  if (header(request, 'content-type').split(';')[0].trim() !== 'application/json' ||
      header(request, 'content-encoding')) throw new HttpError(415, 'json-required');
  if (!/^\d{1,6}$/.test(header(request, 'content-length')) || Number(header(request, 'content-length')) > 128 * 1024) {
    throw new HttpError(413, 'json-too-large');
  }
  try {
    const value = await jsonInput<unknown>(request, 128 * 1024);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Respond with a fixed error and omit untrusted details. */ }
  throw new HttpError(400, 'invalid-json');
}

function parseTurn(input: Record<string, unknown>): Turn {
  const { id, text, attachments, workbook, replyTo } = input;
  if (Object.keys(input).some((key) => !['id', 'text', 'attachments', 'workbook', 'replyTo'].includes(key)) ||
      (replyTo !== undefined && (typeof replyTo !== 'string' || !replyTo || replyTo.length > 128)) || typeof id !== 'string' || !uuid.test(id) ||
      typeof text !== 'string' || !text.trim() || text.length > 16_000 ||
      !Array.isArray(attachments) || attachments.length > 10 || new Set(attachments).size !== attachments.length ||
      !attachments.every((item) => typeof item === 'string' && uuid.test(item)) || typeof workbook !== 'boolean') {
    throw new HttpError(400, 'invalid-message');
  }
  return { id, text, attachments, workbook, ...(replyTo === undefined ? {} : { replyTo }) };
}

function secureHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
    "img-src 'self' blob:", "frame-src 'self' about:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; '));
}

export async function startAdapter(root: string, runtime: Runtime, requestStop: () => void, telegramEnabled = false, requestRestart?: () => void) {
  checkDirectory(root);
  for (const project of projects) {
    const projectRoot = project.id === 'default' ? root : join(root, project.id);
    mkdirSync(projectRoot, { recursive: true });
    checkDirectory(projectRoot);
    for (const name of ['sessions', 'model-work', 'artifacts']) {
      const folder = join(projectRoot, name);
      mkdirSync(folder, { recursive: true });
      checkDirectory(folder);
    }
  }
  prepareBiWorkspace(root);
  const store = new WebStore(join(root, 'web.sqlite'));
  const sessions = new Map(store.sessions().map((session) => [session.id, session]));
  const upstreamIDs = new Map([...sessions.values()].map((session) => [session.upstreamID, session.id]));
  const events = new WebEvents(runtime.endpoint, (id) => upstreamIDs.get(id));
  const chat = new ChatService(store, runtime, root, join(runtime.root, 'web-turns.jsonl'), (id) => events.notify(id));
  const telegram = startTelegram(root, runtime, telegramEnabled, store);
  const active = new Set<Promise<void>>();
  const approvedAlias = (alias: unknown) => {
    if (typeof alias !== 'string' || !runtime.aliases.includes(alias)) throw new HttpError(400, 'unapproved-model');
    return alias;
  };
  const modelSelection = () => store.modelSelection(runtime.builtInAliases, runtime.alias);
  const sameModels = (ids: readonly string[]) => ids.length === runtime.aliases.length && ids.every((id) => runtime.aliases.includes(id));
  const modelSettings = () => {
    const selection = modelSelection();
    return { defaultAlias: runtime.alias, aliases: runtime.aliasHealth(), credentialsConfigured: true,
      selected: selection.ids, configuredDefaultAlias: selection.defaultAlias, choices: store.modelChoices(runtime.builtInAliases),
      discoveredAt: store.modelCatalog()?.discoveredAt ?? null, maxSelected: maxSelectedModels,
      restartRequired: !sameModels(selection.ids), canRestart: Boolean(requestRestart) };
  };
  let auth: LocalAuth;

  let restarting = false;
  let testingMcp = false;
  let refreshingModels = false;
  const changedCredentials = new Set<string>();
  let benchmarksInFlight = 0;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    secureHeaders(response);
    auth.check(request);
    if (restarting) throw new HttpError(503, 'runtime-restarting');
    let path = request.url ?? '';
    if (!path.startsWith('/') || path.startsWith('//') || /[?#\\%]/.test(path)) throw new HttpError(400, 'invalid-request-path');
    const method = request.method;
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'method-not-allowed');
    const asset = assets.get(path);
    if (asset && method === 'GET') {
      response.writeHead(200, { 'Content-Type': asset[1] }).end(readFileSync(atRepo('apps/web', asset[0])));
      return;
    }
    if (path === '/api/pair' && method === 'POST') {
      const { ticket } = await body(request);
      send(response, 200, auth.pair(request, response, ticket));
      return;
    }
    const { csrf } = auth.authorize(request);
    if (path === '/api/bootstrap' && method === 'GET') {
      send(response, 200, { csrf, agents, alias: runtime.alias, version: runtime.version,
        knowledge: Boolean(runtime.knowledge),
        projects, sessions: [...sessions.values()].filter((session) => session.project === projects[0].id).map(publicSession), job: { name: 'BI review demo', state: 'awaiting_review', demo: true } });
      return;
    }
    if (path === '/api/settings') {
      if (method === 'POST') {
        const input = await body(request);
        const { name, introduction, instructions } = input;
        if (Object.keys(input).length !== 3 || typeof name !== 'string' || name.length > 80 ||
            typeof introduction !== 'string' || introduction.length > 500 ||
            typeof instructions !== 'string' || instructions.length > 4000) {
          throw new HttpError(400, 'assistant-length');
        }
        if ([name, introduction, instructions].some((field) => runtime.redact(field) !== field)) {
          throw new HttpError(400, 'assistant-credentials');
        }
        store.savePreferences(name.trim(), introduction.trim(), instructions.trim());
      }
      const { name, introduction, instructions } = store.preferences() ?? { name: '', introduction: '', instructions: '' };
      send(response, 200, { name: runtime.redact(name), introduction: runtime.redact(introduction),
        instructions: runtime.redact(instructions) });
      return;
    }
    if (path === '/api/settings/appearance') {
      if (method === 'POST') {
        const input = await body(request);
        const { theme, density, avatar } = input;
        if ((theme !== 'system' && theme !== 'light' && theme !== 'dark') ||
            (density !== 'comfortable' && density !== 'compact') ||
            Object.keys(input).some((key) => !['theme', 'density', 'avatar'].includes(key))) {
          throw new HttpError(400, 'invalid-appearance');
        }
        store.saveAppearance(theme, density, parseAvatar(avatar));
      }
      const appearance = store.appearance();
      send(response, 200, { theme: appearance?.theme ?? null, density: appearance?.density ?? 'comfortable',
        hasAvatar: Boolean(appearance?.avatar) });
      return;
    }
    if (path === '/api/settings/avatar' && method === 'GET') {
      const appearance = store.appearance();
      if (!appearance?.avatar || !appearance.mime) throw new HttpError(404, 'default-avatar');
      response.writeHead(200, { 'Content-Type': appearance.mime }).end(appearance.avatar);
      return;
    }
    if (path === '/api/settings/model') {
      if (method === 'POST') {
        const input = await body(request);
        const selection = modelSelection();
        if (Object.keys(input).length === 1 && 'alias' in input) {
          const alias = approvedAlias(input.alias);
          if (!selection.ids.includes(alias)) throw new HttpError(400, 'unapproved-model');
          store.saveDefaultAlias(alias);
        } else {
          if (Object.keys(input).length !== 2 || !store.saveModelSelection(input.selected, input.alias, runtime.builtInAliases)) {
            throw new HttpError(400, 'invalid-model-selection', { max: maxSelectedModels });
          }
        }
        const saved = modelSelection();
        if (sameModels(saved.ids)) runtime.setDefaultAlias(saved.defaultAlias);
      }
      send(response, 200, modelSettings());
      return;
    }
    if (path === '/api/settings/model/recheck' && method === 'POST') {
      if (Object.keys(await body(request)).length) throw new HttpError(400, 'recheck-has-input');
      if (!await runtime.checkAliases()) throw new HttpError(429, 'recheck-too-soon', { seconds: 30 });
      send(response, 200, modelSettings());
      return;
    }
    if (path === '/api/settings/model/refresh' && method === 'POST') {
      if (Object.keys(await body(request)).length) throw new HttpError(400, 'recheck-has-input');
      if (refreshingModels) throw new HttpError(409, 'model-check-busy');
      refreshingModels = true;
      try {
        const refreshed = await runtime.refreshModels(store);
        send(response, 200, { ...modelSettings(), refreshed });
      } finally { refreshingModels = false; }
      return;
    }
    if (path === '/api/settings/model/test' && method === 'POST') {
      const { alias } = await body(request);
      if (typeof alias !== 'string' || !store.modelChoices(runtime.builtInAliases).includes(alias)) throw new HttpError(400, 'unapproved-model');
      const result = await runtime.checkModel(alias);
      if (!result) throw new HttpError(409, 'model-check-busy');
      send(response, 200, result);
      return;
    }
    if (path === '/api/settings/limits') {
      if (method === 'POST') {
        const limits = parseTurnLimits(await body(request));
        if (!limits) throw new HttpError(400, 'invalid-turn-limits');
        store.saveTurnLimits(limits);
      }
      send(response, 200, { values: store.turnLimits(), fields: turnLimitFields });
      return;
    }
    if (path === '/api/settings/projects') {
      if (method === 'POST') {
        const input = await body(request);
        const project = projects.find(({ id }) => id === input.project);
        if (!project) throw new HttpError(404, 'project-not-found');
        if (input.action === 'remove' && typeof input.folder === 'string') {
          if (!store.removeProjectFolder(project.id, input.folder)) throw new HttpError(404, 'folder-not-found');
        } else if (input.action === 'add') {
          const folder = validateProjectFolder(input.folder, root);
          if (store.projectFolders().some((entry) => foldersOverlap(folder, entry.folder))) {
            throw new HttpError(409, 'folder-overlap');
          }
          store.addProjectFolder(project.id, folder);
        } else throw new HttpError(400, 'invalid-folder-action');
      }
      const saved = store.projectFolders();
      send(response, 200, projects.map((project) => ({
        ...project, workingRoot: join(chat.projectRoot(project.id), 'model-work'),
        folders: saved.filter((entry) => entry.project === project.id).map((entry) => entry.folder),
      })));
      return;
    }
    if (path === '/api/settings/about' && method === 'GET') {
      const { version, license } = JSON.parse(readFileSync(atRepo('package.json'), 'utf8'));
      const { tag } = JSON.parse(readFileSync(atRepo('config/opencode.pin.json'), 'utf8'));
      send(response, 200, { version, license, pin: tag, root });
      return;
    }
    if (path === '/api/settings/mcp' && method === 'GET') {
      const enabled = Boolean(runtime.knowledge) && store.knowledgeSettings().toolbox;
      let status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'pending' | 'unconfigured' =
        runtime.knowledge ? 'disabled' : 'unconfigured';
      if (enabled) {
        try {
          const { data } = await runtime.client.mcp.list(undefined, call());
          status = data.find(({ name }) => name === knowledgeMcpName)?.status.status ?? 'pending';
        } catch {
          status = 'failed';
        }
      }
      send(response, 200, [{ id: knowledgeMcpName, managed: true, status, enabled,
        tools: runtime.knowledge ? [knowledgeToolName] : [] }]);
      return;
    }
    if (['/api/settings/mcp/restart', '/api/settings/model/restart'].includes(path) && method === 'POST') {
      const input = await body(request);
      if (Object.keys(input).length) throw new HttpError(400, 'restart-has-input');
      if (!requestRestart) throw new HttpError(503, 'restart-unavailable');
      if (restarting || active.size > 1 || chat.busy() || !telegram.pauseForRestart()) {
        throw new HttpError(409, 'restart-busy');
      }
      restarting = true;
      const restart = () => {
        response.off('finish', restart);
        response.off('close', restart);
        requestRestart();
      };
      response.once('finish', restart);
      response.once('close', restart);
      send(response, 202, { state: 'restarting' });
      return;
    }
    if (path === '/api/settings/mcp/test' && method === 'POST') {
      const { id } = await body(request);
      const server = store.customMcpServers().find((entry) => entry.id === id);
      if (!server) throw new HttpError(404, 'server-not-found');
      if (testingMcp) throw new HttpError(409, 'probe-busy');
      testingMcp = true;
      try {
        const results = await testCustomMcp(server);
        send(response, 200, results.ok ? results :
          { ...results, reasonDetail: webMessage(codeForFallback(results.reason) ?? 'mcp-probe-failed') });
      } catch {
        throw new HttpError(503, 'probe-unavailable');
      } finally { testingMcp = false; }
      return;
    }
    if (path === '/api/settings/mcp/custom') {
      let changedId: string | undefined;
      if (method === 'POST') {
        const input = await body(request);
        const existing = store.customMcpServers().find(({ id }) => id === input.id);
        if (input.action !== 'create' && !existing) throw new HttpError(404, 'server-not-found');
        if (input.action === 'remove' && existing) {
          store.removeCustomMcp(existing.id);
        } else if (input.action === 'credential' && existing) {
          const entry = existing.environment.find(({ name }) => name === input.name);
          if (!entry) throw new HttpError(404, 'credential-not-found');
          if (existing.transport === 'remote') {
            if (typeof input.value !== 'string') throw new HttpError(400, 'invalid-header-credential');
            try { validateHeaderValue(entry.name, input.value); }
            catch { throw new HttpError(400, 'invalid-header-credential'); }
          }
          try { saveCustomMcpCredential(entry.reference, input.value); }
          catch (error) {
            if (error instanceof WebMessageError) throw new HttpError(400, error.detail.code, error.detail.params);
            throw new HttpError(400, 'credential-save-failed');
          }
          changedCredentials.add(existing.id);
          send(response, 200, { configured: true });
          return;
        } else if (input.action === 'tool' && existing) {
          const { tool, enabled } = input;
          if (typeof tool !== 'string' || !customMcpTool.test(tool) || typeof enabled !== 'boolean') {
            throw new HttpError(400, 'invalid-tool-settings');
          }
          const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = existing;
          const denied = new Set(existing.deniedTools);
          if (enabled) denied.delete(tool);
          else denied.add(tool);
          if (denied.size > 50) throw new HttpError(400, 'denied-tool-limit', { count: 50 });
          store.saveCustomMcp({ ...definition, deniedTools: [...denied] });
        } else if (input.action === 'enable' && existing) {
          if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'invalid-server-enabled');
          if (input.enabled && existing.transport === 'remote') {
            try { await pinCustomRemoteMcp(existing, AbortSignal.timeout(5000)); }
            catch { throw new HttpError(400, 'mcp-network-address'); }
          }
          if (!store.customMcpServers().some(({ id, updatedAt }) => id === existing.id && updatedAt === existing.updatedAt)) {
            throw new HttpError(409, 'server-changed');
          }
          const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = existing;
          store.saveCustomMcp({ ...definition, enabled: input.enabled });
        } else if (input.action === 'create' || input.action === 'update') {
          const id = input.action === 'create' ? randomBytes(16).toString('hex') : existing!.id;
          try {
            const definitionInput = { ...input, deniedTools: input.action === 'update' ? existing?.deniedTools : [] };
            const projectIDs = projects.map((project) => project.id);
            const definition = input.transport === 'remote'
              ? validateCustomRemoteMcp(id, definitionInput, projectIDs)
              : validateCustomStdioMcp(id, definitionInput, projectIDs);
            if (definition.transport === 'remote') await pinCustomRemoteMcp(definition, AbortSignal.timeout(5000));
            if (existing && !store.customMcpServers().some((server) => server.id === existing.id && server.updatedAt === existing.updatedAt)) {
              throw new HttpError(400, 'server-changed');
            }
            store.saveCustomMcp(definition);
            changedId = id;
          } catch (error) {
            if (error instanceof WebMessageError) throw new HttpError(400, error.detail.code, error.detail.params);
            throw new HttpError(400, 'save-server-failed');
          }
        } else throw new HttpError(400, 'invalid-server-action');
      }
      const servers = store.customMcpServers();
      const configured = configuredCustomMcpCredentials(servers.flatMap(({ environment }) => environment.map(({ reference }) => reference)));
      const applied = runtime.customMcp ?? [];
      const statuses = await runtime.client.mcp.list(undefined, call()).then(({ data }) => data, () => []);
      const matches = (server: typeof servers[number]) => applied.some((entry) => {
        const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = server;
        return Object.entries(definition).every(([key, value]) =>
          JSON.stringify(value) === JSON.stringify(entry[key as keyof typeof entry]));
      });
      send(response, 200, {
        changedId,
        restartRequired: servers.some((server) => !matches(server)) ||
          applied.some(({ id }) => !servers.some((server) => server.id === id)) || changedCredentials.size > 0,
        servers: servers.map((server) => ({
          ...server, restartRequired: !matches(server) || changedCredentials.has(server.id),
          status: !server.enabled ? 'disabled' : server.environment.some(({ reference }) => !configured.has(reference))
            ? 'needs_auth' : statuses.find(({ name }) => name === customMcpName(server.id))?.status.status ?? 'pending',
          environment: server.environment.map(({ name, reference }) => ({ name, configured: configured.has(reference) })),
        })),
      });
      return;
    }
    if (path === '/api/settings/knowledge') {
      if (method === 'POST') {
        const { atlasUrl, toolbox } = await body(request);
        if (typeof atlasUrl !== 'string' || atlasUrl.length > 2048 || typeof toolbox !== 'boolean') {
          throw new HttpError(400, 'invalid-knowledge-settings');
        }
        const value = atlasUrl.trim();
        const url = value ? URL.parse(value) : null;
        if (value && (!url || !/^https:\/\//i.test(value) || url.username || url.password || /[\\\s]/.test(value))) {
          throw new HttpError(400, 'atlas-url');
        }
        store.saveKnowledgeSettings(url?.href ?? '', toolbox);
      }
      send(response, 200, store.knowledgeSettings());
      return;
    }
    if (path === '/api/settings/runtime' && method === 'GET') {
      const pin = JSON.parse(readFileSync(atRepo('config/opencode.pin.json'), 'utf8'));
      send(response, 200, { pin: pin.tag, version: runtime.version, compatible: runtime.version === pin.tag.slice(1),
        commit: pin.commit.slice(0, 12), openapi: pin.openapi.sha256.slice(0, 12),
        binary: pin.windowsX64.binarySha256.slice(0, 12),
        client: pin.client.integrity.slice(7, 19), health: 'ready',
        knowledgeConfigured: Boolean(runtime.knowledge), telegramConfigured: telegram.configured() });
      return;
    }
    if (path === '/api/jobs') {
      if (method === 'POST') {
        const input = await body(request);
        try { await telegram.action(input); }
        catch { throw new HttpError(422, 'job-update-failed'); }
      }
      const status = telegram.status();
      send(response, 200, { ...status, sources: status.sources.map(source => ({
        ...source,
        reasonDetail: typeof source.reason === 'string' && source.reason
          ? webMessage(codeForFallback(source.reason) ?? 'intake-blocked') : undefined,
      })) });
      return;
    }
    const source = path.match(/^\/api\/jobs\/source\/(\d+)$/);
    if (source && method === 'GET') {
      const bytes = telegram.source(Number(source[1]));
      if (!bytes) throw new HttpError(404, 'source-not-found');
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="telegram-source.bin"' }).end(bytes);
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/review-sources' && method === 'POST') {
      send(response, 200, await uploadReviewSource(runtime.knowledge.reviewStore, request));
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/reviews') {
      const reviewStore = runtime.knowledge.reviewStore;
      if (method === 'GET') {
        send(response, 200, { reviews: reviewStore.reviews(), ...reviewStore.reconciliation() });
      } else {
        const input = await body(request);
        try {
          if (input.action === 'propose') {
            const client = new AbortController();
            response.once('close', () => client.abort());
            const result = await proposeReview(reviewStore, input, runtime.knowledge.propose, client.signal);
            if (!response.destroyed) send(response, 200, result);
          } else send(response, 200, reviewAction(reviewStore, input));
        }
        catch { throw new HttpError(422, 'review-failed'); }
      }
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/benchmarks' && method === 'POST') {
      const { vault, name, questions } = await body(request);
      if (typeof vault !== 'string') throw new HttpError(400, 'select-knowledge-base');
      const knowledge = runtime.knowledge.reviewStore;
      if (name !== undefined) {
        const parsed = questions === null ? null : benchmarkQuestions(questions);
        if (typeof name !== 'string' || !name.trim() || name.length > 80 || name === '合成標準題集' || parsed === undefined) {
          throw new HttpError(400, 'invalid-question-set');
        }
        knowledge.saveBenchmark(vault, name, parsed);
      }
      const sets = knowledge.benchmarkSets(vault);
      if (!sets) throw new HttpError(404, 'knowledge-base-not-found');
      send(response, 200, { aliases: [...runtime.knowledge.benchmarks.keys()], sets: [
        { name: '合成標準題集', questions: goldFixture().questions, builtIn: true }, ...sets,
      ] });
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/benchmark-question' && method === 'POST') {
      const { vault, alias, name, id, revision } = await body(request);
      const benchmark = typeof alias === 'string' && runtime.knowledge.benchmarks.get(alias);
      const knowledge = runtime.knowledge.reviewStore;
      if (typeof vault !== 'string' || !benchmark) throw new HttpError(400, 'select-knowledge-base-and-model');
      const sets = knowledge.benchmarkSets(vault);
      const questions = name === '合成標準題集' && vault === 'oep-synthetic-demo' ? goldFixture().questions :
        sets?.find((set) => set.name === name)?.questions;
      const item = questions?.find((question) => question.id === id);
      const input = item && parseAsk({ vault, question: item.query });
      const active = knowledge.overview().find((entry) => entry.id === vault);
      if (!input || !active?.modelEnabled || active.revision !== revision) {
        throw new HttpError(409, 'quality-run-unavailable');
      }
      const client = new AbortController();
      response.once('close', () => client.abort());
      if (benchmarksInFlight >= 2) throw new HttpError(429, 'quality-busy');
      const start = performance.now();
      const available = item.class === 'answerable' ? knowledge.retrieve(vault, item.query)?.passages ?? [] : [];
      const recall = item.class === 'answerable' && item.evidence.length
        ? item.evidence.filter((id) => available.some((passage) => passage.id === id)).length / item.evidence.length : null;
      benchmarksInFlight++;
      const result = await benchmark.ask(input, AbortSignal.any([client.signal, AbortSignal.timeout(76_000)]))
        .finally(() => { benchmarksInFlight--; });
      if (response.destroyed) return;
      const hits = result.state === 'verified' ? result.citations.map(({ passageID }) => passageID) : [];
      const answerable = item.class === 'answerable';
      const unsupported = result.state === 'verified' && (!answerable || hits.some((id) => !item.evidence.includes(id)));
      const usable = result.state === 'verified' && answerable && !unsupported && Boolean(item.answer) &&
        result.answer.toLowerCase().includes(item.answer!.toLowerCase()) && item.evidence.every((id) => hits.includes(id));
      const snapshot = result.state === 'verified' && knowledge.snapshot(vault, result.revision);
      const reproducible = result.state === 'verified' && snapshot ? result.citations.filter((citation) => {
        const passage = snapshot.passages.find((row) => row.id === citation.passageID);
        const source = snapshot.sources.find((row) => row.id === citation.sourceId);
        return passage?.sourceId === source?.id && source?.ref === citation.source && source.version === citation.sourceVersion &&
          passage?.sha256 === citation.sha256 && passage.locator === citation.locator && passage.text === citation.context &&
          passage.text.includes(citation.quote);
      }).length : 0;
      const abstained = !answerable && result.state === 'abstain' && ['no-evidence', 'unsupported', 'invalid-citation'].includes(result.reason);
      send(response, 200, { result, usable, abstained, unsupported, reproducible, recall, citations: hits.length, elapsedMs: Math.round(performance.now() - start) });
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/demo' && method === 'POST') {
      const { load, allowModel } = await body(request);
      if (typeof load !== 'boolean') throw new HttpError(400, 'invalid-sample-action');
      const { snapshot } = goldFixture();
      snapshot.vault = { ...snapshot.vault, id: 'oep-synthetic-demo', title: '知識庫示範（合成資料）' };
      snapshot.schema.document.synthetic = true;
      snapshot.schema.sha256 = sha256(canonical(snapshot.schema.document));
      try { runtime.knowledge.reviewStore.setDemo(snapshot, load, allowModel === true); }
      catch { throw new HttpError(409, 'sample-conflict'); }
      send(response, 200, { loaded: load, vault: snapshot.vault.id });
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/browse' && method === 'POST') {
      const input = await body(request);
      const { vault } = input;
      if (typeof vault !== 'string' || vault.length > 192 ||
          Object.values(input).some((value) => typeof value === 'string' && value.length > 500)) {
        throw new HttpError(400, 'invalid-card-query');
      }
      const result = runtime.knowledge.reviewStore.browse(vault, input);
      if (!result) throw new HttpError(404, 'no-browsable-data');
      send(response, 200, result);
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/rebuild' && method === 'POST') {
      const { confirmed } = await body(request);
      if (confirmed !== true) throw new HttpError(400, 'confirm-index-rebuild');
      send(response, 200, { rebuilt: runtime.knowledge.reviewStore.rebuild() });
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/vaults' && method === 'GET') {
      send(response, 200, { vaults: runtime.knowledge.overview() });
      return;
    }
    if (runtime.knowledge && (path === '/api/knowledge/inspect' || path === '/api/knowledge/import') && method === 'POST') {
      const input = await body(request);
      const { folder, allowModel } = input;
      const importing = path === '/api/knowledge/import';
      if (Object.keys(input).some((key) => key !== 'folder' && (!importing || key !== 'allowModel')) ||
          typeof folder !== 'string' || folder.length > 2048 || !isLocalAbsoluteFolder(folder) ||
          (allowModel !== undefined && typeof allowModel !== 'boolean')) {
        throw new HttpError(400, 'invalid-repository-path');
      }
      try {
        if (importing) send(response, 200, runtime.knowledge.importRepository(folder, allowModel === true));
        else {
          const report = runtime.knowledge.inspectRepository(folder);
          send(response, 200, { ...report, errors: report.errors.map(issue => {
            const detail = describeRepositoryIssue(issue.message);
            return { ...issue, message: detail.text, detail };
          }) });
        }
      } catch (error) {
        const report = repositoryErrorReport(error, importing);
        const detail = error instanceof RepositoryError
          ? describeRepositoryIssue(report.message) : webMessage('repository-import-failed');
        send(response, 422, { error: [report.path, detail.text].filter(Boolean).join(' · '),
          errorDetail: detail, errorPath: report.path });
      }
      return;
    }
    if (runtime.knowledge && path === '/api/knowledge/ask' && method === 'POST') {
      const input = parseAsk(await body(request));
      if (!input) throw new HttpError(400, 'invalid-knowledge-question');
      const client = new AbortController();
      response.once('close', () => client.abort());
      const result = await runtime.knowledge.ask.ask(input, AbortSignal.any([client.signal, AbortSignal.timeout(76_000)]));
      if (!response.destroyed) send(response, 200, result);
      return;
    }
    if (path === '/api/stop' && method === 'POST') {
      response.once('finish', requestStop);
      send(response, 202, { state: 'stopping' });
      return;
    }
    let project = projects[0].id as typeof projects[number]['id'];
    if (path.startsWith('/api/projects/')) {
      const [, , , projectID, ...rest] = path.split('/');
      const match = projects.find(({ id }) => id === projectID);
      if (!match || rest[0] !== 'sessions') throw new HttpError(404, 'project-not-found');
      project = match.id;
      path = '/api/' + rest.join('/');
    }
    if (path === '/api/sessions' && method === 'GET') {
      send(response, 200, [...sessions.values()].filter((session) => session.project === project).map(publicSession));
      return;
    }
    if (path === '/api/sessions' && method === 'POST') {
      const { agent } = await body(request);
      if (agent !== 'inspector' && agent !== 'workbook') throw new HttpError(400, 'invalid-assistant');
      const session = await chat.create(agent, project);
      sessions.set(session.id, session);
      upstreamIDs.set(session.upstreamID, session.id);
      send(response, 201, publicSession(session));
      return;
    }
    const [, key, group, id, resource, item, extra] = path.split('/');
    const session = key === 'api' && group === 'sessions' && uuid.test(id ?? '') ? sessions.get(id) : undefined;
    if (!session || session.project !== project || (extra !== undefined && extra !== 'preview')) throw new HttpError(404, 'session-route-not-found');
    if (method === 'GET' && resource === 'artifacts' && item && uuid.test(item)) {
      if (extra === 'preview') {
        const output = chat.download(session, item);
        const projection = await convertWorkbook(output.data);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(projection);
      } else download(response, chat, session, item);
      return;
    }
    if (resource === 'attachments' && item && uuid.test(item)) {
      if (method === 'GET') {
        const output = chat.attachments.read(id, chat.workspace(session), item, extra === 'preview');
        if (extra === 'preview') {
          const mime = output.mime === 'image/png' || output.mime === 'image/jpeg' ? output.mime : 'text/plain; charset=utf-8';
          response.writeHead(200, { 'Content-Type': mime }).end(output.data);
        } else sendDownload(response, output);
        return;
      }
      if (extra === undefined) {
        await body(request);
        if (!sessions.has(id) || !store.attachment(id, item)) throw new HttpError(404, 'attachment-not-found');
        const latest = store.turns(id).at(-1);
        if (latest && !['verified', 'failed', 'cancelled'].includes(latest.state)) {
          throw new HttpError(409, 'attachment-remove-busy');
        }
        chat.attachments.remove(id, chat.workspace(session), item);
        events.notify(id);
        send(response, 200, { removed: true });
        return;
      }
    }
    if (item !== undefined || extra !== undefined) throw new HttpError(404, 'route-not-found');
    if (method === 'POST' && (resource === 'rename' || resource === 'remove')) {
      const input = await body(request);
      if (!sessions.has(id)) throw new HttpError(404, 'session-not-found');
      if (resource === 'rename') {
        const title = typeof input.title === 'string' ? input.title.trim() : '';
        if (!title || title.length > 80) throw new HttpError(400, 'invalid-session-name');
        store.renameSession(id, title);
        session.title = title;
      } else {
        if (input.decision === 'reject') {
          store.decideSessionRemoval(id, 'reject');
          send(response, 200, publicSession(session));
          return;
        }
        if (input.decision !== undefined && input.decision !== 'accept') throw new HttpError(400, 'invalid-delete-choice');
        const latest = store.turns(id).at(-1);
        if (latest && latest.state !== 'verified' && latest.state !== 'failed' && latest.state !== 'cancelled') {
          throw new HttpError(409, 'session-delete-busy');
        }
        if (chat.modelSwitchPending(id)) throw new HttpError(409, 'model-changing');
        store.decideSessionRemoval(id, 'accept');
        sessions.delete(id);
        events.forget(id);
        upstreamIDs.delete(session.upstreamID);
      }
      send(response, 200, publicSession(session));
      return;
    }
    if (method === 'POST' && resource === 'model') {
      const input = await body(request);
      if (Object.keys(input).length !== 1) throw new HttpError(400, 'select-model');
      const alias = approvedAlias(input.alias);
      if (!sessions.has(id)) throw new HttpError(404, 'session-not-found');
      send(response, 200, await chat.switchModel(session, alias));
      return;
    }
    if (method === 'POST' && resource === 'read-project-file') {
      const input = await body(request);
      const folder = store.projectFolders().find((entry) => entry.project === project && entry.folder === input.folder);
      if (!folder || typeof input.file !== 'string' || !sessions.has(id)) throw new HttpError(404, 'file-not-found');
      const safeRoot = validateProjectFolder(folder.folder, root);
      const name = basename(input.file);
      const mime = uploadType(name, 'application/octet-stream');
      let data: Buffer;
      try { data = openWorkspaceFile(safeRoot, input.file, 20 * 1024 * 1024).data; }
      catch { throw new HttpError(404, 'file-unreadable'); }
      const attachment = await chat.attachments.upload(id, chat.workspace(session), name, mime, data.length, async () => data);
      events.notify(id);
      send(response, 201, attachment);
      return;
    }
    if (method === 'POST' && resource === 'annotation') {
      const { messageID, field, value, reason = null } = await body(request);
      if (typeof messageID !== 'string' || (field !== 'note' && field !== 'rating') ||
          (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 500)) ||
          (field === 'rating' && value !== null && value !== 'up' && value !== 'down') ||
          (reason !== null && (typeof reason !== 'string' || reason.length > 200))) {
        throw new HttpError(400, 'invalid-annotation');
      }
      if (!(await chat.state(session)).messages?.some((message) => message.id === messageID) || !sessions.has(id)) {
        throw new HttpError(404, 'message-not-found');
      }
      store.annotate(id, messageID, field, value, value === null ? null : reason);
      events.notify(id);
      send(response, 200, { annotations: store.annotations(id) });
      return;
    }
    if (method === 'GET' && resource === 'action-decisions') send(response, 200, store.actionDecisions(id));
    else if (method === 'GET' && resource === 'state') send(response, 200, { ...await chat.state(session), activity: events.cards(id) });
    else if (method === 'GET' && resource === 'events') events.add(response, session.id);
    else if (method === 'POST' && resource === 'attachments') {
      const attachment = await upload(request, chat, session);
      events.notify(session.id);
      send(response, 201, attachment);
    } else if (method === 'POST' && resource === 'turns') {
      const input = parseTurn(await body(request));
      const reference = input.replyTo && ((store.turn(id, input.id) && store.reply(input.id)) ??
        (await chat.state(session)).messages?.find((message) => message.id === input.replyTo));
      if (input.replyTo && !reference) throw new HttpError(404, 'reply-not-found');
      if (!sessions.has(id)) throw new HttpError(404, 'session-not-found');
      send(response, 202, await chat.submit(session, input, reference ? { id: reference.id, text: reference.text.slice(0, 8000) } : undefined));
    }
    else if (method === 'POST' && resource === 'cancel-turn') {
      const input = await body(request);
      if (typeof input.id !== 'string' || !uuid.test(input.id)) throw new HttpError(400, 'invalid-turn-id');
      send(response, 200, await chat.cancel(session, input.id));
    }
    else throw new HttpError(404, 'route-not-found');
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (!request.complete) {
        response.setHeader('Connection', 'close');
        request.resume();
      }
      const detail = error instanceof HttpError ? error : new HttpError(503, 'unavailable');
      send(response, detail.status, { error: detail.message, errorDetail: detail.detail });
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        auth = new LocalAuth((server.address() as AddressInfo).port);
        resolve();
      });
    });
  } catch (error) {
    await telegram.close();
    await events.close();
    store.close();
    throw error;
  }
  return {
    pairURL: () => auth.pairURL(),
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const stopped = chat.close();
      await events.close();
      server.closeAllConnections();
      await closed;
      await Promise.all([stopped, telegram.close(), ...active]);
      store.close();
    },
  };
}
