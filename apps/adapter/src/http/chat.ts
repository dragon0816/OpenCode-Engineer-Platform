import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord, RunState } from '../../../../packages/contracts/src/run.ts';
import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import type { AskRequest } from '../../../../packages/knowledge/src/ask.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { knowledgeMcpName, knowledgeToolName } from '../opencode/knowledge-mcp.ts';
import { call } from '../opencode/client.ts';
import { providerID } from '../opencode/gateway.ts';
import { submissionCount, waitForOutcome } from '../opencode/reconcile.ts';
import { createSession, promptID, submitOnce, validateSessionProfile } from '../opencode/sessions.ts';
import type { Agent } from '../opencode/sessions.ts';
import { knowledgeTool, readFileTool, retainsPermissions, sessionPermissions, writeFileTool } from '../opencode/permissions.ts';
import { legacyWorkspace } from '../runs/agent-ledger.ts';
import { ModelSeat } from '../opencode/model-seat.ts';
import { nonceMarker, stripTransportText, transportField } from '../opencode/tool-transport.ts';
import { AttachmentService, publicAttachment } from '../runs/attachments.ts';
import { openWorkspaceFile, checkDirectory, scopedPath } from '../runs/workspace.ts';
import { channelText } from '../channels/catalog.ts';
import type { Destination } from '../channels/transport.ts';
import type { ProjectID, WebSession, WebStore } from '../runs/web-store.ts';
import { publishWorkbook, workbookLimit, workbookName } from '../runs/web-workbook.ts';
import { readFileResult, runFiles, workbookInput } from '../runs/controlled-files.ts';
import { until } from '../../../../scripts/phase0/probe-http.ts';
import { HttpError } from './errors.ts';
import { describeTurnError, webMessage } from './messages.ts';
import { turnMarker } from '../opencode/turn-limits.ts';
import type { TurnLimits } from '../opencode/turn-limits.ts';

export type Turn = { id: string; text: string; attachments: string[]; workbook: boolean; replyTo?: string };
const active = new Set<RunState>(['accepted', 'running', 'awaiting_permission', 'background']);

type ToolCard = {
  id: string; name: string; status: 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; finishedAt?: number;
  input: string; output: string;
};

function toolText(value: unknown, redact: (text: string) => string): string {
  if (value == null) return '';
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map((entry) => toolText(entry, redact)).join('\n');
    if (typeof value === 'object') return Object.entries(value).filter(([key]) => key !== transportField).map(([key, entry]) =>
      /token|key|secret|password|credential|authorization|cookie/i.test(key)
        ? '已遮蔽' : toolText(key, redact) + ' · ' + toolText(entry, redact)).join('\n');
    return String(value);
  }
  return stripTransportText(redact(value))
    .replace(/\b(?:https?|wss?|file):[^\s"'<>]+/gi, '〔網址已遮蔽〕')
    .replace(/\b(?:bearer\s+|(?:api[-_ ]?key|access[-_ ]?token|token|secret|password|authorization)[\"']?\s*[:=]\s*)[^\r\n]+/gi, '〔憑證已遮蔽〕')
    .replace(/\b(?:sk[-_]|gh[pousr]_|xox[baprs]-)[a-z0-9_-]+\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/gi, '〔憑證已遮蔽〕')
    .replace(/(?:[a-z]:[\\/]|\\\\|(?<![\w./])\/)[^\r\n"'<>]*/gi, '〔路徑已遮蔽〕');
}

export function publicRun(run: RunRecord) {
  const recorded = run.errors.at(-1);
  const errorDetail = recorded ? describeTurnError(recorded) : undefined;
  return { id: run.id, state: run.state, createdAt: run.createdAt, error: errorDetail?.text, errorDetail, finishedAt: run.finishedAt,
    artifact: run.state === 'verified' && run.artifact
      ? { name: workbookName, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: run.artifact.bytes, sha256: run.artifact.sha256 } : undefined };
}

export function publicSession({ id, agent, alias, createdAt, title, project, knowledgeDisabled,
  knowledgeAllowed = !knowledgeDisabled }: WebSession & { knowledgeAllowed?: boolean }) {
  return { id, agent, alias, createdAt, project, tools: knowledgeAllowed ? [`${knowledgeMcpName}_${knowledgeToolName}`] : [],
    ...(title ? { title } : {}) };
}

type RuntimeConnection = Pick<Runtime, 'client' | 'alias' | 'aliases' | 'setTurnBoundary' | 'gatewayCursor' | 'gatewaySince' | 'redact'> &
  Partial<Pick<Runtime, 'remoteMcp' | 'knowledge' | 'modelSeat' | 'toolTickets'>>;

export class ChatService {
  readonly attachments: AttachmentService;
  private readonly store: WebStore;
  private readonly ledger: WebStore;
  private readonly runtime: RuntimeConnection;
  private readonly root: string;
  private readonly audit: string;
  private readonly notify: (sessionID: string) => void;
  private readonly stop = new AbortController();
  private readonly recovering = new Set<string>();
  private readonly switching = new Set<string>();
  private readonly executing = new Map<string, { stop: AbortController; done: Promise<void> }>();
  private readonly modelSeat: ModelSeat;
  private readonly pending = new Set<Promise<void>>();

  constructor(store: WebStore, runtime: RuntimeConnection, root: string, audit: string, notify: (sessionID: string) => void, ledger = store) {
    this.store = store;
    this.ledger = ledger;
    this.runtime = runtime;
    this.modelSeat = runtime.modelSeat ?? new ModelSeat();
    this.root = root;
    this.audit = audit;
    this.notify = notify;
    this.attachments = new AttachmentService(store);
    for (const session of this.store.sessions()) {
      try { this.attachments.clean(session.id, this.workspace(session)); }
      catch { /* An unsafe or unavailable workspace is rejected when used. */ }
      const latest = this.store.turns(session.id).at(-1);
      if (latest && active.has(latest.state)) this.store.change(latest.id, latest.state === 'accepted' ? 'failed' : 'indeterminate',
        { errors: ['OEP restarted before this turn could be verified. The message was not resent'] });
    }
  }

  projectRoot(project: ProjectID) {
    return project === 'default' ? this.root : scopedPath(this.root, project);
  }

  private sessionRoot(session: WebSession) {
    const owner = this.store.sessionOwner(session);
    if (!owner) throw new HttpError(409, 'session-unavailable');
    return this.profile(owner.agentID, owner.workspaceID, session.project, true).directory;
  }

  workspace(session: WebSession) { return scopedPath(join(this.sessionRoot(session), 'sessions'), session.id); }
  private modelWorkspace(session: WebSession) { return scopedPath(join(this.sessionRoot(session), 'model-work'), session.id); }

  private profile(agentID: string, workspaceID: string, project: ProjectID, includeArchived = false) {
    const profile = this.ledger.executionProfile(agentID, workspaceID, includeArchived);
    const legacy = agentID === 'main';
    const relativeRoot = legacy ? (project === 'default' ? 'web' : `web/${project}`) : `web/agents/${agentID}`;
    if (!profile || profile.relativeRoot !== relativeRoot ||
        (legacy ? workspaceID !== legacyWorkspace(project) : project !== 'default' || !/^[a-z\d][a-z\d_-]{0,79}$/.test(agentID))) {
      throw new HttpError(409, 'session-unavailable');
    }
    const directory = legacy ? this.projectRoot(project) : scopedPath(this.root, `agents/${agentID}`);
    return { ...profile, directory };
  }

  private permissions(session: Pick<WebSession, 'project' | 'knowledgeDisabled'>, agentID: string,
    workspaceID: string, origin: 'web' | 'channel', vaults: readonly string[]) {
    const custom = this.runtime.remoteMcp?.tools.length
      ? this.runtime.remoteMcp.names(this.ledger.executionMcpGrants(agentID, workspaceID), session.project) : [];
    return sessionPermissions({ agentID, origin, custom,
      status: Boolean(this.runtime.toolTickets), files: Boolean(this.runtime.toolTickets),
      knowledge: Boolean(this.runtime.toolTickets && vaults.length) });
  }

  private knowledgeVaults(agentID: string, workspaceID: string, disabled?: number) {
    return !disabled && this.ledger.knowledgeSettings().toolbox ? this.ledger.executionKnowledgeReads(agentID, workspaceID) : [];
  }

  private executionScope(session: WebSession, channel?: Destination) {
    const owner = this.store.sessionOwner(session);
    const origin = channel ? 'channel' : 'web';
    if (!owner || owner.origin !== origin || channel && (owner.channelAccount !== channel.accountId ||
        owner.agentID !== channel.agentId || owner.bindingRevision !== channel.bindingRevision ||
        owner.conversationKey !== channel.conversationKey)) {
      throw new HttpError(409, 'session-unavailable');
    }
    const profile = this.profile(owner.agentID, owner.workspaceID, session.project);
    if (!this.runtime.aliases.includes(session.alias)) throw new HttpError(400, 'unapproved-model');
    const vaults = this.knowledgeVaults(owner.agentID, owner.workspaceID, session.knowledgeDisabled);
    const permissions = this.permissions(session, owner.agentID, owner.workspaceID, origin, vaults);
    return { ...owner, ...profile, model: session.alias, permissions, vaults };
  }

  async askKnowledge(input: AskRequest, signal: AbortSignal, session?: WebSession, channel?: Destination) {
    return this.runtime.knowledge?.scopedAsk(input, signal, () => {
      try {
        if (session) return this.executionScope(session, channel);
        if (!channel) return;
        const workspaceID = this.ledger.defaultWorkspace(channel.agentId);
        if (!workspaceID) return;
        const profile = this.profile(channel.agentId, workspaceID, 'default');
        return { model: profile.defaultModel ?? this.runtime.alias, vaults: this.knowledgeVaults(channel.agentId, workspaceID) };
      } catch { /* Invalid session ownership or ledger state blocks the query. */ }
    });
  }

  async create(agent: Agent, project: ProjectID = 'default', requestedAlias?: string, channel?: Destination,
    owner?: { agentId: string; workspaceID: string }) {
    if (agent !== 'inspector' && agent !== 'workbook') throw new HttpError(400, 'invalid-assistant');
    const agentID = channel?.agentId ?? owner?.agentId ?? 'main';
    const workspaceID = channel ? this.ledger.defaultWorkspace(agentID) : owner?.workspaceID ?? legacyWorkspace(project);
    if (!workspaceID) throw new HttpError(409, 'session-unavailable');
    const origin = channel ? 'channel' : 'web';
    const profile = this.profile(agentID, workspaceID, project);
    const agentAlias = profile.defaultModel && this.runtime.aliases.includes(profile.defaultModel) ? profile.defaultModel : undefined;
    const alias = requestedAlias ?? agentAlias ?? this.runtime.alias;
    if (!this.runtime.aliases.includes(alias)) throw new HttpError(400, 'unapproved-model');
    const id = randomUUID();
    const createdAt = Date.now();
    const knowledgeDisabled = !this.ledger.knowledgeSettings().toolbox;
    const local = { id, project, agent, alias, createdAt, knowledgeDisabled: Number(knowledgeDisabled) };
    if (agentID !== 'main') {
      for (const path of [scopedPath(this.root, 'agents'), profile.directory,
        ...['sessions', 'model-work', 'artifacts'].map((name) => scopedPath(profile.directory, name))]) {
        mkdirSync(path, { recursive: true });
        checkDirectory(path);
      }
    }
    const workspace = scopedPath(join(profile.directory, 'sessions'), id);
    const modelWorkspace = scopedPath(join(profile.directory, 'model-work'), id);
    checkDirectory(join(profile.directory, 'sessions'));
    checkDirectory(join(profile.directory, 'model-work'));
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'attachments'));
    mkdirSync(modelWorkspace);
    mkdirSync(join(modelWorkspace, 'generated'));
    const permissions = this.permissions(local, agentID, workspaceID, origin, this.knowledgeVaults(agentID, workspaceID, local.knowledgeDisabled));
    const upstreamID = await createSession(this.runtime.client, modelWorkspace, agent, alias, permissions);
    const session = { ...local, upstreamID };
    this.store.createSession(session, channel && { ...channel, workspaceID }, owner);
    return session;
  }

  async state(session: WebSession) {
    const { client } = this.runtime;
    const { upstreamID: sessionID } = session;
    let runs = this.store.turns(session.id);
    const latest = runs.at(-1);
    let stateErrorDetail: ReturnType<typeof webMessage> | undefined;
    let messages: { id: string; role: 'user' | 'assistant'; text: string; createdAt?: number; tools?: ToolCard[]; reply?: { id: string; text: string } }[] | undefined;
    try {
      const pending = latest && (active.has(latest.state) || latest.state === 'indeterminate');
      const [{ data }, inbox, permissions, status] = await Promise.all([
        client.message.list({ sessionID, order: 'desc', limit: 100 }, call()),
        pending ? client.session.inbox.list({ sessionID }, call()) : [],
        pending ? client.permission.list({ sessionID }, call()) : [],
        pending ? client.session.active(call()) : undefined,
      ]);
      const runByMessage = new Map(runs.map((run) => [run.submissionID, run.id]));
      let turn: RunRecord | undefined;
      messages = data.reverse().flatMap((message): NonNullable<typeof messages> => {
        if (message.type === 'user') {
          const runID = runByMessage.get(message.id);
          turn = runs.find((run) => run.id === runID);
          const text = runID ? message.text.split(turnMarker(runID))[0] : message.text;
          return [{ id: message.id, role: 'user', text: stripTransportText(this.runtime.redact(text)), reply: runID ? this.store.reply(runID) : undefined, createdAt: message.time?.created }];
        }
        if (message.type !== 'assistant') return [];
        const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        const tools = message.content.flatMap((part): ToolCard[] => {
          if (part.type !== 'tool') return [];
          const state = part.state;
          const unfinished = state.status === 'streaming' || state.status === 'running';
          const status = state.status === 'completed' ? 'done' : turn?.state === 'cancelled' && (unfinished || !part.time.completed)
            ? 'cancelled' : unfinished ? 'running' : 'failed';
          return [{ id: part.id, name: toolText(part.name, this.runtime.redact), status,
            startedAt: part.time.created, finishedAt: part.time.completed ?? (status === 'cancelled' ? turn?.finishedAt : undefined),
            input: toolText(state.input, this.runtime.redact),
            output: toolText('content' in state && state.content ? state.content.flatMap((entry) => entry.type === 'text' ? [entry.text] : []) :
              'error' in state ? state.error : undefined, this.runtime.redact) }];
        });
        return text.trim() || tools.length ? [{ id: message.id, role: 'assistant', text: stripTransportText(this.runtime.redact(text)), createdAt: message.time?.created, tools }] : [];
      });
      if (latest?.state === 'indeterminate' && !status?.[sessionID] && !inbox.length && !permissions.length &&
          !this.recovering.has(latest.id)) {
        const current = this.store.get(latest.id);
        if (current.state === 'indeterminate') this.store.change(latest.id, 'failed', { finishedAt: Date.now() });
      }
    } catch {
      stateErrorDetail = webMessage('session-unavailable');
    }
    runs = this.store.turns(session.id);
    const owner = this.store.sessionOwner(session);
    const knowledgeAllowed = Boolean(owner && this.runtime.toolTickets &&
      this.knowledgeVaults(owner.agentID, owner.workspaceID, session.knowledgeDisabled).length);
    return { session: publicSession({ ...session, knowledgeAllowed }), messages, stateError: stateErrorDetail?.text, stateErrorDetail, runs: runs.map(publicRun),
      attachments: this.store.attachments(session.id).map(publicAttachment), annotations: this.store.annotations(session.id) };
  }

  modelSwitchPending(id: string) { return this.switching.has(id); }

  private async applyModel<T>(session: WebSession, alias: string, complete: () => T) {
    this.switching.add(session.id);
    try {
      await this.runtime.client.session.switchModel({ sessionID: session.upstreamID, model: { id: alias, providerID } }, call());
      this.store.saveSessionAlias(session.id, alias);
      session.alias = alias;
      this.notify(session.id);
      return complete();
    } finally { this.switching.delete(session.id); }
  }

  async switchModel(session: WebSession, alias: string) {
    if (!this.runtime.aliases.includes(alias)) throw new HttpError(400, 'unapproved-model');
    const latest = this.store.turns(session.id).at(-1);
    if (this.switching.has(session.id) || latest && !['verified', 'failed', 'cancelled'].includes(latest.state)) {
      throw new HttpError(409, 'model-change-busy');
    }
    return this.applyModel(session, alias, () => publicSession(session));
  }

  async submit(session: WebSession, input: Turn, reply?: { id: string; text: string }, channel?: Destination) {
    if (this.switching.has(session.id)) throw new HttpError(409, 'model-changing');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.store.turn(session.id, input.id);
    if (existing) {
      if (existing.hash !== hash) throw new HttpError(409, 'message-id-in-use');
      return publicRun(existing.run);
    }
    if (this.store.hasTurn(input.id)) throw new HttpError(409, 'message-id-unavailable');
    const prior = this.store.turns(session.id).at(-1);
    if (prior && (active.has(prior.state) || prior.state === 'indeterminate')) throw new HttpError(409, 'turn-pending');
    if (input.workbook && session.agent !== 'workbook') throw new HttpError(400, 'workbook-assistant-required');
    for (const id of input.attachments) {
      if (!this.store.attachment(session.id, id)) throw new HttpError(404, 'session-attachment-not-found');
    }
    const modelFallback = this.runtime.aliases.includes(session.alias) ? undefined : this.runtime.alias;
    if (modelFallback) return this.applyModel(session, modelFallback, () => {
      if (this.store.hasTurn(input.id)) throw new HttpError(409, 'message-id-unavailable');
      return { ...this.acceptTurn(session, input, hash, reply, channel), modelFallback };
    });
    return this.acceptTurn(session, input, hash, reply, channel);
  }

  private acceptTurn(session: WebSession, input: Turn, hash: string, reply?: { id: string; text: string }, channel?: Destination) {
    this.executionScope(session, channel);
    const run: RunRecord = { id: input.id, mode: input.workbook ? 'web-workbook' : 'web-chat', state: 'accepted',
      createdAt: Date.now(), workspace: this.modelWorkspace(session), alias: session.alias, sessionID: session.upstreamID,
      submissionID: promptID(), retries: 0, errors: [] };
    this.store.saveTurn(session.id, run, hash, reply);
    this.notify(session.id);
    const limits = this.store.turnLimits();
    const task = this.modelSeat.run(async () => {
      if (this.store.get(run.id).state === 'cancelled') return;
      const stop = new AbortController();
      const done = this.execute(session, run, input, limits, stop.signal, channel);
      this.executing.set(run.id, { stop, done });
      try { await done; }
      finally { this.executing.delete(run.id); }
    }).catch(() => {
      console.error('OEP failed to record a web turn');
    }).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return publicRun(run);
  }

  async cancel(session: WebSession, id: string) {
    const run = this.store.turn(session.id, id)?.run;
    if (!run) throw new HttpError(404, 'turn-not-found');
    const execution = this.executing.get(id);
    if (execution && active.has(run.state)) {
      execution.stop.abort();
      await execution.done;
    } else if (run.state === 'accepted') {
      this.store.change(id, 'cancelled', { finishedAt: Date.now() });
      this.notify(session.id);
    }
    return publicRun(this.store.get(id));
  }

  private async execute(session: WebSession, run: RunRecord, input: Turn, limits: TurnLimits, cancelled: AbortSignal, channel?: Destination) {
    const { client } = this.runtime;
    const { upstreamID: sessionID } = session;
    const cursor = this.runtime.gatewayCursor();
    const boundary = new AbortController();
    let exceeded: string | undefined;
    let tools = 0;
    const stopAtLimit = (message: string) => {
      exceeded ??= message;
      boundary.abort();
    };
    const timeout = setTimeout(() => stopAtLimit('已停止：達到回合時限。'), limits.timeoutSeconds * 1000);
    const signal = AbortSignal.any([this.stop.signal, cancelled, boundary.signal]);
    let state: 'verified' | 'failed' | 'indeterminate' | 'cancelled' = 'failed';
    let error: string | undefined;
    let sent = false;
    let result: Partial<RunRecord> = {};
    let recheck: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let closeTickets: (() => void) | undefined;
    const update = (state: RunState) => { this.store.change(run.id, state); this.notify(session.id); };
    try {
      this.stop.signal.throwIfAborted();
      const readScope = () => this.executionScope(session, channel);
      const upstream = await client.session.get({ sessionID }, call());
      if (upstream.id !== sessionID) throw new Error('Session ID mismatch');
      validateSessionProfile(upstream, run.workspace, session.agent, session.alias);
      const scope = readScope();
      if (scope.model !== run.alias || run.workspace !== this.modelWorkspace(session)) throw new Error('Dispatch scope mismatch');
      await client.session.update({ sessionID, permissions: scope.permissions }, call());
      const liveScope = () => {
        try { return readScope(); }
        catch { /* Invalid live ownership or configuration revokes this turn. */ }
      };
      const checkScope = () => {
        const current = liveScope();
        if (current && current.agentID === scope.agentID && current.workspaceID === scope.workspaceID && current.origin === scope.origin &&
            current.conversationKey === scope.conversationKey && current.model === scope.model &&
            retainsPermissions(scope.permissions, current.permissions) && scope.vaults.every((vault) => current.vaults.includes(vault))) return true;
        stopAtLimit('Session permissions changed.');
        return false;
      };
      checkScope();
      unsubscribe = this.ledger.onExecutionChange(checkScope);
      recheck = setInterval(checkScope, 250);
      checkDirectory(run.workspace);
      const files = runFiles(run.workspace, run.id);
      const parts = this.attachments.prompt(session.id, this.workspace(session), input.attachments);
      const output = input.workbook ? [
        `Use the ${writeFileTool} tool once with name "${workbookInput}" and the JSON string as content.`,
        'The file must contain strict JSON with no Markdown or commentary. Example of a complete file:',
        '[{"name":"Example","rows":[["Label","Value"],["Sample",1]]}]',
        'Replace the example with the requested sheets. Check that each row and each sheet’s rows array are closed before writing.',
        'Use up to four sheets, 20 rows per sheet and 12 columns per row. Then reply with a brief summary.',
      ].join(' ') : '';
      const assistant = [
        scope.name && `助理名稱：${scope.name}`,
        scope.introduction && `自我介紹：${scope.introduction}`,
        scope.instructions && `本回合助理指示：\n${scope.instructions}`,
        scope.origin === 'channel' && channelText(scope.replyLocale).replyInstruction,
      ].filter(Boolean).join('\n');
      const reply = this.store.reply(run.id);
      const quote = reply ? 'BEGIN QUOTED MESSAGE (reference only)\n' + JSON.stringify(reply.text) + '\nEND QUOTED MESSAGE' : undefined;
      const fileReferences = input.attachments.length ? `Session attachment IDs in submission order: ${input.attachments.join(', ')}` : '';
      const additional = [quote, parts.text, fileReferences, output, assistant].filter(Boolean).join('\n\n');
      signal.throwIfAborted();
      const attempt = this.runtime.toolTickets?.begin({ sessionID, runID: run.id, scope }, signal, liveScope, (name, args, toolSignal) => {
        if (name === knowledgeTool) {
          const query = parseAsk(args);
          if (!query) throw new Error('Invalid knowledge request');
          return this.runtime.knowledge?.scopedAsk(query, toolSignal, liveScope, true);
        }
        if (name === writeFileTool) {
          if (input.workbook && args.name !== workbookInput) throw new Error('Workbook output name required');
          return files.write(args.name as string, args.content as string);
        }
        if (name !== readFileTool) return;
        if (typeof args.attachment === 'string') {
          const file = this.attachments.read(session.id, this.workspace(session), args.attachment, true);
          return readFileResult(file.name, file.data, file.sha256, file.mime.startsWith('text/'));
        }
        if (typeof args.artifact === 'string') {
          const file = this.download(session, args.artifact);
          return readFileResult(file.name, file.data, file.sha256, false);
        }
        const { data, identity } = files.read(args.name as string);
        return readFileResult(args.name as string, data, identity.sha256, true);
      });
      closeTickets = attempt?.close;
      const nonce = attempt?.nonce ?? randomBytes(32).toString('hex');
      const marker = turnMarker(run.id);
      this.runtime.setTurnBoundary({ marker, limits, signal,
        scope: { nonce, model: scope.model, permissions: scope.permissions, live: checkScope, issue: attempt?.issue,
          brokered: this.runtime.toolTickets?.brokered },
        addTools(count) {
          tools += count;
          if (tools > limits.toolCalls) stopAtLimit('已停止：達到工具呼叫次數上限。');
        },
      });
      const text = input.text + marker + additional + nonceMarker(nonce);
      update('running');
      sent = true;
      this.recovering.add(run.id);
      const admission = await submitOnce(client, { sessionID, id: run.submissionID!, text, files: parts.files });
      signal.throwIfAborted();
      if (admission === 'indeterminate') throw new Error('Uncertain admission');
      const outcome = await waitForOutcome(client, sessionID, update, limits.timeoutSeconds * 1000 + 1000, signal, run.submissionID);
      closeTickets?.();
      const count = await submissionCount(client, sessionID, run.submissionID!);
      if (count.inbox !== 0 || count.messages !== 1) throw new Error('Unexpected durable submission count');
      signal.throwIfAborted();
      sent = false;
      const calls = this.runtime.gatewaySince(cursor);
      const replied = async () => {
        const { data } = await client.message.list({ sessionID, order: 'desc', limit: 40 }, call());
        const index = data.findIndex((message) => message.id === run.submissionID);
        return index >= 0 && data.slice(0, index).some((message) => message.type === 'assistant' &&
          message.content.some((part) => part.type === 'text' && part.text.trim()));
      };
      if (outcome !== 'succeeded' || !calls.some((call) => call.status === 200 && call.output !== 'empty') ||
          !input.workbook && !await replied()) {
        if (calls.some((call) => call.error === 'timeout')) error = 'The model gateway timed out. Try again when the service is available';
        else if (calls.length && calls.every((call) => call.output === 'empty')) error = 'The model returned an empty response. Try again';
        else error = 'The model request failed. Try again when the service is available';
      } else {
        signal.throwIfAborted();
        if (input.workbook) {
          update('background');
          result = await publishWorkbook(join(this.sessionRoot(session), 'artifacts'), files, run, signal);
        }
        state = 'verified';
      }
    } catch (reason) {
      closeTickets?.();
      if (cancelled.aborted || exceeded) state = 'cancelled';
      else if (sent) {
        state = 'indeterminate';
        error = this.runtime.gatewaySince(cursor).some((call) => call.error === 'timeout')
          ? 'The model gateway timed out. OEP requested cancellation and will check the session'
          : 'The turn could not be confirmed. OEP requested cancellation and will check the session';
        try { await client.session.interrupt({ sessionID }, call()); }
        catch { /* The durable inbox and active status remain authoritative. */ }
      } else if (reason instanceof HttpError) error = reason.message;
      else if (this.stop.signal.aborted) error = 'OEP stopped before this turn could finish';
      else error = input.workbook ? 'Workbook data could not be verified. The model must write valid workbook data' : 'The turn could not be completed';
    }
    clearTimeout(timeout);
    clearInterval(recheck);
    unsubscribe?.();
    if (cancelled.aborted || exceeded) {
      state = 'cancelled';
      error = exceeded;
      result = {};
      if (sent) {
        try {
          await client.session.interrupt({ sessionID }, call());
          const count = await submissionCount(client, sessionID, run.submissionID!);
          if (count.inbox) await client.session.inbox.cancel({ sessionID, inboxID: run.submissionID! }, call());
          await until(async (signal) => (await client.session.active({ signal }))[sessionID] ? undefined : true, 5_000);
        } catch {
          state = 'indeterminate';
          error = exceeded ? `${exceeded}正在核對上游狀態。` : '暫時無法確認這次處理是否已停止，正在核對。';
        }
      }
    }
    const modelCalls = this.runtime.gatewaySince(cursor);
    try {
      this.store.change(run.id, state, { ...result, finishedAt: Date.now(), errors: error ? [error] : [],
        modelRequestRange: { after: cursor, through: this.runtime.gatewayCursor() }, modelCalls });
      appendFileSync(this.audit, `${JSON.stringify({ runID: run.id, sessionID, submissionID: run.submissionID, alias: run.alias,
        state, error, elapsedMs: Date.now() - run.createdAt, modelCalls, artifact: result.artifact })}\n`);
    } finally {
      this.runtime.setTurnBoundary();
      this.recovering.delete(run.id);
      this.notify(session.id);
    }
  }

  download(session: WebSession, id: string) {
    const run = this.store.turn(session.id, id)?.run;
    if (run?.state !== 'verified' || !run.artifact?.identity || run.receipt?.runID !== id) throw new HttpError(404, 'workbook-not-found');
    try {
      const directory = scopedPath(join(this.sessionRoot(session), 'artifacts'), id);
      const output = openWorkspaceFile(directory, workbookName, workbookLimit, run.artifact.identity);
      return { name: workbookName, data: output.data, sha256: output.identity.sha256 };
    } catch { throw new HttpError(409, 'workbook-file-changed'); }
  }

  busy() {
    return Boolean(this.switching.size || this.executing.size || this.recovering.size || this.store.sessions().some((session) => {
      const last = this.store.turns(session.id).at(-1);
      return last && active.has(last.state);
    }));
  }

  async close() { this.stop.abort(); await Promise.all(this.pending); }
}
