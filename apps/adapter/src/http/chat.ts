import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRecord, RunState } from '../../../../packages/contracts/src/run.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { call } from '../opencode/client.ts';
import { submissionCount, waitForOutcome } from '../opencode/reconcile.ts';
import { createSession, promptID, submitOnce } from '../opencode/sessions.ts';
import type { Agent } from '../opencode/sessions.ts';
import { AttachmentService, publicAttachment } from '../runs/attachments.ts';
import { openWorkspaceFile, checkDirectory, scopedPath } from '../runs/workspace.ts';
import type { WebSession, WebStore } from '../runs/web-store.ts';
import { publishWorkbook, workbookInput, workbookLimit, workbookName } from '../runs/web-workbook.ts';
import { HttpError } from './errors.ts';

export type Turn = { id: string; text: string; attachments: string[]; workbook: boolean };
const active = new Set<RunState>(['accepted', 'running', 'awaiting_permission', 'background']);
const separator = (id: string) => `\n\n[OEP attachment and output instructions for ${id}]\n`;

export function publicRun(run: RunRecord) {
  return { id: run.id, state: run.state, createdAt: run.createdAt, error: run.errors.at(-1),
    artifact: run.state === 'verified' && run.artifact
      ? { name: workbookName, bytes: run.artifact.bytes, sha256: run.artifact.sha256 } : undefined };
}

export function publicSession({ id, agent, alias, createdAt }: WebSession) { return { id, agent, alias, createdAt }; }

type RuntimeConnection = Pick<Runtime, 'client' | 'alias' | 'gatewayCursor' | 'gatewaySince' | 'redact'>;

export class ChatService {
  readonly attachments: AttachmentService;
  private readonly store: WebStore;
  private readonly runtime: RuntimeConnection;
  private readonly root: string;
  private readonly audit: string;
  private readonly notify: (sessionID: string) => void;
  private readonly stop = new AbortController();
  private readonly recovering = new Set<string>();
  private queue = Promise.resolve();

  constructor(store: WebStore, runtime: RuntimeConnection, root: string, audit: string, notify: (sessionID: string) => void) {
    this.store = store;
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

  workspace(session: Pick<WebSession, 'id'>) { return scopedPath(join(this.root, 'sessions'), session.id); }

  async create(agent: Agent) {
    const id = randomUUID();
    const createdAt = Date.now();
    const local = { id, agent, alias: this.runtime.alias, createdAt };
    const workspace = this.workspace(local);
    checkDirectory(join(this.root, 'sessions'));
    mkdirSync(workspace);
    mkdirSync(join(workspace, 'attachments'));
    mkdirSync(join(workspace, 'generated'));
    const upstreamID = await createSession(this.runtime.client, workspace, agent, this.runtime.alias, true);
    const session = { ...local, upstreamID };
    this.store.createSession(session);
    return session;
  }

  async state(session: WebSession) {
    const { client } = this.runtime;
    const { upstreamID: sessionID } = session;
    let runs = this.store.turns(session.id);
    const latest = runs.at(-1);
    let stateError: string | undefined;
    let messages: { id: string; role: 'user' | 'assistant'; text: string }[] | undefined;
    try {
      const pending = latest && (active.has(latest.state) || latest.state === 'indeterminate');
      const [{ data }, inbox, permissions, status] = await Promise.all([
        client.message.list({ sessionID, order: 'desc', limit: 100 }, call()),
        pending ? client.session.inbox.list({ sessionID }, call()) : [],
        pending ? client.permission.list({ sessionID }, call()) : [],
        pending ? client.session.active(call()) : undefined,
      ]);
      const runByMessage = new Map(runs.map((run) => [run.submissionID, run.id]));
      messages = data.reverse().flatMap((message): NonNullable<typeof messages> => {
        if (message.type === 'user') {
          const runID = runByMessage.get(message.id);
          const text = runID ? message.text.split(separator(runID))[0] : message.text;
          return [{ id: message.id, role: 'user', text: this.runtime.redact(text) }];
        }
        if (message.type !== 'assistant') return [];
        const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        return text.trim() ? [{ id: message.id, role: 'assistant', text: this.runtime.redact(text) }] : [];
      });
      if (latest?.state === 'indeterminate' && !status?.[sessionID] && !inbox.length && !permissions.length &&
          !this.recovering.has(latest.id)) {
        const current = this.store.get(latest.id);
        if (current.state === 'indeterminate') this.store.change(latest.id, 'failed', { finishedAt: Date.now() });
      }
    } catch {
      stateError = 'OpenCode is temporarily unavailable. Saved runs and attachments are still available';
    }
    runs = this.store.turns(session.id);
    return { session: publicSession(session), messages, stateError, runs: runs.map(publicRun),
      attachments: this.store.attachments(session.id).map(publicAttachment) };
  }

  submit(session: WebSession, input: Turn) {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.store.turn(session.id, input.id);
    if (existing) {
      if (existing.hash !== hash) throw new HttpError(409, 'Message ID was already used for different content');
      return publicRun(existing.run);
    }
    if (this.store.hasTurn(input.id)) throw new HttpError(409, 'Message ID is unavailable');
    const prior = this.store.turns(session.id).at(-1);
    if (prior && (active.has(prior.state) || prior.state === 'indeterminate')) throw new HttpError(409, 'A turn in this session is still pending');
    if (session.alias !== this.runtime.alias) throw new HttpError(409, 'This session uses a different model. Create a session for the current model');
    if (input.workbook && session.agent !== 'workbook') throw new HttpError(400, 'Select the workbook agent to generate a workbook');
    for (const id of input.attachments) {
      if (!this.store.attachment(session.id, id)) throw new HttpError(404, 'Attachment not found in this session');
    }
    const run: RunRecord = { id: input.id, mode: input.workbook ? 'web-workbook' : 'web-chat', state: 'accepted',
      createdAt: Date.now(), workspace: this.workspace(session), alias: session.alias, sessionID: session.upstreamID,
      submissionID: promptID(), retries: 0, errors: [] };
    this.store.saveTurn(session.id, run, hash);
    this.notify(session.id);
    this.queue = this.queue.then(() => this.execute(session, run, input)).catch(() => {
      console.error('OEP failed to record a web turn');
    });
    return publicRun(run);
  }

  private async execute(session: WebSession, run: RunRecord, input: Turn) {
    const { client } = this.runtime;
    const { upstreamID: sessionID } = session;
    const cursor = this.runtime.gatewayCursor();
    let state: 'verified' | 'failed' | 'indeterminate' = 'failed';
    let error: string | undefined;
    let sent = false;
    let result: Partial<RunRecord> = {};
    const update = (state: RunState) => { this.store.change(run.id, state); this.notify(session.id); };
    try {
      this.stop.signal.throwIfAborted();
      checkDirectory(run.workspace);
      if (input.workbook) checkDirectory(join(run.workspace, 'generated'));
      const parts = this.attachments.prompt(session.id, run.workspace, input.attachments);
      if (session.agent === 'workbook') {
        await client.session.update({ sessionID, permissions: input.workbook ?
          [{ action: 'edit', resource: workbookInput(run.id), effect: 'allow' }] : [] }, call());
      }
      const output = input.workbook ? [
        `Use the write tool once to create ${workbookInput(run.id)} relative to the session workspace.`,
        'Write a strict JSON array of sheets, each with a name string and rows as arrays of strings, numbers, or booleans.',
        'Use up to four sheets, 20 rows per sheet and 12 columns per row. Then reply with a brief summary.',
      ].join(' ') : '';
      const additional = [parts.text, output].filter(Boolean).join('\n\n');
      const text = additional ? input.text + separator(run.id) + additional : input.text;
      update('running');
      sent = true;
      this.recovering.add(run.id);
      const admission = await submitOnce(client, { sessionID, id: run.submissionID!, text, files: parts.files });
      if (admission === 'indeterminate') throw new Error('Uncertain admission');
      const outcome = await waitForOutcome(client, sessionID, update, 105_000, this.stop.signal, run.submissionID);
      const count = await submissionCount(client, sessionID, run.submissionID!);
      if (count.inbox !== 0 || count.messages !== 1) throw new Error('Unexpected durable submission count');
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
        if (input.workbook) {
          update('background');
          result = await publishWorkbook(join(this.root, 'artifacts'), run.workspace, run);
        }
        state = 'verified';
      }
    } catch (reason) {
      if (sent) {
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
    if (input.workbook) {
      try { await client.session.update({ sessionID, permissions: [] }, call()); }
      catch { /* Every subsequent workbook-agent turn explicitly replaces its permission set before admission. */ }
    }
    const modelCalls = this.runtime.gatewaySince(cursor);
    try {
      this.store.change(run.id, state, { ...result, finishedAt: Date.now(), errors: error ? [error] : [],
        modelRequestRange: { after: cursor, through: this.runtime.gatewayCursor() }, modelCalls });
      appendFileSync(this.audit, `${JSON.stringify({ runID: run.id, sessionID, submissionID: run.submissionID, alias: run.alias,
        state, error, elapsedMs: Date.now() - run.createdAt, modelCalls, artifact: result.artifact })}\n`);
    } finally {
      this.recovering.delete(run.id);
      this.notify(session.id);
    }
  }

  download(session: WebSession, id: string) {
    const run = this.store.turn(session.id, id)?.run;
    if (run?.state !== 'verified' || !run.artifact?.identity || run.receipt?.runID !== id) throw new HttpError(404, 'Verified artifact not found');
    try {
      const directory = scopedPath(join(this.root, 'artifacts'), id);
      const output = openWorkspaceFile(directory, workbookName, workbookLimit, run.artifact.identity);
      return { name: workbookName, data: output.data, sha256: output.identity.sha256 };
    } catch { throw new HttpError(409, 'Artifact is missing or has changed'); }
  }

  async close() { this.stop.abort(); await this.queue; }
}
