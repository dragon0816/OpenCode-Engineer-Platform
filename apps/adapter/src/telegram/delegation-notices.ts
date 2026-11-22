import type { WebStore } from '../runs/web-store.ts';
import type { DelegationResult } from '../runs/delegation-ledger.ts';
import type { Destination } from '../channels/transport.ts';
import { channelText } from '../channels/catalog.ts';
import type { TelegramInbox } from './inbox.ts';

export function delegationNotices(inbox: TelegramInbox, ledger: WebStore, sessions: WebStore, redact: (text: string) => string) {
  function enqueue(destination: Destination, effectKey: string, text: string) {
    const locale = ledger.channelLocale(destination.agentId);
    const safe = redact(text).replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/g, '[已遮蔽]');
    inbox.enqueueOutbound({ ...destination, effectKey, locale, text: safe });
    return inbox.hasDelivery(destination, effectKey);
  }

  function destination(saved: string) {
    return JSON.parse(saved) as Destination;
  }

  return {
    results() {
      for (const row of ledger.delegations.channelNotices()) {
        const owner = destination(row.destination);
        const work = ledger.workItems.byRun('channel', row.parentRunId);
        const intake = work?.payload.intake as { id: number; destination: Destination } | undefined;
        const original = intake?.destination;
        const [session] = sessions.sessions(false, row.parentSessionId);
        const saved = session && sessions.sessionOwner(session);
        if (!intake || !original || work?.payload.kind !== 'telegram-inbound' || owner.agentId !== 'main' ||
            original.agentId !== owner.agentId || original.accountId !== owner.accountId ||
            original.bindingRevision !== owner.bindingRevision || original.conversationKey !== owner.conversationKey ||
            saved?.origin !== 'channel' || saved.agentID !== owner.agentId || saved.channelAccount !== owner.accountId ||
            saved.bindingRevision !== owner.bindingRevision || saved.conversationKey !== owner.conversationKey ||
            !sessions.turn(row.parentSessionId, row.parentRunId)) continue;
        const locale = ledger.channelLocale(owner.agentId);
        const messages = channelText(locale);
        let text;
        if (row.kind === 'acceptance') {
          text = messages.delegationAccepted(row.specialistName, row.id);
        } else {
          // Row order in the channel outbox keeps the parent reply ahead of the result.
          if (!inbox.hasDelivery(owner, 'update-' + intake.id)) continue;
          const result = noticeResult(row);
          if (!result) continue;
          const status = result.reviewRef ? 'submitted' : result.status;
          const summary = result.reviewRef ? '' : result.summary?.slice(0, 500).toWellFormed() ?? '';
          text = messages.delegationResult(row.specialistName, row.id, messages.delegationStatuses[status], summary);
        }
        if (enqueue(owner, row.effectKey, text)) ledger.delegations.markOutboxed(row.effectKey);
      }
    },
    publications(intents: readonly { review?: unknown; sourceKey?: unknown; origin?: unknown }[]) {
      for (const intent of intents) {
        if (intent.origin !== 'owner' || typeof intent.review !== 'string' || intent.sourceKey !== intent.review) continue;
        const parent = ledger.delegations.publicationParent(intent.review);
        if (parent?.parentStore !== 'channel' || !parent.completionOutboxed) continue;
        const owner = destination(parent.destination);
        enqueue(owner, 'review-' + intent.review, channelText(ledger.channelLocale(owner.agentId)).published);
      }
    },
  };
}

function noticeResult(row: ReturnType<WebStore['delegations']['channelNotices']>[number]) {
  if (!row.result) return;
  if (row.kind === 'completion' && row.corrected) return { status: 'indeterminate' as const, summary: undefined, reviewRef: undefined };
  return JSON.parse(row.result) as DelegationResult;
}
