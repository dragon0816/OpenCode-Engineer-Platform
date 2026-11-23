import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, validateHeaderValue } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { jsonInput, send } from '../../../scripts/phase0/probe-http.ts';
import { testCustomMcp } from '../../launcher/src/custom-mcp-probe.ts';
import { atRepo } from '../../launcher/src/paths.ts';
import { openBrowser } from '../../launcher/src/browser.ts';
import type { Runtime } from '../../launcher/src/runtime.ts';
import { goldFixture } from '../../../tests/fixtures/knowledge/gold.ts';
import { benchmarkQuestions } from '../../../packages/knowledge/src/benchmark.ts';
import { canonical, sha256 } from '../../../packages/knowledge/src/snapshot.ts';
import { parseAsk } from '../../../packages/knowledge/src/ask.ts';
import { repositoryErrorReport } from '../../../packages/knowledge/src/repository.ts';
import { isLocalAbsoluteFolder, RepositoryError } from '../../../packages/knowledge/src/repository-files.ts';
import { call } from './opencode/client.ts';
import { knowledgeMcpName, knowledgeToolName } from './opencode/knowledge-mcp.ts';
import { brokerMcpName } from './opencode/permissions.ts';
import { McpOAuth } from './opencode/mcp-oauth.ts';
import { probeOAuthMcp } from './opencode/remote-mcp-broker.ts';
import { parseTurnLimits, turnLimitFields } from './opencode/turn-limits.ts';
import { budgetFields, DelegationError, delegationPresets, isDelegationPreset, parseDelegationBudgets } from './runs/delegation-ledger.ts';
import { DelegationService } from './runs/delegation.ts';
import { ExternalDelegations, type ExternalWorkerOptions } from './runs/external-delegations.ts';
import { helperReady } from './runs/external-cli.ts';
import { ExternalSources } from './runs/external-sources.ts';
import { externalProvider, helpers, isProvider, type Provider } from './runs/external-ledger.ts';
import { externalError, externalWorkspaceInput, folderChoices, hashInput, helperAuth, helperSettings, identifiers, invalidExternal,
  labelInput, snapshotInput, sourceInput } from './http/external-helpers.ts';
import { maxSelectedModels } from './opencode/gateway.ts';
import { parseAvatar } from './http/avatar.ts';
import { LocalAuth, header } from './http/auth.ts';
import { ChatService, publicSession } from './http/chat.ts';
import type { Turn } from './http/chat.ts';
import { reviewAction, uploadReviewSource } from './http/review.ts';
import { HttpError, WebMessageError } from './http/errors.ts';
import { codeForFallback, describeRepositoryIssue, webMessage } from './http/messages.ts';
import { WebEvents } from './http/events.ts';
import { download, reportClientUpload, sendDownload, upload, uploadFailure } from './http/files.ts';
import { convertWorkbook, isAttachmentImage, uploadType, uuid } from './runs/attachments.ts';
import { projects, WebStore } from './runs/web-store.ts';
import { assistantMcpPaused, customMcpTool, oauthMcpTool, oauthSettings, pinCustomRemoteMcp, validateCustomRemoteMcp, validateCustomStdioMcp } from './runs/custom-mcp.ts';
import type { CustomMcp } from './runs/custom-mcp.ts';
import { configuredCustomMcpCredentials, saveCustomMcpCredential } from './runs/custom-mcp-credentials.ts';
import type { CredentialEnvironment } from './runs/custom-mcp-credentials.ts';
import { foldersOverlap, validateProjectFolder } from './runs/project-folders.ts';
import { publicReference } from './runs/local-references.ts';
import type { ReferencePicker } from './runs/reference-picker.ts';
import { canonicalWorkspaceDirectory, checkDirectory, openWorkspaceFile } from './runs/workspace.ts';
import { startTelegram } from './telegram/service.ts';
import type { TelegramEnvironment } from './telegram/accounts.ts';
import { Dispatcher } from './runs/dispatcher.ts';
import type { Candidate } from '../../../packages/knowledge/src/ingest.ts';
import { legacyWorkspace, prepareBiWorkspace } from './runs/agent-ledger.ts';
import { agentManagement } from './http/agents.ts';
import { DocumentExtraction } from './bi/document-extraction.ts';
import { receiveBiDocument } from './http/bi-documents.ts';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/voice.js', ['src/voice.js', 'text/javascript; charset=utf-8']],
  ['/commands.js', ['src/commands.js', 'text/javascript; charset=utf-8']],
  ['/message-operations.js', ['src/message-operations.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/local-paths.js', ['src/local-paths.js', 'text/javascript; charset=utf-8']],
  ['/agents.js', ['src/agents.js', 'text/javascript; charset=utf-8']],
  ['/channels.js', ['src/channels.js', 'text/javascript; charset=utf-8']],
  ['/telegram-setup.js', ['src/telegram-setup.js', 'text/javascript; charset=utf-8']],
  ['/delegations.js', ['src/delegations.js', 'text/javascript; charset=utf-8']],
  ['/external-helpers.js', ['src/external-helpers.js', 'text/javascript; charset=utf-8']],
  ['/mcp-settings.js', ['src/mcp-settings.js', 'text/javascript; charset=utf-8']],
  ['/api.js', ['src/api.js', 'text/javascript; charset=utf-8']],
  ['/review.js', ['src/review.js', 'text/javascript; charset=utf-8']],
  ['/knowledge-quality.js', ['src/knowledge-quality.js', 'text/javascript; charset=utf-8']],
  ['/knowledge-browser.js', ['src/knowledge-browser.js', 'text/javascript; charset=utf-8']],
  ['/knowledge.js', ['src/knowledge.js', 'text/javascript; charset=utf-8']],
  ['/bi-documents.js', ['src/bi-documents.js', 'text/javascript; charset=utf-8']],
  ['/jobs.js', ['src/jobs.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['src/i18n.js', 'text/javascript; charset=utf-8']],
  ['/i18n/en.js', ['src/i18n/en.js', 'text/javascript; charset=utf-8']],
  ['/i18n/zh-TW.js', ['src/i18n/zh-TW.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['src/style.css', 'text/css; charset=utf-8']],
]);

const agents = ['inspector', 'workbook'] as const;

async function body(request: IncomingMessage, limit = 128 * 1024) {
  if (header(request, 'content-type').split(';')[0].trim() !== 'application/json' ||
      header(request, 'content-encoding')) throw new HttpError(415, 'json-required');
  if (!/^\d{1,6}$/.test(header(request, 'content-length')) || Number(header(request, 'content-length')) > limit) {
    throw new HttpError(413, 'json-too-large');
  }
  try {
    const value = await jsonInput<unknown>(request, limit);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Respond with a fixed error and omit untrusted details. */ }
  throw new HttpError(400, 'invalid-json');
}

function parseTurn(input: Record<string, unknown>): Turn {
  const { id, text, attachments, workbook, replyTo, externalConfirmation } = input;
  if (Object.keys(input).some((key) => !['id', 'text', 'attachments', 'workbook', 'replyTo', 'externalConfirmation'].includes(key)) ||
      (externalConfirmation !== undefined && !hashInput(externalConfirmation)) ||
      (replyTo !== undefined && (typeof replyTo !== 'string' || !replyTo || replyTo.length > 128)) || typeof id !== 'string' || !uuid.test(id) ||
      typeof text !== 'string' || !text.trim() || text.length > 16_000 ||
      !Array.isArray(attachments) || attachments.length > 10 || new Set(attachments).size !== attachments.length ||
      !attachments.every((item) => typeof item === 'string' && uuid.test(item)) || typeof workbook !== 'boolean') {
    throw new HttpError(400, 'invalid-message');
  }
  return { id, text, attachments, workbook, ...(replyTo === undefined ? {} : { replyTo }),
    ...(typeof externalConfirmation === 'string' && { externalConfirmation }) };
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

export async function startAdapter(dataRoot: string, runtime: Runtime, requestStop: () => void, telegramEnabled = false,
  requestRestart?: () => void, channelEnvironment?: TelegramEnvironment, externalOptions?: ExternalWorkerOptions,
  mcpCredentials?: CredentialEnvironment, referencePicker?: ReferencePicker) {
  const root = canonicalWorkspaceDirectory(dataRoot);
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
  const mcpOAuth = runtime.mcpOAuth ?? new McpOAuth(root, openBrowser, mcpCredentials);
  const dispatcher = new Dispatcher(store.workItems);
  const sessions = new Map(store.sessions().map((session) => [session.id, session]));
  const upstreamIDs = new Map([...sessions.values()].filter((session) => store.sessionOwner(session)?.origin === 'web')
    .map((session) => [session.upstreamID, session.id]));
  const events = new WebEvents(runtime.endpoint, (id) => upstreamIDs.get(id));
  const delegations = (() => {
    try { return new DelegationService(store, root, dispatcher, (id) => events.notify(id, 'delegation')); }
    catch (error) { void events.close(); store.close(); throw error; }
  })();
  const telegram = (() => {
    try { return startTelegram(root, runtime, telegramEnabled, store, dispatcher, channelEnvironment, delegations); }
    catch (error) { void events.close(); store.close(); throw error; }
  })();
  const chat = new ChatService(store, runtime, root, join(runtime.root, 'web-turns.jsonl'), (id) => events.notify(id), store, dispatcher,
    delegations, referencePicker);
  const uploadAudit = join(runtime.root, 'web-uploads.jsonl');
  delegations.registerWorker(store, chat, telegram.delegationBi);
  const knowledgeStore = runtime.knowledge?.reviewStore;
  const extraction = runtime.knowledge && new DocumentExtraction(join(root, 'bi-documents.sqlite'), runtime.knowledge,
    () => new Set(telegram.approvedBiOrigins()), undefined,
    () => store.executionProfile('bi', 'bi')?.defaultModel ?? undefined);
  let receivingBiDocument = false;
  const externalSources = new ExternalSources(store, chat, root, knowledgeStore);
  const external = new ExternalDelegations(store, dispatcher, externalSources, (id) => events.notify(id, 'delegation'), externalOptions,
    (id, directory, digest) => delegations.exportExternalChanges(id, directory, digest), runtime.redact);
  delegations.registerExternal(external);
  const management = agentManagement(root, store, runtime, telegram, external);
  const sessionOwner = (session: Parameters<typeof publicSession>[0], agentID: string, workspaceID: string) => {
    const owner = store.sessionOwner(session);
    return owner?.origin === 'web' && owner.agentID === agentID && owner.workspaceID === workspaceID;
  };
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
  const oauthStatus = (server: CustomMcp) => {
    const status = mcpOAuth.status(server);
    if (!status) return;
    return { ...status, needsRestart: status.state === 'signed-in' && server.enabled && !assistantMcpPaused(server) &&
      server.appliesToProjects.length > 0 && runtime.remoteMcp?.status.get(server.id) !== 'connected' };
  };
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
    const agentPath = /^\/api\/agents(?:\/|$)/.test(path);
    const avatarRoute = /^\/api\/agents\/([a-z\d_-]{1,80})\/avatar$/.exec(path);
    const agentControl = /^\/api\/agents(?:\/[a-z\d_-]{1,80}(?:\/workspaces\/[a-z\d_-]{1,80}\/sessions)?)?$/.test(path);
    const telegramHistory = /^\/api\/agents\/([a-z\d_-]{1,80})\/telegram-history(?:\/([\da-f-]+))?$/.exec(path);
    const { csrf } = auth.authorize(request,
      path === '/api/settings/channels' || path === '/api/settings/delegation-budgets' || agentControl || Boolean(telegramHistory));
    if (telegramHistory) {
      const [, agentId, sessionId] = telegramHistory;
      if (method !== 'GET' || sessionId && !uuid.test(sessionId) || !store.agents().some(({ id, state }) => id === agentId && state === 'archived')) {
        throw new HttpError(404, 'session-not-found');
      }
      send(response, 200, await telegram.archivedHistory(agentId, sessionId));
      return;
    }
    if (path === '/api/bootstrap' && method === 'GET') {
      send(response, 200, { csrf, agents, alias: runtime.alias, version: runtime.version,
        knowledge: Boolean(runtime.knowledge),
        projects, sessions: [...sessions.values()].filter((session) => sessionOwner(session, 'main', legacyWorkspace('default')))
          .map(publicSession), job: { name: 'BI review demo', state: 'awaiting_review', demo: true } });
      return;
    }
    if (path === '/api/agents') {
      send(response, method === 'GET' ? 200 : 201, method === 'GET' ? management.list() : await management.create(await body(request, 160 * 1024), csrf));
      return;
    }
    const detailRoute = /^\/api\/agents\/([a-z\d_-]{1,80})$/.exec(path);
    if (detailRoute) {
      const id = detailRoute[1];
      send(response, 200, method === 'GET' ? management.detail(id) : management.update(id, await body(request, 160 * 1024)));
      return;
    }
    if (avatarRoute && method === 'GET') {
      const image = store.agentAvatar(avatarRoute[1]);
      if (!image) throw new HttpError(404, 'default-avatar');
      response.writeHead(200, { 'Content-Type': image.mime }).end(image.avatar);
      return;
    }
    if (path === '/api/settings/channels') {
      send(response, 200, method === 'GET' ? { accounts: telegram.channels() } : await telegram.configureChannel(await body(request), csrf));
      return;
    }
    if (path === '/api/settings/delegation-budgets') {
      if (method === 'POST') {
        const input = await body(request);
        const preset = Object.keys(input).length === 1 && isDelegationPreset(input.preset) ? input.preset : undefined;
        const budgets = preset ? delegationPresets[preset] : parseDelegationBudgets(input);
        if (!budgets) throw new HttpError(400, 'invalid-delegation-budgets');
        store.delegations.saveBudgets(budgets, preset);
      }
      const fields = Object.fromEntries(Object.entries(budgetFields).map(([key, { min, max }]) => [key, { min, max }]));
      const values = store.delegations.budgets();
      send(response, 200, { values, fields, preset: store.delegations.budgetChoice(values), presets: delegationPresets });
      return;
    }
    if (path === '/api/settings/external-helpers') {
      if (method === 'POST') {
        const { settings, warningAccepted } = helperSettings(await body(request));
        store.delegations.atomic(() => {
          if (settings.enabled && !store.external.settings(settings.provider).enabled) external.requiresInstalled(settings.provider);
          if (settings.enabled && !store.external.settings(settings.provider).enabled && !warningAccepted) {
            throw new HttpError(400, 'external-warning-required');
          }
          store.external.saveSettings(settings);
          if (settings.enabled) store.external.ensureTarget(settings.provider);
        });
      }
      send(response, 200, (Object.keys(helpers) as Provider[]).map((provider) => {
        const status = external.status(provider);
        const settings = store.external.settings(provider);
        return { ...settings, available: settings.enabled && helperReady(status), status,
          name: helpers[provider].name, targetId: helpers[provider].id,
          classification: store.external.workspace(helpers[provider].id) ?? 'unclassified' };
      }));
      return;
    }
    if (path === '/api/settings/external-helpers/policy') {
      if (method === 'POST') {
        const { strictMode, revision, ...extra } = await body(request);
        if (typeof strictMode !== 'boolean' || typeof revision !== 'number' || !Number.isSafeInteger(revision) ||
            revision < 0 || Object.keys(extra).length) throw invalidExternal();
        store.delegations.atomic(() => store.external.savePolicy(strictMode, revision));
      }
      send(response, 200, store.external.policy());
      return;
    }
    if (path === '/api/settings/external-helpers/recheck' && method === 'POST') {
      const { provider, ...extra } = await body(request);
      if (!isProvider(provider) || Object.keys(extra).length) throw invalidExternal();
      send(response, 200, await external.refresh(provider));
      return;
    }
    if (path === '/api/settings/external-helpers/auth' && method === 'POST') {
      const auth = helperAuth(await body(request));
      const client = new AbortController();
      response.once('close', () => client.abort());
      const status = await external.authenticate(auth.provider, auth.request, AbortSignal.any([client.signal, AbortSignal.timeout(180_000)]));
      if (!response.destroyed) send(response, 200, status);
      return;
    }
    if (path === '/api/classification/workspace' && method === 'POST') {
      const { workspaceId, classification } = externalWorkspaceInput(await body(request));
      store.delegations.atomic(() => store.external.classifyWorkspace(workspaceId, classification));
      send(response, 200, { classification });
      return;
    }
    if (path === '/api/classification/vault' && method === 'POST' && knowledgeStore) {
      const { vault, revision, classification, ...extra } = await body(request);
      if (!identifiers(vault) || !identifiers(revision) || !labelInput(classification) || Object.keys(extra).length) throw invalidExternal();
      const outcome = knowledgeStore.classifyVault(vault, revision, classification);
      if (outcome !== 'saved') throw new DelegationError('external-' + outcome);
      if (classification === 'public') store.external.approveVault(vault, revision, knowledgeStore.vaultClassification(vault)!.revision);
      send(response, 200, { classification });
      return;
    }
    const externalConfirm = /^\/api\/delegations\/([a-f\d-]{36})\/confirm$/.exec(path);
    if (externalConfirm && uuid.test(externalConfirm[1]) && method === 'POST') {
      send(response, 200, external.confirm(externalConfirm[1], await body(request)));
      return;
    }
    const delegation = /^\/api\/delegations\/([a-f\d-]{36})(?:\/(cancel|files\/([a-f\d-]{36})(\/preview)?))?$/.exec(path);
    if (delegation) {
      const [, id, action, fileId, preview] = delegation;
      if (method === 'GET' && fileId) {
        let file;
        try { file = delegations.exportFile(id, fileId); }
        catch { throw new HttpError(409, 'delegation-export-changed'); }
        if (!file) throw new HttpError(404, 'delegation-not-found');
        if (preview) response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'X-OEP-SHA256': file.sha256 }).end(file.data);
        else sendDownload(response, file, file.mime);
      } else if (method === 'POST' && action === 'cancel') {
        const detail = await delegations.cancel(id);
        if (!detail) throw new HttpError(404, 'delegation-not-found');
        send(response, 200, detail);
      } else if (method === 'GET' && !action) {
        const detail = store.delegations.inspect(id);
        if (!detail) throw new HttpError(404, 'delegation-not-found');
        const row = store.delegations.get(id)!;
        const externalApproval = external.ownerDetails(id);
        if (externalApproval) {
          send(response, 200, { ...detail, externalApproval });
          return;
        }
        const [child] = row.childSessionId ? store.sessions(false, row.childSessionId) : [];
        const owner = child && store.sessionOwner(child);
        const run = child && row.childRunId && owner?.origin === 'delegation' && owner.agentID === row.targetAgentId
          ? store.turn(child.id, row.childRunId)?.run : undefined;
        const state = run && row.targetAgentId !== 'bi' ? await chat.state(child, true) : undefined;
        const intake = run && row.targetAgentId === 'bi' ? telegram.delegationBi.delegationSource(id, run.id) : undefined;
        const task = run && row.targetAgentId === 'bi' ? store.workItems.get(row.workId)?.payload.task : undefined;
        send(response, 200, { ...detail, run: run && {
          timeline: store.timeline(run.id), model: run.alias, messages: state?.messages?.filter((item) => item.runId === run.id),
          messagesUnavailable: Boolean(state?.stateErrorDetail), intake,
          task: typeof task === 'string' ? runtime.redact(task) : undefined,
        } });
      } else throw new HttpError(405, 'method-not-allowed');
      return;
    }
    if (path === '/api/work-items') {
      if (method === 'POST') {
        const { id, leaseId, outcome } = await body(request);
        if (typeof id !== 'string' || typeof leaseId !== 'string' ||
            (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled')) {
          throw new HttpError(400, 'work-resolution-invalid');
        }
        if (!await dispatcher.resolve(id, leaseId, outcome)) throw new HttpError(409, 'work-resolution-unavailable');
      }
      send(response, 200, { indeterminate: store.workItems.withLease().filter(({ state }) => state === 'indeterminate')
        .map(({ id, agentId, source, enqueuedAt, leaseId, runStore, runId, scheduleRef, reasonCode }) =>
          ({ id, agentId, source, enqueuedAt, leaseId, runStore, runId, scheduleRef, reasonCode })) });
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
        classification: store.external.workspace(legacyWorkspace(project.id)),
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
          const { data } = await runtime.client.mcp.list({ location: { directory: root } }, call());
          status = data.find(({ name }) => name === brokerMcpName)?.status.status ?? 'pending';
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
      if (restarting || active.size > 1 || chat.busy() || dispatcher.busy() || extraction?.busy() || !telegram.pauseForRestart()) {
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
    if (path === '/api/settings/mcp/oauth' && method === 'GET') {
      send(response, 200, Object.fromEntries(store.customMcpServers().flatMap((server) => {
        const status = oauthStatus(server);
        return status ? [[server.id, status]] : [];
      })));
      return;
    }
    if (path === '/api/settings/mcp/test' && method === 'POST') {
      const { id } = await body(request);
      const server = store.customMcpServers().find((entry) => entry.id === id);
      if (!server) throw new HttpError(404, 'server-not-found');
      if (testingMcp) throw new HttpError(409, 'probe-busy');
      testingMcp = true;
      try {
        if (server.transport === 'remote' && server.oauth) {
          const tools = await probeOAuthMcp(server, mcpOAuth, runtime.redact);
          send(response, 200, { ok: true, tools });
          return;
        }
        const results = await testCustomMcp(server, mcpCredentials?.readCredentials);
        send(response, 200, results.ok ? results :
          { ...results, reasonDetail: webMessage(codeForFallback(results.reason) ?? 'mcp-probe-failed') });
      } catch (error) {
        if (server.transport === 'remote' && server.oauth) {
          const reasonDetail = error instanceof WebMessageError ? error.detail : webMessage('mcp-probe-failed');
          send(response, 200, { ok: false, reason: reasonDetail.text, reasonDetail });
          return;
        }
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
          mcpOAuth.remove(existing);
          store.removeCustomMcp(existing.id);
        } else if ((input.action === 'oauth-login' || input.action === 'oauth-logout') && existing) {
          if (existing.transport !== 'remote' || !existing.oauth) throw new HttpError(400, 'mcp-oauth-settings');
          try {
            if (input.action === 'oauth-login') await mcpOAuth.start(existing);
            else await mcpOAuth.signOut(existing);
          } catch (error) {
            if (error instanceof WebMessageError) throw new HttpError(400, error.detail.code, error.detail.params);
            throw new HttpError(503, 'mcp-oauth-login');
          }
        } else if (input.action === 'credential' && existing) {
          const entry = existing.environment.find(({ name }) => name === input.name);
          if (!entry) throw new HttpError(404, 'credential-not-found');
          if (existing.transport === 'remote') {
            if (typeof input.value !== 'string') throw new HttpError(400, 'invalid-header-credential');
            try { validateHeaderValue(entry.name, input.value); }
            catch { throw new HttpError(400, 'invalid-header-credential'); }
          }
          try { saveCustomMcpCredential(entry.reference, input.value, mcpCredentials?.writeCredential); }
          catch (error) {
            if (error instanceof WebMessageError) throw new HttpError(400, error.detail.code, error.detail.params);
            throw new HttpError(400, 'credential-save-failed');
          }
          changedCredentials.add(existing.id);
          send(response, 200, { configured: true });
          return;
        } else if (input.action === 'tool' && existing) {
          const { tool, enabled } = input;
          if (typeof tool !== 'string' || !(oauthSettings(existing) ? oauthMcpTool : customMcpTool).test(tool) || typeof enabled !== 'boolean') {
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
            const deniedTools = input.action === 'update' ? existing?.deniedTools ?? [] : [];
            const definitionInput = { ...input, deniedTools: input.oauth ? deniedTools : deniedTools.filter((tool) => customMcpTool.test(tool)) };
            const projectIDs = projects.map((project) => project.id);
            const definition = input.transport === 'remote'
              ? validateCustomRemoteMcp(id, definitionInput, projectIDs)
              : validateCustomStdioMcp(id, definitionInput, projectIDs);
            if (definition.transport === 'remote') await pinCustomRemoteMcp(definition, AbortSignal.timeout(5000));
            if (existing && !store.customMcpServers().some((server) => server.id === existing.id && server.updatedAt === existing.updatedAt)) {
              throw new HttpError(400, 'server-changed');
            }
            mcpOAuth.configure(existing, definition, input.oauthClientId, input.oauthClientSecret);
            store.saveCustomMcp(definition);
            changedId = id;
          } catch (error) {
            if (error instanceof WebMessageError) throw new HttpError(400, error.detail.code, error.detail.params);
            throw new HttpError(400, 'save-server-failed');
          }
        } else throw new HttpError(400, 'invalid-server-action');
      }
      const servers = store.customMcpServers();
      const credentialNames = servers.flatMap(({ environment }) => environment.map(({ reference }) => reference));
      const configured = configuredCustomMcpCredentials(credentialNames, mcpCredentials?.readCredentials);
      const applied = runtime.customMcp ?? [];
      const matches = (server: typeof servers[number]) => applied.some((entry) => {
        const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = server;
        return Object.entries(definition).every(([key, value]) =>
          JSON.stringify(value) === JSON.stringify(entry[key as keyof typeof entry]));
      });
      const oauthStatuses = new Map(servers.map((server) => [server.id, oauthStatus(server)]));
      const definitionChanged = (server: typeof servers[number]) => !matches(server) || changedCredentials.has(server.id);
      const baseRestartRequired = servers.some(definitionChanged) ||
        applied.some(({ id }) => !servers.some((server) => server.id === id)) || changedCredentials.size > 0;
      send(response, 200, {
        changedId,
        baseRestartRequired,
        restartRequired: baseRestartRequired || [...oauthStatuses.values()].some((status) => status?.needsRestart),
        servers: servers.map((server) => ({
          ...server, restartRequired: definitionChanged(server) || Boolean(oauthStatuses.get(server.id)?.needsRestart),
          baseRestartRequired: definitionChanged(server),
          oauthStatus: oauthStatuses.get(server.id),
          status: assistantMcpPaused(server) ? 'paused' : !server.enabled ? 'disabled' :
            matches(server) ? runtime.remoteMcp?.status.get(server.id) ?? 'pending' : 'pending',
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
    const source = path.match(/^\/api\/jobs\/source\/(-?\d+)$/);
    if (source && method === 'GET') {
      const bytes = telegram.source(Number(source[1]));
      if (!bytes) throw new HttpError(404, 'source-not-found');
      response.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="telegram-source.bin"' }).end(bytes);
      return;
    }
    const documents = '/api/knowledge/bi-documents';
    if (extraction && path.startsWith(documents + '/')) {
      const route = path.slice(documents.length);
      const file = /^\/file\/([a-f0-9]{64})\/([01])$/.exec(route);
      const run = /^\/runs\/([a-f0-9-]{36})$/.exec(route);
      if (method === 'GET' && route === '/schemas') {
        send(response, 200, { choices: extraction.choices() });
      } else if (method === 'GET' && route === '/runs') {
        send(response, 200, { runs: extraction.recent() });
      } else if (method === 'GET' && run && uuid.test(run[1])) {
        const status = extraction.status(run[1]);
        if (!status) throw new HttpError(404, 'bi-document-not-found');
        send(response, 200, status);
      } else if (method === 'POST' && route === '/schemas') {
        const { folder } = await body(request);
        try { send(response, 200, await extraction.importSchemas(folder)); }
        catch { throw new HttpError(422, 'bi-document-import'); }
      } else if (method === 'POST' && (route === '/link' || file)) {
        if (receivingBiDocument || extraction.busy()) throw new HttpError(409, 'bi-document-busy');
        receivingBiDocument = true;
        try {
          let status;
          if (file) {
            status = extraction.start(await receiveBiDocument(request), file[1], file[2] === '1');
          } else {
            const { url, schema, allowModel } = await body(request);
            if (typeof url !== 'string' || typeof allowModel !== 'boolean') throw new HttpError(422, 'bi-document-input');
            status = extraction.start({ url }, schema, allowModel);
          }
          send(response, 202, status);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(422, 'bi-document-input');
        } finally { receivingBiDocument = false; }
      } else throw new HttpError(404, 'route-not-found');
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
          if (input.action === 'propose' || input.action === 'stage-change' && (input.draft as Candidate)?.vault?.kind === 'bi') {
            const client = new AbortController();
            response.once('close', () => client.abort());
            const result = await telegram.reviewBi(input, client.signal);
            if (!response.destroyed) send(response, 200, result);
          } else if (input.action === 'run' || input.action === 'stage' && (input.draft as Candidate)?.vault?.kind === 'bi') {
            const id = typeof input.id === 'string' ? input.id : '';
            await telegram.runBi(id, input.action === 'stage' ? input.draft as Candidate : undefined);
            send(response, 200, { id });
          } else {
            const result = reviewAction(reviewStore, input);
            if (input.action === 'publish' && typeof input.id === 'string') {
              const parent = store.delegations.publicationParent(input.id);
              if (parent?.parentStore === 'web') events.notify(parent.parentSessionId, 'delegation');
            }
            send(response, 200, result);
          }
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
      send(response, 200, { vaults: runtime.knowledge.overview().map((vault) => {
        const label = knowledgeStore?.vaultClassification(vault.id);
        const classification = label?.label === 'public' && !store.external.vaultApproved(vault.id, vault.revision, label.revision)
          ? 'unclassified' : label?.label;
        return { ...vault, classification };
      }) });
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
    let agentID = 'main';
    let workspaceID: string;
    let agentScoped = false;
    if (agentPath) {
      const scope = /^\/api\/agents\/([a-z\d_-]{1,80})\/workspaces\/([a-z\d_-]{1,80})\/(sessions(?:\/.*)?)$/.exec(path);
      if (!scope) throw new HttpError(404, 'agent-not-found');
      [, agentID, workspaceID] = scope;
      if (externalProvider(agentID)) throw new HttpError(404, 'agent-not-found');
      const workspace = store.agentWorkspaces(agentID).find(({ id }) => id === workspaceID);
      if (!workspace) throw new HttpError(404, 'agent-workspace-not-found');
      if (workspace.layout === 'legacy_secondary') project = 'secondary';
      path = '/api/' + scope[3];
      agentScoped = true;
    } else if (path.startsWith('/api/projects/')) {
      const [, , , projectID, ...rest] = path.split('/');
      const match = projects.find(({ id }) => id === projectID);
      if (!match || rest[0] !== 'sessions') throw new HttpError(404, 'project-not-found');
      project = match.id;
      path = '/api/' + rest.join('/');
    }
    workspaceID ??= legacyWorkspace(project);
    if (path === '/api/sessions' && method === 'GET') {
      send(response, 200, [...sessions.values()].filter((session) => sessionOwner(session, agentID, workspaceID)).map(publicSession));
      return;
    }
    if (path === '/api/sessions' && method === 'POST') {
      const input = await body(request);
      const agent = input.agent ?? (agentScoped ? 'inspector' : undefined);
      if (agent !== 'inspector' && agent !== 'workbook') throw new HttpError(400, 'invalid-assistant');
      if (!store.executionProfile(agentID, workspaceID)) throw new HttpError(409, 'agent-inactive');
      const session = await chat.create(agent, project, undefined, undefined, agentScoped ? { agentId: agentID, workspaceID } : undefined);
      sessions.set(session.id, session);
      upstreamIDs.set(session.upstreamID, session.id);
      send(response, 201, publicSession(session));
      return;
    }
    const [, key, group, id, resource, item, extra, trailing] = path.split('/');
    const session = key === 'api' && group === 'sessions' && uuid.test(id ?? '') ? sessions.get(id) : undefined;
    if (!session || !sessionOwner(session, agentID, workspaceID) || trailing !== undefined ||
        (extra !== undefined && extra !== 'preview' && (resource !== 'external-files' || !/^\d{1,3}$/.test(extra)))) {
      throw new HttpError(404, 'session-route-not-found');
    }
    const execution = store.executionProfile(agentID, workspaceID);
    if (method === 'POST' && !execution) {
      throw new HttpError(409, 'agent-inactive');
    }
    const references = chat.references!;
    const referenceView = (file: ReturnType<typeof references.list>[number]) =>
      publicReference(file, store.external.workspace(workspaceID), references.confidential(file.path));
    if (resource === 'references') {
      if (item && uuid.test(item)) {
        const file = references.get(id, item);
        if (!file) throw new HttpError(404, 'reference-not-found');
        if (method === 'GET' && extra === 'preview') {
          const signal = new AbortController();
          response.once('close', () => signal.abort());
          const preview = await references.read(id, file, { reference: item, ...(file.directory && { list: true }) }, signal.signal);
          if (!response.destroyed) send(response, 200, preview);
          return;
        }
        if (method !== 'POST' || extra !== undefined) throw new HttpError(404, 'route-not-found');
        const { action, classification, revision } = await body(request);
        if (!sessions.has(id)) throw new HttpError(404, 'session-not-found');
        if (action === 'open') {
          await references.openExplorer(id, file);
          send(response, 200, {});
          return;
        }
        if (revision !== file.revision) throw new HttpError(409, 'reference-changed');
        if (action === 'remove') {
          references.remove(id, file);
          send(response, 200, {});
        } else if (action === 'classify' && labelInput(classification)) {
          if (classification !== 'confidential' && references.confidential(file.path)) throw new HttpError(409, 'external-confidential');
          send(response, 200, referenceView(references.classify(id, file, classification)));
        } else if (action === 'reconfirm') {
          send(response, 200, referenceView(await references.reconfirm(id, file, () => sessions.has(id))));
        } else throw new HttpError(400, 'reference-unavailable');
        events.notify(id);
        return;
      }
      if (method !== 'POST' || item !== undefined || extra !== undefined) throw new HttpError(404, 'route-not-found');
      const input = await body(request);
      const signal = new AbortController();
      response.once('close', () => signal.abort());
      const live = () => sessions.has(id) && Boolean(store.executionProfile(agentID, workspaceID));
      const fields = Object.keys(input);
      const { picker, locale, paths, folder } = input;
      const files = fields.length === 2 && (picker === 'file' || picker === 'folder') && (locale === 'en' || locale === 'zh-TW')
        ? await references.pick(id, picker, locale, signal.signal, live)
        : fields.length === 1 && Array.isArray(paths) && paths.every((path) => typeof path === 'string')
          ? await references.attach(id, paths, live, signal.signal)
          : fields.length === 1 && typeof folder === 'string' &&
              store.agentWorkspaces(agentID).find(({ id }) => id === workspaceID)?.folders.includes(folder)
            ? await references.attach(id, [folder], live, signal.signal, true)
            : undefined;
      if (!files) throw new HttpError(400, 'reference-unavailable');
      if (files.length) events.notify(id);
      if (!response.destroyed) send(response, files.length ? 201 : 200, { references: files.map(referenceView) });
      return;
    }
    if (resource === 'external-sources' && extra === undefined) {
      if (item === undefined && method === 'GET') {
        const workspace = store.agentWorkspaces(agentID).find(({ id }) => id === workspaceID)!;
        send(response, 200, { workspace: { id: workspaceID, classification: store.external.workspace(workspaceID),
          folders: folderChoices(workspace.folders) }, sources: externalSources.list(session) });
      } else if (item === undefined) {
        const sourceId = externalSources.register(session, sourceInput(await body(request)));
        send(response, 201, externalSources.inspect(session, sourceId));
      } else if (uuid.test(item) && method === 'POST') {
        const { sha256, classification, ...extra } = await body(request);
        if (!hashInput(sha256) || !labelInput(classification) || Object.keys(extra).length) throw invalidExternal();
        send(response, 200, externalSources.classify(session, item, sha256, classification));
      } else throw invalidExternal();
      return;
    }
    if (method === 'POST' && resource === 'external-snapshot' && item === undefined && extra === undefined) {
      const { runId, provider, taskId, inputs, specialistId } = snapshotInput(await body(request));
      external.requiresReady(provider);
      const { id: publicInputId, digest } = store.delegations.atomic(() => externalSources.create(session, runId, provider, taskId, inputs));
      send(response, 201, { publicInputId, digest, specialistId });
      return;
    }
    if (method === 'GET' && resource === 'artifacts' && item && uuid.test(item)) {
      if (extra === 'preview') {
        const output = chat.download(session, item);
        const projection = await convertWorkbook(output.data);
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(projection);
      } else download(response, chat, session, item);
      return;
    }
    if (method === 'GET' && resource === 'external-files' && item && uuid.test(item) && /^\d{1,3}$/.test(extra ?? '')) {
      let output;
      try { output = chat.externalFile(session, item, Number(extra)); }
      catch { throw new HttpError(409, 'external-changed'); }
      if (!output) throw new HttpError(404, 'file-not-found');
      sendDownload(response, output, 'text/plain; charset=utf-8');
      return;
    }
    if (resource === 'attachments' && item && uuid.test(item)) {
      if (method === 'GET') {
        const output = chat.attachments.read(id, chat.workspace(session), item, extra === 'preview');
        if (extra === 'preview') {
          const mime = isAttachmentImage(output.mime) ? output.mime : 'text/plain; charset=utf-8';
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
    if (method === 'POST' && resource === 'knowledge-ask' && runtime.knowledge) {
      const input = parseAsk(await body(request));
      if (!input) throw new HttpError(400, 'invalid-knowledge-question');
      const client = new AbortController();
      response.once('close', () => client.abort());
      const result = await chat.askKnowledge(input, AbortSignal.any([client.signal, AbortSignal.timeout(76_000)]), session);
      if (!response.destroyed) send(response, 200, result);
      return;
    }
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
      const folder = store.agentWorkspaces(agentID).find(({ id }) => id === workspaceID)?.folders.find((path) => path === input.folder);
      if (!folder || typeof input.file !== 'string' || !sessions.has(id)) throw new HttpError(404, 'file-not-found');
      const safeRoot = validateProjectFolder(folder, root);
      const name = basename(input.file);
      const mime = uploadType(name, 'application/octet-stream');
      let data: Buffer;
      try { data = openWorkspaceFile(safeRoot, input.file, 20 * 1024 * 1024).data; }
      catch { throw new HttpError(404, 'file-unreadable'); }
      const attachment = await chat.attachments.upload(id, chat.workspace(session), name, mime, data.length, async () => data, false);
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
      // A stored annotation can be removed even when the runtime cannot load its message.
      const stored = value === null && store.hasAnnotation(id, messageID);
      if ((!stored && !(await chat.state(session)).messages?.some((message) => message.id === messageID)) || !sessions.has(id)) {
        throw new HttpError(404, 'message-not-found');
      }
      store.annotate(id, messageID, field, value, value === null ? null : reason);
      events.notify(id);
      send(response, 200, { annotations: store.annotations(id) });
      return;
    }
    if (method === 'GET' && resource === 'action-decisions') send(response, 200, store.actionDecisions(id));
    else if (method === 'GET' && resource === 'state') {
      const state = await chat.state(session, !execution);
      const cards = agentID === 'main' ? store.delegations.cards(id) : [];
      const delegations = cards.map((card) => {
        const review = 'reviewRef' in card && card.reviewRef?.reviewId;
        const approval = store.external.confirmation(card.delegationId);
        const pending = card.status === 'queued' && approval?.decision === null;
        return { ...card, ...(pending && { status: 'awaiting_confirmation' }), specialistName: runtime.redact(card.specialistName),
          ...(approval?.decision && { externalConfirmation: { decision: approval.decision, at: approval.decidedAt } }),
          published: Boolean(review && runtime.knowledge?.reviewStore.publicationNotice(review)) };
      });
      const uploads = state.attachments.map((file) => {
        const sourceId = store.external.attachmentSource(id, file.id);
        return { ...file, sourceId, classification: store.delegations.attachmentClassification(workspaceID, file.id, file.sha256) };
      });
      send(response, 200, { ...state, attachments: [...uploads, ...references.list(id).map(referenceView)],
        workspaceClassification: store.external.workspace(workspaceID), activity: events.cards(id), delegations });
    }
    else if (method === 'GET' && resource === 'events') events.add(response, session.id);
    else if (method === 'POST' && resource === 'delegation-seen') {
      const { id: delegationId } = await body(request);
      if (typeof delegationId !== 'string' || !uuid.test(delegationId)) throw new HttpError(404, 'delegation-not-found');
      if (store.delegations.markSeen(id, delegationId)) events.notify(id, 'delegation');
      send(response, 200, {});
    }
    else if (method === 'POST' && resource === 'attachments') {
      try {
        const attachment = await upload(request, chat, session);
        events.notify(session.id);
        send(response, 201, attachment);
      } catch (error) { throw uploadFailure(error, uploadAudit); }
    } else if (method === 'POST' && resource === 'attachment-diagnostics' && item === undefined) {
      reportClientUpload(uploadAudit, await body(request, 256));
      send(response, 200, {});
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
      const detail = error instanceof HttpError ? error : error instanceof DelegationError ? externalError(error) : new HttpError(503, 'unavailable');
      send(response, detail.status, { error: detail.message, errorDetail: detail.detail });
    }).finally(() => {
      if (request.method === 'POST' && response.headersSent && response.statusCode < 300 &&
          /^\/api\/(?:classification\/|agents(?:\/|$)|settings\/(?:external-helpers|knowledge)|knowledge\/)/.test(request.url ?? '')) {
        external.recheckActive();
      }
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  try {
    await dispatcher.start();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        auth = new LocalAuth((server.address() as AddressInfo).port);
        resolve();
      });
    });
  } catch (error) {
    await dispatcher.close();
    await telegram.close();
    await events.close();
    store.close();
    throw error;
  }
  return {
    pairURL: () => auth.pairURL(),
    async close() {
      mcpOAuth.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const stopped = chat.close();
      await events.close();
      server.closeAllConnections();
      await closed;
      await dispatcher.close();
      await Promise.all([stopped, telegram.close(), extraction?.close(), ...active]);
      store.close();
    },
  };
}
