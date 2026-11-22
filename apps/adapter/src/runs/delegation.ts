import { createHash, randomUUID } from 'node:crypto';
import type { Destination } from '../channels/transport.ts';
import type { Turn } from '../http/chat.ts';
import { delegationArgs } from '../opencode/delegation-tools.ts';
import { delegateTool, listSpecialistsTool } from '../opencode/permissions.ts';
import { MiB, type AttachmentService } from './attachments.ts';
import { DelegationError } from './delegation-ledger.ts';
import type { Dispatcher } from './dispatcher.ts';
import { DelegationHandoff } from './delegation-handoff.ts';
import type { WebSession, WebStore } from './web-store.ts';

type ParentTurn = { store: WebStore; session: WebSession; input: Turn; channel?: Destination;
  attachments: AttachmentService; workspace: () => string };

export class DelegationService {
  readonly handoff: DelegationHandoff;
  readonly ledger: WebStore['delegations'];
  private readonly dispatcher: Dispatcher;

  constructor(central: WebStore, webRoot: string, dispatcher: Dispatcher) {
    this.ledger = central.delegations;
    this.dispatcher = dispatcher;
    this.handoff = new DelegationHandoff(webRoot);
    this.handoff.clean((id) => this.ledger.hasFiles(id));
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
      if (name === listSpecialistsTool && !Object.keys(args).length) return this.ledger.specialists();
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
        return this.ledger.atomic(() => this.ledger.replay(parent, args.requestKey, hash) ??
          this.ledger.admit(id, randomUUID(), parent, args, hash, manifest));
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
