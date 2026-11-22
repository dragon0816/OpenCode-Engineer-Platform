import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord, RunState } from '../../../../packages/contracts/src/run.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { knowledgeMcpName, knowledgeToolName } from '../opencode/knowledge-mcp.ts';
import { call } from '../opencode/client.ts';
import { providerID } from '../opencode/gateway.ts';
import { submissionCount, waitForOutcome } from '../opencode/reconcile.ts';
import { createSession, promptID, submitOnce, validateSessionProfile } from '../opencode/sessions.ts';
import type { Agent } from '../opencode/sessions.ts';
import { sessionPermissions } from '../opencode/permissions.ts';
import { legacyWorkspace } from '../runs/agent-ledger.ts';
import { AttachmentService, publicAttachment } from '../runs/attachments.ts';
import { openWorkspaceFile, checkDirectory, scopedPath } from '../runs/workspace.ts';
import type { ProjectID, WebSession, WebStore } from '../runs/web-store.ts';
import { publishWorkbook, workbookInput, workbookLimit, workbookName } from '../runs/web-workbook.ts';
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
    if (typeof value === 'object') return Object.entries(value).map(([key, entry]) =>
      /token|key|secret|password|credential|authorization|cookie/i.test(key)
        ? '已遮蔽' : toolText(key, redact) + ' · ' + toolText(entry, redact)).join('\n');
    return String(value);
  }
  return redact(value)
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

export function publicSession({ id, agent, alias, createdAt, title, project, knowledgeDisabled }: WebSession) {
  return { id, agent, alias, createdAt, project, tools: knowledgeDisabled ? [] : [`${knowledgeMcpName}_${knowledgeToolName}`],
    ...(title ? { title } : {}) };
}

type RuntimeConnection = Pick<Runtime, 'client' | 'alias' | 'aliases' | 'setTurnBoundary' | 'gatewayCursor' | 'gatewaySince' | 'redact'> & Partial<Pick<Runtime, 'customMcp'>>;

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
  private queue = Promise.resolve();

  constructor(store: WebStore, runtime: RuntimeConnection, root: string, audit: string, notify: (sessionID: string) => void, ledger = store) {
    this.store = store;
    this.ledger = ledger;
    this.runtime = runtime;
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

  workspace(session: Pick<WebSession, 'id' | 'project'>) { return scopedPath(join(this.projectRoot(session.project), 'sessions'), session.id); }
  private modelWorkspace(session: Pick<WebSession, 'id' | 'project'>) { return scopedPath(join(this.projectRoot(session.project), 'model-work'), session.id); }

  private profile(agentID: string, workspaceID: string, project: ProjectID) {
    const profile = this.ledger.executionProfile(agentID, workspaceID);
    const root = project === 'default' ? 'web' : `web/${project}`;
    if (agentID !== 'main' || workspaceID !== legacyWorkspace(project) || profile?.relativeRoot !== root) {
      throw new HttpError(409, 'session-unavailable');
    }
    return profile;
  }

  private permissions(session: Pick<WebSession, 'project' | 'knowledgeDisabled'>, agentID: string,
    workspaceID: string, origin: 'web' | 'channel', workbookRun?: string) {
    const current = this.ledger.executionMcpGrants(agentID, workspaceID);
    const custom = (this.runtime.customMcp ?? []).flatMap((registered) => {
      const grant = current.find(({ id }) => id === registered.id);
      return registered.enabled && registered.appliesToProjects.includes(session.project) && grant?.appliesToProjects.includes(session.project)
        ? [{ id: registered.id, deniedTools: [...new Set([...registered.deniedTools, ...grant.deniedTools])].sort() }] : [];
    });
    return sessionPermissions({ agentID, origin, workbookRun, custom,
      knowledge: !session.knowledgeDisabled && this.ledger.knowledgeSettings().toolbox });
  }

  private executionScope(session: WebSession, telegramTopic?: number, workbookRun?: string) {
    const owner = this.store.sessionOwner(session);
    const origin = telegramTopic === undefined ? 'web' : 'channel';
    if (!owner || owner.origin !== origin || origin === 'channel' && (owner.channelAccount !== 'telegram-main' ||
        owner.bindingRevision !== 1 || ![`topic:${telegramTopic}`, `legacy-session:${session.id}`].includes(owner.conversationKey ?? ''))) {
      throw new HttpError(409, 'session-unavailable');
    }
    const profile = this.profile(owner.agentID, owner.workspaceID, session.project);
    if (!this.runtime.aliases.includes(session.alias)) throw new HttpError(400, 'unapproved-model');
    const permissions = this.permissions(session, owner.agentID, owner.workspaceID, origin, workbookRun);
    return { ...owner, ...profile, model: session.alias, permissions };
  }

  async create(agent: Agent, project: ProjectID = 'default', requestedAlias?: string, telegramTopic?: number) {
    if (agent !== 'inspector' && agent !== 'workbook') throw new HttpError(400, 'invalid-assistant');
    const agentID = 'main';
    const workspaceID = legacyWorkspace(project);
    const origin = telegramTopic === undefined ? 'web' : 'channel';
    const profile = this.profile(agentID, workspaceID, project);
    const alias = requestedAlias ?? profile.defaultModel ?? this.runtime.alias;
    if (!this.runtime.aliases.includes(alias)) throw new HttpError(400, 'unapproved-model');
    const id = randomUUID();
    const createdAt = Date.now();
    const knowledgeDisabled = !this.ledger.knowledgeSettings().toolbox;
    const local = { id, project, agent, alias, createdAt, knowledgeDisabled: Number(knowledgeDisabled) };
    const workspace = this.workspace(local);
    const modelWorkspace = this.modelWorkspace(local);
    checkDirectory(join(this.projectRoot(project), 'sessions'));
    checkDirectory(join(this.projectRoot(project), 'model-work'));
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'attachments'));
    mkdirSync(modelWorkspace);
    mkdirSync(join(modelWorkspace, 'generated'));
    const permissions = this.permissions(local, agentID, workspaceID, origin);
    const upstreamID = await createSession(this.runtime.client, modelWorkspace, agent, alias, permissions);
    const session = { ...local, upstreamID };
    this.store.createSession(session, telegramTopic);
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
          return [{ id: message.id, role: 'user', text: this.runtime.redact(text), reply: runID ? this.store.reply(runID) : undefined, createdAt: message.time?.created }];
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
        return text.trim() || tools.length ? [{ id: message.id, role: 'assistant', text: this.runtime.redact(text), createdAt: message.time?.created, tools }] : [];
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
    return { session: publicSession(session), messages, stateError: stateErrorDetail?.text, stateErrorDetail, runs: runs.map(publicRun),
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

  async submit(session: WebSession, input: Turn, reply?: { id: string; text: string }, telegramTopic?: number) {
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
      return { ...this.acceptTurn(session, input, hash, reply, telegramTopic), modelFallback };
    });
    return this.acceptTurn(session, input, hash, reply, telegramTopic);
  }

  private acceptTurn(session: WebSession, input: Turn, hash: string, reply?: { id: string; text: string }, telegramTopic?: number) {
    this.executionScope(session, telegramTopic);
    const run: RunRecord = { id: input.id, mode: input.workbook ? 'web-workbook' : 'web-chat', state: 'accepted',
      createdAt: Date.now(), workspace: this.modelWorkspace(session), alias: session.alias, sessionID: session.upstreamID,
      submissionID: promptID(), retries: 0, errors: [] };
    this.store.saveTurn(session.id, run, hash, reply);
    this.notify(session.id);
    const limits = this.store.turnLimits();
    this.queue = this.queue.then(async () => {
      if (this.store.get(run.id).state === 'cancelled') return;
      const stop = new AbortController();
      const done = this.execute(session, run, input, limits, stop.signal, telegramTopic);
      this.executing.set(run.id, { stop, done });
      try { await done; }
      finally { this.executing.delete(run.id); }
    }).catch(() => {
      console.error('OEP failed to record a web turn');
    });
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

  private async execute(session: WebSession, run: RunRecord, input: Turn, limits: TurnLimits, cancelled: AbortSignal, telegramTopic?: number) {
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
    this.runtime.setTurnBoundary({ marker: turnMarker(run.id), limits, signal, addTools(count) {
      tools += count;
      if (tools > limits.toolCalls) stopAtLimit('已停止：達到工具呼叫次數上限。');
    } });
    let state: 'verified' | 'failed' | 'indeterminate' | 'cancelled' = 'failed';
    let error: string | undefined;
    let sent = false;
    let result: Partial<RunRecord> = {};
    let restorePermissions = false;
    let recheck: NodeJS.Timeout | undefined;
    const update = (state: RunState) => { this.store.change(run.id, state); this.notify(session.id); };
    try {
      this.stop.signal.throwIfAborted();
      const liveScope = () => this.executionScope(session, telegramTopic, input.workbook ? run.id : undefined);
      const upstream = await client.session.get({ sessionID }, call());
      if (upstream.id !== sessionID) throw new Error('Session ID mismatch');
      validateSessionProfile(upstream, run.workspace, session.agent, session.alias);
      const scope = liveScope();
      if (scope.model !== run.alias || run.workspace !== this.modelWorkspace(session)) throw new Error('Dispatch scope mismatch');
      restorePermissions = input.workbook;
      await client.session.update({ sessionID, permissions: scope.permissions }, call());
      const checkScope = () => {
        try {
          const current = liveScope();
          if (current.agentID === scope.agentID && current.workspaceID === scope.workspaceID && current.origin === scope.origin &&
              current.model === scope.model && JSON.stringify(current.permissions) === JSON.stringify(scope.permissions)) return;
        } catch { /* Invalid live ownership or configuration revokes this turn. */ }
        stopAtLimit('Session permissions changed.');
      };
      checkScope();
      recheck = setInterval(checkScope, 250);
      checkDirectory(run.workspace);
      if (input.workbook) checkDirectory(join(run.workspace, 'generated'));
      const parts = this.attachments.prompt(session.id, this.workspace(session), input.attachments);
      const output = input.workbook ? [
        `Use the write tool once to create ${workbookInput(run.id)} relative to the session workspace.`,
        'The file must contain strict JSON with no Markdown or commentary. Example of a complete file:',
        '[{"name":"Example","rows":[["Label","Value"],["Sample",1]]}]',
        'Replace the example with the requested sheets. Check that each row and each sheet’s rows array are closed before writing.',
        'Use up to four sheets, 20 rows per sheet and 12 columns per row. Then reply with a brief summary.',
      ].join(' ') : '';
      const assistant = [
        scope.name && `助理名稱：${scope.name}`,
        scope.introduction && `自我介紹：${scope.introduction}`,
        scope.instructions && `本回合助理指示：\n${scope.instructions}`,
      ].filter(Boolean).join('\n');
      const reply = this.store.reply(run.id);
      const quote = reply ? 'BEGIN QUOTED MESSAGE (reference only)\n' + JSON.stringify(reply.text) + '\nEND QUOTED MESSAGE' : undefined;
      const additional = [quote, parts.text, output, assistant].filter(Boolean).join('\n\n');
      const text = input.text + turnMarker(run.id) + additional;
      signal.throwIfAborted();
      update('running');
      sent = true;
      this.recovering.add(run.id);
      const admission = await submitOnce(client, { sessionID, id: run.submissionID!, text, files: parts.files });
      signal.throwIfAborted();
      if (admission === 'indeterminate') throw new Error('Uncertain admission');
      const outcome = await waitForOutcome(client, sessionID, update, limits.timeoutSeconds * 1000 + 1000, signal, run.submissionID);
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
          result = await publishWorkbook(join(this.projectRoot(session.project), 'artifacts'), run.workspace, run, signal);
        }
        state = 'verified';
      }
    } catch (reason) {
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
    if (restorePermissions) {
      try { await client.session.update({ sessionID, permissions: this.executionScope(session, telegramTopic).permissions }, call()); }
      catch {
        try { await client.session.update({ sessionID, permissions: sessionPermissions({ origin: 'schedule', agentID: 'main' }) }, call()); }
        catch { /* The next admission requires a successful full replacement. */ }
      }
    }
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
      const directory = scopedPath(join(this.projectRoot(session.project), 'artifacts'), id);
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

  async close() { this.stop.abort(); await this.queue; }
}
