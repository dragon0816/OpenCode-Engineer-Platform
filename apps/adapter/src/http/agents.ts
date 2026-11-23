import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { canonical, sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import { telegramCredentialRef } from '../channels/accounts.ts';
import { assistantMcpPaused } from '../runs/custom-mcp.ts';
import { helpers, isProvider, type Provider } from '../runs/external-ledger.ts';
import type { ExternalDelegations } from '../runs/external-delegations.ts';
import type { AgentSettings, WebStore } from '../runs/web-store.ts';
import { checkDirectory } from '../runs/workspace.ts';
import type { startTelegram } from '../telegram/service.ts';
import { parseAvatar } from './avatar.ts';
import { HttpError } from './errors.ts';

const invalid = () => new HttpError(400, 'agent-settings-invalid');
const stale = () => new HttpError(409, 'agent-revision-conflict');
const fields = ['name', 'introduction', 'instructions', 'defaultModel', 'modelSource', 'replyLocale', 'avatar', 'knowledgeReads', 'mcpGrants'];
type Input = Record<string, unknown>;

function parseSettings(input: Input, redact: Runtime['redact'], requireName: boolean): AgentSettings {
  const result: AgentSettings = {};
  for (const [field, limit] of [['name', 80], ['introduction', 500], ['instructions', 4000]] as const) {
    const value = input[field];
    if (value === undefined && !(field === 'name' && requireName)) continue;
    if (typeof value !== 'string' || value.length > limit || (field === 'name' && requireName && !value.trim())) {
      throw new HttpError(400, 'assistant-length');
    }
    if (redact(value) !== value) throw new HttpError(400, 'assistant-credentials');
    result[field] = value.trim();
  }
  const { defaultModel, modelSource, replyLocale } = input;
  if (modelSource !== undefined) {
    if (modelSource !== 'gateway' && !isProvider(modelSource)) throw invalid();
    result.modelSource = modelSource;
  }
  if (defaultModel !== undefined) {
    if (defaultModel !== null && typeof defaultModel !== 'string') throw invalid();
    result.defaultModel = defaultModel;
  }
  if (replyLocale !== undefined) {
    if (replyLocale !== 'en' && replyLocale !== 'zh-TW') throw invalid();
    result.replyLocale = replyLocale;
  }
  if ('avatar' in input) result.avatar = parseAvatar(input.avatar);
  for (const field of ['knowledgeReads', 'mcpGrants'] as const) {
    const list = input[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 1000 || new Set(list).size !== list.length ||
        !list.every((id): id is string => typeof id === 'string' && Boolean(id) && id.length <= 128)) throw invalid();
    result[field] = list;
  }
  return result;
}

function bindInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { credentialRef, accountId, bindingRevision, setupId, ownerConfirmed, ...extra } = value as Input;
  if (setupId !== undefined) {
    if (typeof setupId !== 'string' || typeof ownerConfirmed !== 'boolean' || credentialRef !== undefined || accountId !== undefined ||
        bindingRevision !== undefined || Object.keys(extra).length) throw invalid();
    return { action: 'setup-save', setupId, ownerConfirmed };
  }
  if (ownerConfirmed !== undefined) throw invalid();
  if (Object.keys(extra).length || (accountId === undefined ?
    bindingRevision !== undefined || typeof credentialRef !== 'string' || !telegramCredentialRef.test(credentialRef) :
    typeof accountId !== 'string' || !Number.isSafeInteger(bindingRevision) || credentialRef !== undefined)) throw invalid();
  return { action: 'bind', credentialRef, accountId, bindingRevision, handler: 'chat' };
}

export function agentManagement(root: string, store: WebStore, runtime: Runtime, telegram: ReturnType<typeof startTelegram>,
  external: ExternalDelegations) {
  function choices() {
    const selection = store.modelSelection(runtime.builtInAliases, runtime.alias);
    const models = selection.ids;
    const vaults = (runtime.knowledge?.overview() ?? []).map(({ id, title, revision }) => ({ id, title: runtime.redact(title), revision }));
    const definitions = store.customMcpServers();
    const tools = definitions.map(({ createdAt: _createdAt, updatedAt: _updatedAt, ...server }) => ({
      id: server.id, name: runtime.redact(server.name),
      paused: assistantMcpPaused(server) || server.transport !== 'remote' || URL.parse(server.url)?.protocol !== 'https:', enabled: server.enabled,
      projects: server.appliesToProjects, pending: !runtime.customMcp?.some((applied) => canonical(applied) === canonical(server)),
    }));
    const externalModels = (Object.keys(helpers) as Provider[]).map((provider) => {
      const { enabled, revision, termsConfirmed } = store.external.settings(provider);
      const status = external.status(provider);
      return { provider, name: helpers[provider].name, enabled, revision, termsConfirmed, status,
        available: enabled && status.isolation === 'verified' && status.installation === 'detected' && status.login === 'signedIn' };
    });
    const revision = sha256(JSON.stringify([selection, externalModels.map(({ provider, revision }) => [provider, revision]),
      vaults.map(({ id, revision }) => [id, revision]),
      definitions.map(({ id, updatedAt }) => [id, updatedAt]), store.agents().map(({ id, revision }) => [id, revision])]));
    return { revision, models, externalModels, appliedModels: runtime.aliases, vaults, tools };
  }

  function validate(settings: AgentSettings, available: ReturnType<typeof choices>, id?: string) {
    if (isProvider(settings.modelSource) && settings.modelSource !== (id && store.agentModelSource(id)) &&
        !available.externalModels.some(({ provider, enabled }) => provider === settings.modelSource && enabled)) {
      throw new HttpError(409, 'external-disabled');
    }
    if (settings.defaultModel != null && !available.models.includes(settings.defaultModel)) {
      throw new HttpError(400, 'unapproved-model');
    }
    if (settings.knowledgeReads?.some((read) => !available.vaults.some(({ id }) => id === read))) {
      throw new HttpError(400, 'agent-knowledge-invalid');
    }
    if (settings.mcpGrants) {
      const prior = id ? store.agentBindings(id).mcpGrants : [];
      const eligible = (tool: typeof available.tools[number]) => tool.enabled && !tool.paused &&
        (id === 'main' ? tool.projects.length > 0 : tool.projects.includes('default'));
      if (settings.mcpGrants.some((grant) => !available.tools.some((tool) => tool.id === grant && eligible(tool)))) {
        throw new HttpError(400, 'agent-mcp-invalid');
      }
      // Preserve paused or globally disabled legacy grants when editing the eligible set.
      settings.mcpGrants.push(...prior.filter((grant) => available.tools.some((tool) => tool.id === grant && !eligible(tool))));
    }
  }

  function projectAgents() {
    const accounts = telegram.channels().filter(({ state }) => state === 'enabled');
    return store.agents().map(({ instructions, ...agent }) => {
      const webStatus = store.agentStatus(agent.id);
      const channelStatus = telegram.agentStatus(agent.id);
      return { ...agent, name: runtime.redact(agent.name), introduction: runtime.redact(agent.introduction),
        instructions: runtime.redact(instructions),
        status: agent.state === 'archived' ? 'disabled' : [webStatus, channelStatus].includes('busy') ? 'busy' :
          [webStatus, channelStatus].includes('queued') ? 'queued' : 'available',
        workspaces: store.agentWorkspaces(agent.id), ...store.agentBindings(agent.id),
        channels: accounts.filter(({ agentId }) => agentId === agent.id).map(({ accountId, botName }) => ({ accountId, botName })),
      };
    });
  }

  function list() { return { agents: projectAgents(), ...choices() }; }

  function detail(id: string) {
    const agent = projectAgents().find((entry) => entry.id === id);
    if (!agent) throw new HttpError(404, 'agent-not-found');
    return { agent, ...choices() };
  }

  async function create(input: Input, browser: string) {
    if (typeof input.revision !== 'string' || Object.keys(input).some((field) => ![...fields, 'revision', 'channel'].includes(field))) {
      throw invalid();
    }
    const settings = parseSettings(input, runtime.redact, true);
    const id = 'agent-' + randomUUID();
    const channel = input.channel === undefined ? undefined : bindInput(input.channel);
    const parent = join(root, 'agents');
    const folder = join(parent, id);
    const created: string[] = [];
    const prepare = store.agentCreation(id, settings, () => {
      const available = choices();
      if (input.revision !== available.revision) throw stale();
      validate(settings, available);
      checkDirectory(parent);
      for (const path of [folder, ...['sessions', 'model-work', 'artifacts'].map((name) => join(folder, name))]) {
        mkdirSync(path);
        created.push(path);
        checkDirectory(path);
      }
    });
    try {
      if (channel) {
        if (channel.accountId && !telegram.channels().some(({ accountId, verified, state }) =>
          accountId === channel.accountId && verified && state === 'disabled')) throw new HttpError(409, 'channel-binding-stale');
        await telegram.configureChannel({ ...channel, agentId: id, confirmed: true }, browser, prepare);
      } else store.createAgent(prepare);
    } catch (error) {
      if (!store.defaultWorkspace(id)) for (const path of created.reverse()) {
        try { rmdirSync(path); } catch { /* Only remove empty directories created by this request. */ }
      }
      throw error;
    }
    return detail(id);
  }

  function update(id: string, input: Input) {
    const { revision, action, ...changes } = input;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw invalid();
    const keys = Object.keys(changes);
    if (action === 'edit') {
      if (!keys.length || keys.some((field) => !fields.includes(field))) throw invalid();
      const settings = parseSettings(changes, runtime.redact, id !== 'main' && 'name' in changes);
      validate(settings, choices(), id);
      store.updateAgent(id, revision, settings, telegram.agentStatus(id));
    } else {
      if (keys.length) throw invalid();
      if (action === 'archive') store.updateAgent(id, revision, null, telegram.agentStatus(id));
      else if (action === 'delete') telegram.archiveAgent(id, revision, telegram.agentStatus(id));
      else if (action === 'restore') store.restoreAgent(id, revision);
      else throw invalid();
    }
    return detail(id);
  }

  return { list, detail, create, update };
}
