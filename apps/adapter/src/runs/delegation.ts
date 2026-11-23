import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { Destination } from '../channels/transport.ts';
import type { ChatService, DelegatedTurnLease, Turn } from '../http/chat.ts';
import type { BiService } from '../bi/service.ts';
import { delegationArgs, externalDelegationArgs } from '../opencode/delegation-tools.ts';
import { delegateTool, listSpecialistsTool } from '../opencode/permissions.ts';
import { MiB, type AttachmentService } from './attachments.ts';
import { DelegationError, type DelegationResult } from './delegation-ledger.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { WorkLease, WorkOutcome } from './work-items.ts';
import { DelegationHandoff } from './delegation-handoff.ts';
import type { WebSession, WebStore } from './web-store.ts';
import type { ExternalDelegations } from './external-delegations.ts';
import { externalProvider } from './external-ledger.ts';

type ParentTurn = { store: WebStore; session: WebSession; input: Turn; channel?: Destination;
  attachments: AttachmentService; workspace: () => string };

export class DelegationService {
  readonly handoff: DelegationHandoff;
  readonly ledger: WebStore['delegations'];
  private readonly dispatcher: Dispatcher;
  private readonly notify: (sessionID: string) => void;
  private readonly stopped = new Map<string, AbortController>();
  private external?: ExternalDelegations;

  constructor(central: WebStore, webRoot: string, dispatcher: Dispatcher, notify: (sessionID: string) => void = () => {}) {
    this.ledger = central.delegations;
    this.dispatcher = dispatcher;
    this.notify = notify;
    this.handoff = new DelegationHandoff(webRoot);
    this.handoff.clean((id) => this.ledger.hasFiles(id));
  }

  registerExternal(external: ExternalDelegations) { this.external = external; }

  registerWorker(store: WebStore, chat: ChatService, bi?: Pick<BiService, 'delegate' | 'delegationReceipt'>) {
    const landed = (item: WorkLease): Omit<DelegationResult, 'delegationId'> | undefined => {
      const row = this.ledger.get(item.sourceKey);
      if (!row?.childRunId || !row.childSessionId) return;
      const run = store.turn(row.childSessionId, row.childRunId)?.run;
      if (row.targetAgentId === 'bi' && run) {
        const receipt = bi?.delegationReceipt(row.id, run.id);
        if (receipt?.reviewId) {
          if (run.state === 'running' || run.state === 'indeterminate') store.change(run.id, 'verified', { finishedAt: Date.now() });
          return { status: 'succeeded', summary: '已送審', reviewRef: { reviewId: receipt.reviewId } };
        }
        if (receipt && run.state === 'verified') return { status: 'needs_input', reasonCode: 'bi-source-required' };
        return;
      }
      if (run?.state !== 'verified' || typeof run.delegationSummary !== 'string') return;
      const files = this.ledger.files(row.id, 'outbound').map((file) => {
        this.handoff.readExport(row.id, file);
        const { fileId, name, bytes, sha256, mime } = file;
        return { fileId, name, bytes, sha256, mime };
      });
      return { status: 'succeeded', summary: run.delegationSummary, files };
    };
    this.dispatcher.register('delegation', {
      async execute(item, start, stop) {
        start();
        return execute(item, stop);
      },
      finish: (item, result) => {
        let verified: ReturnType<typeof landed>;
        try { verified = landed(item); }
        catch { return this.changed(item.sourceKey, this.ledger.finish(item, 'indeterminate', 'export-verification-unavailable')); }
        const state = verified ? 'succeeded' : result.state === 'succeeded' ? 'indeterminate' : result.state;
        return this.changed(item.sourceKey,
          this.ledger.finish(item, state, result.reason ?? (state === 'indeterminate' ? 'child-receipt-unavailable' : undefined), verified));
      },
      expireInTransaction: (item) => this.ledger.expire(item),
      expired: (item) => this.changed(item.sourceKey, true),
      recover: async (item) => {
        if (landed(item)) return { state: 'succeeded' };
        const row = this.ledger.get(item.sourceKey);
        if (!row?.childRunId) return { state: 'failed', reason: 'child-not-submitted' };
        const run = store.get(row.childRunId);
        if (run.state === 'accepted') {
          chat.resolveTurn(item, 'failed');
          return { state: 'failed', reason: 'child-not-submitted' };
        }
        const outcome = await chat.recoverTurn(item);
        return outcome?.state === 'succeeded' ? undefined : outcome;
      },
      canResolve: async (item, outcome) => {
        if (landed(item)) return outcome === 'succeeded';
        if (outcome === 'succeeded') return false;
        const row = this.ledger.get(item.sourceKey);
        return row?.targetAgentId === 'bi' || chat.canResolveTurn(item, outcome);
      },
      resolve: (item, outcome) => this.changed(item.sourceKey, this.ledger.resolve(item, outcome, landed(item))),
      resolved: (item, outcome) => chat.resolveTurn(item, outcome),
    });
    const execute = async (item: WorkLease, stop: AbortSignal): Promise<{ state: WorkOutcome; reason?: string }> => {
      const id = item.sourceKey;
      const row = this.ledger.get(id)!;
      this.ledger.claim(item);
      this.changed(id, true);
      const stopped = new AbortController();
      this.stopped.set(id, stopped);
      const limitMs = Math.min(row.reservedMs, store.turnLimits().timeoutSeconds * 1000);
      const deadline = performance.now() + limitMs;
      let reason: string | undefined;
      const abort = (code: string) => {
        reason ??= code;
        stopped.abort();
      };
      const timer = setTimeout(() => abort('execution-deadline'), limitMs);
      const signal = AbortSignal.any([stop, stopped.signal]);
      const check = () => {
        if (performance.now() >= deadline) abort('execution-deadline');
        signal.throwIfAborted();
        this.ledger.checkTarget(row.targetAgentId);
      };
      const meter = (kind: 'tools' | 'requests', cap: number) => {
        check();
        if (!this.ledger.meter(id, kind, cap)) abort(kind === 'tools' ? 'child-tool-cap' : 'child-model-cap');
        signal.throwIfAborted();
      };
      try {
        check();
        if (row.targetAgentId === 'bi' && !bi) return { state: 'failed', reason: 'bi-delegation-unavailable' };
        const workspaceID = store.defaultWorkspace(row.targetAgentId);
        if (!workspaceID || !item.runId) throw new DelegationError('DELEGATION_TARGET_UNAVAILABLE');
        const inbound = this.ledger.files(id, 'inbound');
        if (inbound.length > 4 || inbound.reduce((n, file) => n + file.bytes + (file.projection?.bytes ?? 0), 0) > 40 * MiB) {
          throw new DelegationError('DELEGATION_ATTACHMENT_LIMIT');
        }
        const session = await chat.create('inspector', 'default', undefined, undefined,
          { agentId: row.targetAgentId, workspaceID, origin: 'delegation' });
        this.ledger.bindChild(id, session.id);
        const normalizePath = (text: string) => text.toLowerCase().replaceAll('\\', '/');
        const privateRoot = normalizePath(dirname(dirname(chat.workspace(session))));
        const toolCap = Math.min(row.reservedTools, store.turnLimits().toolCalls);
        const classification = this.ledger.workspaceClassification(workspaceID) === 'confidential' ||
          inbound.some((file) => file.classification === 'confidential') ||
          store.executionKnowledgeReads(row.targetAgentId, workspaceID).length ? 'confidential' : 'unclassified';
        const context: DelegatedTurnLease = {
          id: item.id, start: check, signal, delegation: {
            id, toolCap, beforeTool: () => meter('tools', toolCap), beforeRequest: () => meter('requests', row.reservedRequests),
            result: (files) => {
              check();
              if (files.some(({ data }) => normalizePath(data.toString('utf8')).includes(privateRoot))) {
                throw new DelegationError('DELEGATION_EXPORT_PRIVATE_PATH');
              }
              const exports = this.handoff.export(id, files, classification);
              check();
              this.ledger.prepareExports(id, exports);
            },
          },
        };
        const sources = inbound.map((file) => { check(); return { file, ...this.handoff.read(id, file) }; });
        check();
        const input: Turn = { id: item.runId, text: String(item.payload.task), attachments: [], workbook: false };
        if (row.targetAgentId === 'bi' && bi) {
          chat.acceptDelegatedDomainRun(session, input, context);
          store.change(input.id, 'running');
          const receipt = await bi.delegate({ id, runId: input.id, workId: item.id, model: session.alias, task: input.text,
            files: sources.map(({ file, data }) => ({ name: file.name, data })) }, signal, context.delegation.beforeRequest);
          if (receipt?.reviewId || !signal.aborted && receipt) {
            store.change(input.id, 'verified', { finishedAt: Date.now() });
            return { state: 'succeeded' };
          }
          store.change(input.id, signal.aborted ? 'cancelled' : 'failed', { finishedAt: Date.now() });
          if (!signal.aborted) return { state: 'failed', reason: 'bi-proposal-unavailable' };
        } else {
          input.attachments = sources.map(({ file, data, projection }) => {
            check();
            const attachmentId = chat.attachments.importVerified(session.id, chat.workspace(session),
              { name: file.name, mime: file.mime }, data, projection);
            this.ledger.classifyImport(workspaceID, attachmentId, file.sha256, file.classification);
            return attachmentId;
          });
          check();
          const run = await chat.submit(session, input, undefined, undefined, context);
          if (run.state === 'verified') return { state: 'succeeded' };
          if (run.state === 'indeterminate') return { state: 'indeterminate', reason: 'child-outcome-unknown' };
          if (!signal.aborted) return { state: 'failed', reason: run.state === 'cancelled' ? 'child-tool-or-turn-limit' : 'child-failed' };
        }
      } catch (error) {
        const childState = chat.workRunState(item);
        if (childState && childState !== 'accepted' && childState !== 'failed' && childState !== 'cancelled') {
          return { state: 'indeterminate', reason: 'child-outcome-unknown' };
        }
        if (childState === 'accepted') chat.resolveTurn(item, 'cancelled');
        if (!signal.aborted) return { state: 'failed', reason: error instanceof DelegationError ? error.code : 'child-execution-unavailable' };
      } finally {
        clearTimeout(timer);
        this.stopped.delete(id);
      }
      if (reason === 'execution-deadline') return { state: 'timed_out', reason };
      if (reason) return { state: 'failed', reason };
      return { state: 'cancelled', reason: stop.aborted ? 'service-stopping' : 'cancelled-by-owner' };
    };
  }

  async cancel(id: string) {
    const row = this.ledger.cancel(id);
    if (!row) return;
    this.changed(id, true);
    const active = this.stopped.get(id);
    if (active) {
      active.abort();
      await this.dispatcher.wait(row.workId);
    }
    return this.ledger.inspect(id);
  }

  private changed(id: string, committed: boolean) {
    if (committed) {
      const row = this.ledger.get(id);
      if (row?.parentStore === 'web') this.notify(row.parentSessionId);
    }
    return committed;
  }

  exportFile(id: string, fileId: string) {
    if (this.ledger.get(id)?.status !== 'succeeded') return;
    const file = this.ledger.files(id, 'outbound').find((item) => item.fileId === fileId);
    if (file) return { name: file.name, mime: file.mime, sha256: file.sha256, data: this.handoff.readExport(id, file) };
  }

  allows(id: string, store: WebStore['runStore']) {
    const work = this.dispatcher.items.byRun(store, id);
    return work?.state === 'running' && work.source === 'direct' && work.agentId === 'main';
  }

  invoke(name: string, args: Record<string, unknown>, turn: ParentTurn, signal: AbortSignal) {
    if (name !== listSpecialistsTool && name !== delegateTool) return;
    try {
      signal.throwIfAborted();
      const { store, session, input, channel } = turn;
      const owner = store.sessionOwner(session);
      const run = store.turn(session.id, input.id);
      if (!owner || owner.agentID !== 'main' || !this.ledger.activeOrchestrator() ||
          owner.origin !== (channel ? 'channel' : 'web') || store.runStore !== (channel ? 'channel' : 'web') ||
          channel && (owner.channelAccount !== channel.accountId || owner.conversationKey !== channel.conversationKey ||
            owner.bindingRevision !== channel.bindingRevision || channel.agentId !== owner.agentID) ||
          run?.run.sessionID !== session.upstreamID || run.run.state !== 'running' ||
          run.hash !== this.requestHash(input) || !this.allows(input.id, store.runStore)) {
        throw new DelegationError('DELEGATION_FORBIDDEN');
      }
      const external = channel ? undefined : this.external;
      if (name === listSpecialistsTool && !Object.keys(args).length) {
        return this.ledger.specialists(Boolean(external)).flatMap<Record<string, unknown>>((item) => {
          const provider = externalProvider(item.id);
          if (!provider) return [item];
          return external && store.external.settings(provider).enabled && store.external.workspace(String(item.id)) === 'public'
            ? [{ ...item, external: true, provider }] : [];
        });
      }
      if (name === delegateTool && externalProvider(args.specialistId)) {
        if (!external || !externalDelegationArgs(args)) throw new DelegationError('DELEGATION_ARGUMENTS_INVALID');
        return external.admit(session, input.id, args);
      }
      if (name !== delegateTool || !delegationArgs(args)) throw new DelegationError('DELEGATION_ARGUMENTS_INVALID');
      const refs = args.attachmentIds ?? [];
      if (refs.some((id) => !input.attachments.includes(id))) throw new DelegationError('DELEGATION_ATTACHMENT_UNAVAILABLE');
      const parent = { store: store.runStore, runId: input.id, sessionId: session.id, channel };
      let bytes = 0;
      const files = [];
      if (refs.length) {
        for (const { record, data, projection } of turn.attachments.verifiedSelection(session.id, turn.workspace(), refs)) {
          bytes += data.length + (projection?.length ?? 0);
          if (bytes > 40 * MiB) throw new DelegationError('DELEGATION_ATTACHMENT_LIMIT');
          files.push({ record, data, projection, classification:
            this.ledger.attachmentClassification(owner.workspaceID, record.id, record.original.sha256) });
        }
      }
      const hashes = files.map(({ record }) => [record.original.sha256, record.projection?.sha256 ?? '']);
      const hash = this.requestHash([args.specialistId, args.task, hashes.sort()]);
      const prior = this.ledger.atomic(() => this.ledger.replay(parent, args.requestKey, hash));
      if (prior) return prior;
      this.ledger.checkTarget(args.specialistId);
      this.ledger.checkBudget(parent);
      const id = randomUUID();
      try {
        const manifest = this.handoff.stage(id, files);
        signal.throwIfAborted();
        const receipt = this.ledger.atomic(() => this.ledger.replay(parent, args.requestKey, hash) ??
          this.ledger.admit(id, randomUUID(), parent, args, hash, manifest));
        this.changed(receipt.delegationId, true);
        return receipt;
      } finally {
        if (files.length && !this.ledger.hasFiles(id)) this.handoff.discard(id);
        this.dispatcher.kick();
      }
    } catch (error) {
      if (error instanceof DelegationError) return { errorCode: error.code };
      return { errorCode: 'DELEGATION_HANDOFF_UNAVAILABLE' };
    }
  }

  private requestHash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
