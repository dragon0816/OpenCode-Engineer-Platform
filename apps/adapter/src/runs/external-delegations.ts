import { randomUUID } from 'node:crypto';
import { sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import { DelegationError, type DelegationParent } from './delegation-ledger.ts';
import type { Dispatcher } from './dispatcher.ts';
import { externalProvider, type Snapshot } from './external-ledger.ts';
import type { ExternalSources } from './external-sources.ts';
import type { ExternalDelegationInput } from '../opencode/delegation-tools.ts';
import type { WebSession, WebStore } from './web-store.ts';

export class ExternalDelegations {
  private readonly store: WebStore;
  private readonly dispatcher: Dispatcher;
  private readonly sources: ExternalSources;
  private readonly notify: (id: string) => void;

  constructor(store: WebStore, dispatcher: Dispatcher, sources: ExternalSources,
    notify: (id: string) => void, synthetic?: (snapshot: Snapshot) => void) {
    this.store = store;
    this.dispatcher = dispatcher;
    this.sources = sources;
    this.notify = notify;
    const ledger = store.delegations;
    dispatcher.register('external-delegation', {
      available: () => Boolean(synthetic),
      execute: async (item, start) => {
        ledger.claim(item);
        try {
          const approval = store.external.confirmation(item.sourceKey);
          const snapshot = approval?.decision && store.external.snapshot(approval.snapshotId);
          if (!snapshot || approval.expiresAt <= Date.now()) throw new DelegationError('external-confirmation-expired');
          this.validate(snapshot);
          ledger.event(item.sourceKey, 'running', 'external-gate-passed');
          start();
          synthetic?.(snapshot);
          return { state: 'succeeded' };
        } catch (error) {
          const reason = error instanceof DelegationError ? error.code : 'external-stub-failed';
          ledger.event(item.sourceKey, 'running', reason);
          return { state: 'failed', reason };
        }
      },
      finish: (item, outcome) => {
        const done = ledger.finish(item, outcome.state, outcome.reason);
        if (done) this.changed(item.sourceKey);
        return done;
      },
      expireInTransaction: (item) => ledger.expire(item),
      expired: (item) => this.changed(item.sourceKey),
      recover: async () => ({ state: 'failed', reason: 'external-stub-stopped' }),
    });
  }

  admit(session: WebSession, runId: string, input: ExternalDelegationInput) {
    const provider = externalProvider(input.specialistId);
    const snapshot = this.store.external.snapshot(input.publicInputId);
    if (!provider || !snapshot || snapshot.provider !== provider || snapshot.sessionId !== session.id ||
        snapshot.parentRunId !== runId) throw new DelegationError('external-provenance-missing');
    const parent: DelegationParent = { store: 'web', sessionId: session.id, runId };
    const ledger = this.store.delegations;
    const external = this.store.external;
    const requestHash = sha256(JSON.stringify([provider, snapshot.digest]));
    const receipt = ledger.atomic(() => {
      const previous = ledger.replay(parent, input.requestKey, requestHash);
      if (previous) return previous;
      this.sources.revalidate(session, snapshot);
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

  private validate(snapshot: Snapshot) {
    const [session] = this.store.sessions(false, snapshot.sessionId);
    if (!session || this.store.sessionOwner(session)?.agentID !== 'main') throw new DelegationError('external-provenance-missing');
    this.sources.revalidate(session, snapshot);
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
    const inputs = manifest.inputs.map(({ name, kind, bytes, sha256, projection }) => {
      const body = content.subarray(offset, offset + bytes);
      offset += bytes + (projection?.bytes ?? 0);
      const excerpt = kind === 'citation' || kind === 'derived' || kind === 'owner_text' ? Buffer.from(body).toString('utf8') : undefined;
      return { name, kind, bytes, sha256, projection, excerpt };
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
        this.validate(snapshot);
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
