import { randomUUID } from 'node:crypto';
import { sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import { DelegationError, type DelegationFile, type DelegationParent, type DelegationResult } from './delegation-ledger.ts';
import type { Dispatcher } from './dispatcher.ts';
import { helperReady, unavailableHelper, type HelperAuthAction, type HelperStatus } from './external-cli.ts';
import { ExternalExecutionUnknown, type ExternalExecutor } from './external-executor.ts';
import { externalProvider, type Provider, type Snapshot } from './external-ledger.ts';
import type { ExternalSources } from './external-sources.ts';
import type { ExternalDelegationInput } from '../opencode/delegation-tools.ts';
import type { DelegationInput } from '../opencode/delegation-tools.ts';
import type { WebSession, WebStore } from './web-store.ts';
import type { WorkOutcome } from './work-items.ts';

export type ExternalWorkerOptions = {
  executor?: ExternalExecutor;
  synthetic?: (snapshot: Snapshot) => void;
  intakeFixture?: (provider: Provider) => HelperStatus;
};

export class ExternalDelegations {
  private readonly store: WebStore;
  private readonly dispatcher: Dispatcher;
  private readonly sources: ExternalSources;
  private readonly notify: (id: string) => void;
  private readonly options: ExternalWorkerOptions;
  private readonly active = new Map<string, { stop: AbortController; checkPolicy: () => void }>();

  constructor(store: WebStore, dispatcher: Dispatcher, sources: ExternalSources,
    notify: (id: string) => void, options: ExternalWorkerOptions = {},
    exportChanges?: (id: string, directory: string, digest: string) => DelegationFile[], redact = (text: string) => text) {
    this.store = store;
    this.dispatcher = dispatcher;
    this.sources = sources;
    this.notify = notify;
    this.options = options;
    const ledger = store.delegations;
    const landed = new Map<string, Omit<DelegationResult, 'delegationId'>>();
    dispatcher.register('external-delegation', {
      available: () => Boolean(options.executor || options.synthetic),
      recoverBeforeStart: true,
      execute: async (item, start, shutdown): Promise<{ state: WorkOutcome; reason?: string }> => {
        const id = item.sourceKey;
        const row = ledger.get(id)!;
        const limits = store.turnLimits();
        const duration = Math.min(row.reservedMs, limits.timeoutSeconds * 1000);
        const deadline = performance.now() + duration;
        const stopped = new AbortController();
        const signal = AbortSignal.any([stopped.signal, shutdown]);
        const timer = setTimeout(() => stopped.abort('execution-deadline'), duration);
        const check = () => {
          if (performance.now() >= deadline) stopped.abort('execution-deadline');
          signal.throwIfAborted();
        };
        let watch: NodeJS.Timeout | undefined;
        try {
          ledger.claim(item);
          this.changed(id);
          const approval = store.external.confirmation(id);
          const snapshot = approval?.decision && store.external.snapshot(approval.snapshotId);
          if (!snapshot || approval.expiresAt <= Date.now()) throw new DelegationError('external-confirmation-expired');
          const validate = () => {
            if ((externalProvider(row.targetAgentId) ?? store.agentModelSource(row.targetAgentId)) !== snapshot.provider ||
                row.parentRunId !== snapshot.parentRunId ||
                row.parentSessionId !== snapshot.sessionId) throw new DelegationError('external-provenance-missing');
            ledger.checkTarget(row.targetAgentId, true);
            this.validate(snapshot, row.targetAgentId);
          };
          check();
          validate();
          if (Math.min(limits.toolCalls, row.reservedTools, row.reservedRequests) < 1 || !item.runId) {
            throw new DelegationError('external-budget-unavailable');
          }
          const checkPolicy = () => {
            try { validate(); }
            catch (error) { stopped.abort(error instanceof DelegationError ? error.code : 'external-changed'); }
          };
          this.active.set(id, { stop: stopped, checkPolicy });
          if (!options.executor) {
            ledger.event(id, 'running', 'external-gate-passed');
            start();
            options.synthetic?.(snapshot);
            return { state: 'succeeded' };
          }
          const result = await options.executor.execute(snapshot, item.runId, Math.min(limits.toolCalls, row.reservedRequests),
            signal, check, (version) => {
              ledger.atomic(() => {
                validate();
                check();
                start();
                ledger.chargeExternal(id);
                ledger.event(id, 'running', 'external-gate-passed', {
                  version, settingsRevision: snapshot.settingsRevision, sourceCount: 1 + snapshot.manifest.inputs.length,
                });
              });
              watch = setInterval(checkPolicy, 1000);
            }, (reason, members) => {
              ledger.event(id, 'running', reason, members === undefined ? undefined : { members, orphans: 0 });
            }, validate);
          const files = exportChanges?.(id, result.copyDirectory, result.changes.manifestSha256);
          landed.set(id, { status: 'succeeded', summary: redact(result.reply).slice(0, 4000).toWellFormed() || result.summary,
            changes: result.changes, files });
          return { state: 'succeeded' };
        } catch (error) {
          if (error instanceof ExternalExecutionUnknown) return { state: 'indeterminate', reason: 'external-stop-unverified' };
          const reason = shutdown.aborted ? 'service-stopping' : stopped.signal.aborted ? String(stopped.signal.reason) :
            error instanceof DelegationError ? error.code : 'external-cli-failed';
          ledger.event(id, 'running', reason);
          return { state: reason === 'execution-deadline' ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed', reason };
        } finally {
          this.active.delete(id);
          clearTimeout(timer);
          clearInterval(watch);
        }
      },
      finish: (item, outcome) => {
        const result = landed.get(item.sourceKey);
        landed.delete(item.sourceKey);
        const done = ledger.finish(item, outcome.state, outcome.reason, result);
        if (done) this.changed(item.sourceKey);
        return done;
      },
      expireInTransaction: (item) => ledger.expire(item),
      expired: (item) => this.changed(item.sourceKey),
      recover: async (item) => {
        const row = ledger.get(item.sourceKey);
        if (row?.status === 'queued' || ledger.inspect(item.sourceKey)?.events.some(({ reasonCode }) => reasonCode === 'external-copy-discarded')) {
          return { state: 'failed', reason: 'external-interrupted' };
        }
        return { state: 'indeterminate', reason: 'external-stop-unverified' };
      },
      canResolve: async () => false,
      resolve: (item, outcome) => ledger.resolve(item, outcome),
    });
  }

  status(provider: Provider) {
    return this.options.intakeFixture?.(provider) ?? this.options.executor?.status(provider) ?? unavailableHelper;
  }

  requiresReady(provider: Provider) {
    if (this.options.synthetic) return;
    this.requiresInstalled(provider);
    if (!helperReady(this.status(provider))) throw new DelegationError('external-cli-login-unavailable');
  }

  async executeTurn(snapshot: Snapshot, runId: string, turns: number, signal: AbortSignal, check: () => void,
    start: () => void, validate: () => void) {
    this.requiresReady(snapshot.provider);
    if (!this.options.executor) throw new DelegationError('external-model-execution-unavailable');
    return this.options.executor.execute(snapshot, runId, turns, signal, check, start, () => {}, validate);
  }

  requiresInstalled(provider: Provider) {
    const status = this.status(provider);
    if (status.isolation !== 'verified') throw new DelegationError('external-isolation-unavailable');
    if (status.installation !== 'detected') throw new DelegationError('external-cli-unsupported');
  }

  async refresh(provider: Provider) {
    await this.options.executor?.refresh(provider, AbortSignal.timeout(30_000));
    return this.status(provider);
  }

  async authenticate(provider: Provider, action: HelperAuthAction, signal: AbortSignal) {
    if (provider === 'claude_code' && action.action !== 'logout' && !this.store.external.settings(provider).termsConfirmed) {
      throw new DelegationError('external-terms-required');
    }
    if (!this.options.executor) throw new DelegationError('external-isolation-unavailable');
    return this.options.executor.authenticate(provider, action, signal);
  }

  recheckActive() {
    for (const { checkPolicy } of this.active.values()) checkPolicy();
  }

  cancel(id: string) {
    const active = this.active.get(id);
    active?.stop.abort('cancelled-by-owner');
    return Boolean(active);
  }

  admit(session: WebSession, runId: string, input: ExternalDelegationInput) {
    const provider = externalProvider(input.specialistId);
    const snapshot = this.store.external.snapshot(input.publicInputId);
    if (!provider || !snapshot || snapshot.provider !== provider || snapshot.sessionId !== session.id ||
        snapshot.parentRunId !== runId) throw new DelegationError('external-provenance-missing');
    return this.admitSnapshot(session, { ...input, task: '' }, snapshot);
  }

  admitTurn(session: WebSession, runId: string, provider: Provider, input: DelegationInput) {
    this.requiresReady(provider);
    const target = externalProvider(input.specialistId) ? undefined : input.specialistId;
    const snapshot = this.sources.createForDelegation(session, runId, provider, input.task, input.attachmentIds ?? [], target);
    return this.admitSnapshot(session, input, snapshot);
  }

  private admitSnapshot(session: WebSession, input: DelegationInput, snapshot: Snapshot) {
    const { provider, parentRunId: runId } = snapshot;
    const parent: DelegationParent = { store: 'web', sessionId: session.id, runId };
    const ledger = this.store.delegations;
    const external = this.store.external;
    const requestHash = sha256(JSON.stringify([provider, snapshot.digest]));
    const receipt = ledger.atomic(() => {
      const previous = ledger.replay(parent, input.requestKey, requestHash);
      if (previous) return previous;
      this.requiresReady(provider);
      this.sources.revalidate(session, snapshot, externalProvider(input.specialistId) ? undefined : input.specialistId);
      const settings = external.settings(provider);
      const id = randomUUID();
      const result = ledger.admit(id, randomUUID(), parent, { ...input, task: '' }, requestHash, [], { wait: settings.confirmEachRun });
      const work = this.store.workItems.get(ledger.get(id)!.workId)!;
      external.addConfirmation(id, snapshot.id, work.expiresAt!, settings.confirmEachRun, work.enqueuedAt);
      ledger.event(id, 'queued', 'external-gate-passed');
      ledger.event(id, 'queued', settings.confirmEachRun ? 'external-confirmation-required' : 'external-owner-selection');
      return result;
    });
    this.changed(receipt.delegationId);
    this.dispatcher.kick();
    const waiting = receipt.status === 'queued' && this.pending(receipt.delegationId);
    return waiting ? { ...receipt, status: 'awaiting_confirmation' } : receipt;
  }

  private validate(snapshot: Snapshot, targetAgent: string) {
    const [session] = this.store.sessions(false, snapshot.sessionId);
    if (!session || this.store.sessionOwner(session)?.agentID !== 'main') throw new DelegationError('external-provenance-missing');
    this.sources.revalidate(session, snapshot, externalProvider(targetAgent) ? undefined : targetAgent);
  }

  pending(id: string) {
    return this.store.external.confirmation(id)?.decision === null;
  }

  ownerDetails(id: string) {
    const approval = this.store.external.confirmation(id);
    if (!approval) return;
    const snapshot = this.store.external.snapshot(approval.snapshotId);
    if (!snapshot) return;
    const { provider, parentRunId, digest, settingsRevision, manifest, content } = snapshot;
    const task = Buffer.from(content.subarray(0, manifest.task.bytes)).toString('utf8');
    let offset = manifest.task.bytes;
    const inputs = manifest.inputs.map(({ name, displayName, kind, bytes, sha256, projection }) => {
      const body = content.subarray(offset, offset + bytes);
      offset += bytes + (projection?.bytes ?? 0);
      const excerpt = kind === 'citation' || kind === 'derived' || kind === 'owner_text' ? Buffer.from(body).toString('utf8') : undefined;
      return { name: displayName ?? name, kind, bytes, sha256, projection, excerpt };
    });
    return { provider, parentRunId, digest, settingsRevision, task, inputs, bytes: content.length,
      expiresAt: approval.expiresAt, challenge: approval.challenge, decision: approval.decision, decidedAt: approval.decidedAt };
  }

  confirm(id: string, input: Record<string, unknown>, now = Date.now()) {
    const ledger = this.store.delegations;
    const external = this.store.external;
    try {
      ledger.atomic(() => {
        const approval = external.confirmation(id);
        const row = ledger.get(id);
        const snapshot = approval && external.snapshot(approval.snapshotId);
        if (!row || !approval || !snapshot) throw new DelegationError('external-provenance-missing');
        if (approval.decision) throw new DelegationError('external-confirmation-replayed');
        if (approval.expiresAt <= now) throw new DelegationError('external-confirmation-expired');
        if (row.status !== 'queued' || Object.keys(input).length !== 5 || input.challenge !== approval.challenge ||
            input.provider !== snapshot.provider || input.parentRunId !== snapshot.parentRunId ||
            input.digest !== snapshot.digest || input.settingsRevision !== snapshot.settingsRevision) {
          throw new DelegationError('external-confirmation-invalid');
        }
        this.requiresReady(snapshot.provider);
        this.validate(snapshot, row.targetAgentId);
        if (!external.confirm(id, now) || !this.store.workItems.makeReady(row.workId, now)) {
          throw new DelegationError('external-confirmation-expired');
        }
        ledger.event(id, 'queued', 'external-owner-confirmed');
      });
    } catch (error) {
      if (error instanceof DelegationError && this.pending(id) && error.code !== 'external-confirmation-invalid') {
        ledger.event(id, 'queued', error.code);
      }
      throw error;
    }
    this.changed(id);
    this.dispatcher.kick();
    return { status: 'queued' };
  }

  private changed(id: string) {
    const row = this.store.delegations.get(id);
    if (row) this.notify(row.parentSessionId);
  }
}
