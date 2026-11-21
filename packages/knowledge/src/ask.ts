import { verifyCitations } from '../../contracts/src/evidence.ts';
import type { AskInput } from '../../contracts/src/evidence.ts';
import { searchTerms } from './retrieval.ts';
import { identifier } from './snapshot.ts';
import type { Evidence, KnowledgeStore } from './store.ts';

export type AskRequest = { vault: string; question: string };
export type ModelResult = { content: string } | { failure: 'unavailable' | 'empty'; retryable: boolean } |
  { failure: 'gateway-rejected'; retryable: false };
export type KnowledgeModel = (question: string, evidence: readonly Evidence[], signal: AbortSignal) => Promise<ModelResult>;
export type Attempt = 'answered' | 'abstained' | 'invalid-citation' | 'empty' | 'unavailable' | 'gateway-rejected';

export function parseAsk(value: unknown): AskRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return;
  const { vault, question } = value as Partial<AskRequest>;
  if (typeof vault !== 'string' || !identifier.test(vault) ||
      typeof question !== 'string' || !question.trim() || question.length > 500 || !question.isWellFormed()) return;
  return { vault, question: question.trim() };
}

function proposed(input: AskInput, content: string) {
  let value: unknown;
  try { value = JSON.parse(content.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, '$1')); }
  catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { state, citations } = value as { state?: unknown; citations?: unknown };
  if (state === 'abstain' && Object.keys(value).length === 1) return { state } as const;
  if (state !== 'answer' || Object.keys(value).length !== 2 || !Array.isArray(citations) || !citations.length || citations.length > 3) return;
  const evidence = new Map(input.passages.map((passage) => [passage.id, passage]));
  const expanded = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation) || Object.keys(citation).length !== 2) return;
    const { passageID, quote } = citation as { passageID?: unknown; quote?: unknown };
    if (typeof passageID !== 'string' || typeof quote !== 'string' || quote.length > 800 || seen.has(passageID)) return;
    const passage = evidence.get(passageID);
    if (!passage || !supportsQuote(input.question, passage.text)) return;
    expanded.push({ passageID, quote, source: passage.source, locator: passage.locator, sha256: passage.sha256 });
    seen.add(passageID);
  }
  const result = verifyCitations(input, expanded);
  if (result.state === 'verified') return { state: 'verified', citations: result.citations } as const;
}

function supportsQuote(question: string, passage: string) {
  if (/(?:ignore|disregard|override)\b.{0,100}\b(?:instructions?|citations?|evidence|rules?)\b|(?:忽略|無視|略過|覆蓋).{0,48}(?:指令|引用|核對|規則|證據)/isu.test(passage)) return false;
  const query = searchTerms(question);
  const evidence = searchTerms(passage);
  if (query.parts.length && !query.parts.some((part) => evidence.parts.includes(part))) return false;
  if (/\p{Script=Han}/u.test(question)) {
    const technicalWords = query.words.filter((word) => /^[a-z]{2,}$/.test(word));
    if (technicalWords.length && !technicalWords.some((word) => evidence.words.includes(word))) return false;
  }
  return true;
}

export class KnowledgeAsk {
  private inFlight = 0;
  private store: KnowledgeStore;
  private model: KnowledgeModel;

  constructor(store: KnowledgeStore, model: KnowledgeModel) {
    this.store = store;
    this.model = model;
  }

  async ask(request: AskRequest, signal: AbortSignal, onAttempt?: (status: Attempt) => void) {
    const { vault, question } = request;
    const found = this.store.retrieve(vault, question);
    if (!found) return { state: 'abstain', reason: 'vault-unavailable' } as const;
    const { revision, hash, passages } = found;
    const scope = { vault, revision, snapshotHash: hash };
    if (!passages.length) return { state: 'abstain', reason: 'no-evidence', ...scope } as const;
    if (!found.allowModel) return { state: 'abstain', reason: 'model-disabled', ...scope } as const;
    if (this.inFlight >= 2) return { state: 'error', reason: 'busy', ...scope } as const;
    this.inFlight++;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted || !this.store.isCurrent(vault, revision, hash)) {
          return { state: 'error', reason: 'evidence-changed-or-cancelled', ...scope } as const;
        }
        const result = await this.model(question, passages, signal);
        if ('failure' in result) {
          onAttempt?.(result.failure);
          if (!signal.aborted && result.retryable && attempt === 0) continue;
          return { state: 'error', reason: result.failure, ...scope } as const;
        }
        const verified = proposed({ question, revision, passages }, result.content);
        onAttempt?.(verified?.state === 'verified' ? 'answered' : verified?.state === 'abstain' ? 'abstained' : 'invalid-citation');
        if (signal.aborted || !this.store.isCurrent(vault, revision, hash)) {
          return { state: 'error', reason: 'evidence-changed-or-cancelled', ...scope } as const;
        }
        if (verified?.state !== 'verified') {
          return { state: 'abstain', reason: verified ? 'unsupported' : 'invalid-citation', ...scope } as const;
        }
        const byID = new Map(passages.map((passage) => [passage.id, passage]));
        const citations = verified.citations.map((citation) => {
          const passage = byID.get(citation.passageID)!;
          return { ...citation, context: passage.text, sourceId: passage.sourceId,
            sourceVersion: passage.sourceVersion, sourceSha256: passage.sourceSha256, cardId: passage.cardId };
        });
        return { state: 'verified', answer: citations.map((citation) => citation.quote).join('\n'), citations, ...scope } as const;
      }
      throw new Error('Invalid retry state');
    } finally { this.inFlight--; }
  }
}
