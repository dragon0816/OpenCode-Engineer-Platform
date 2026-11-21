import { createHash } from 'node:crypto';

export type Passage = { id: string; source: string; locator: string; sha256: string; text: string };
export type AskInput = { question: string; revision: string; passages: readonly Passage[] };
export type Citation = { passageID: string; source: string; locator: string; sha256: string; quote: string };
export type AskResult =
  | { state: 'verified'; revision: string; citations: Citation[] }
  | { state: 'abstain'; reason: 'no-evidence' }
  | { state: 'error'; reason: 'invalid-citation' };

export function verifyCitations(input: AskInput, proposed: readonly Citation[]): AskResult {
  if (!input.passages.length || !proposed.length) return { state: 'abstain', reason: 'no-evidence' };
  const passages = new Map(input.passages.map((passage) => [passage.id, passage]));
  const error = { state: 'error', reason: 'invalid-citation' } as const;
  if (passages.size !== input.passages.length) return error;
  const citations: Citation[] = [];
  for (const proposal of proposed) {
    const passage = passages.get(proposal.passageID);
    if (!passage || proposal.source !== passage.source || proposal.locator !== passage.locator ||
        proposal.sha256 !== passage.sha256 || createHash('sha256').update(passage.text).digest('hex') !== passage.sha256 ||
        !proposal.quote.trim() || !passage.text.includes(proposal.quote)) return error;
    citations.push({ passageID: passage.id, source: passage.source, locator: passage.locator, sha256: passage.sha256, quote: proposal.quote });
  }
  return { state: 'verified', revision: input.revision, citations };
}
