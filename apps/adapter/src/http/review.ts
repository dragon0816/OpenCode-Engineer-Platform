import { key } from '../../../../packages/knowledge/src/ingest.ts';
import type { Candidate } from '../../../../packages/knowledge/src/ingest.ts';
import type { KnowledgeStore } from '../../../../packages/knowledge/src/store.ts';

export function reviewAction(store: KnowledgeStore, input: Record<string, unknown>) {
  if (input.action === 'schema') return store.installReviewSchema(key(input.vault), input.schema, input.version, input.fields);
  const id = key(input.id);
  if (['edit', 'approve', 'reject', 'discard'].includes(String(input.action)) &&
      (typeof input.edit !== 'number' || !Number.isSafeInteger(input.edit) || input.edit < 0)) {
    throw new Error('Expected a draft version');
  }
  switch (input.action) {
    case 'stage': {
      const candidate = input.draft as Candidate;
      if (candidate.vault.kind === 'bi') {
        store.enqueueBi(id, candidate);
        store.runBi(id);
      } else store.stage(id, candidate);
      break;
    }
    case 'compare': return store.compareReview(id);
    case 'run': store.runBi(id); break;
    case 'edit': store.editReview(id, Number(input.edit), input.draft as Candidate); break;
    case 'approve': store.decideReview(id, Number(input.edit), 'approved'); break;
    case 'reject': store.decideReview(id, Number(input.edit), 'rejected'); break;
    case 'discard': store.discardWiki(id, Number(input.edit)); break;
    case 'publish': return store.publishReview(id);
    case 'rollback': store.rollbackReview(id); break;
    default: throw new Error('Unknown review action');
  }
  return { id };
}
