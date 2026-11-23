// Ported from dragon0816/agentic-engineering-platform feature_plugins/bi_knowledge/python/aep_bi/cards/extract.py @ 861d0c0ca0813073f3944d4aff88818980beff2a, used with the rights holder's permission
import { verifyCitations } from '../../../../packages/contracts/src/evidence.ts';
import { sha256 } from '../../../../packages/knowledge/src/snapshot.ts';
import type { Chunk, Segment } from './document-worker.ts';

// Adapt the AEP extractor's evidence_not_found check to OEP's verbatim verifier.
export type CandidateIssue = 'missing-evidence' | 'invalid-quote' | 'unsupported-value' | 'unknown-field' |
  'invalid-name' | 'conflicting-value' | 'duplicate' | 'base-changed';
type Finding = { code: CandidateIssue; field?: string };
type VerifiedField = { value: string; quote: string; locator: string; segment: number; start: number };
export type DocumentCandidate = { id: string; name: string; state: 'pass' | 'needs-attention' | 'awaiting-review';
  fields: Record<string, string>; evidence: Record<string, VerifiedField>; issues: Finding[] };
type PartialCandidate = { name: string; fields: Map<string, VerifiedField>; failures: Map<string, CandidateIssue>;
  issues: Finding[] };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const cleanText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max &&
  Boolean(value.trim()) && value.isWellFormed() && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);

export function modelCandidates(content: string) {
  const result: unknown = JSON.parse(content.trim().replace(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i, '$1'));
  if (!object(result) || !Array.isArray(result.candidates) || result.candidates.length > 6 ||
      !result.candidates.every((item) => object(item) && object(item.fields))) throw new Error('Invalid extraction output');
  return result.candidates as { name?: unknown; fields: Record<string, unknown> }[];
}

export function verifyCandidate(candidate: ReturnType<typeof modelCandidates>[number], chunk: Chunk, segments: Segment[],
  fields: string[], source: string, revision: string): PartialCandidate {
  const name = cleanText(candidate.name, 300) && chunk.some(({ text }) => text.includes(candidate.name as string))
    ? candidate.name : '';
  const found: PartialCandidate = { name, fields: new Map(), failures: new Map(),
    issues: name ? [] : [{ code: 'invalid-name' }] };
  if (Object.keys(candidate.fields).some(field => !fields.includes(field))) found.issues.push({ code: 'unknown-field' });
  for (const field of fields) {
    const entry = Object.hasOwn(candidate.fields, field) ? candidate.fields[field] : undefined;
    if (!object(entry) || !cleanText(entry.quote, 1200)) {
      found.failures.set(field, 'missing-evidence');
      continue;
    }
    const part = chunk.find(({ id }) => id === entry.segment);
    const index = Number(part?.id.split('.')[0]) - 1;
    const segment = segments[index];
    const passage = segment && { id: part!.id, source, locator: segment.locator, text: segment.text, sha256: sha256(segment.text) };
    if (!part || !passage || !part.text.includes(entry.quote) ||
        verifyCitations({ question: '', revision, passages: [passage] }, [{
          passageID: passage.id, source, locator: passage.locator, sha256: passage.sha256, quote: entry.quote,
        }]).state !== 'verified') {
      found.failures.set(field, 'invalid-quote');
      continue;
    }
    if (!cleanText(entry.value, 1000) || !entry.quote.includes(entry.value)) {
      found.failures.set(field, 'unsupported-value');
      continue;
    }
    found.fields.set(field, { value: entry.value, quote: entry.quote, locator: passage.locator,
      segment: index, start: passage.text.indexOf(entry.quote) });
  }
  return found;
}

export function consolidate(partials: PartialCandidate[], identities: string[], fields: string[]): DocumentCandidate[] {
  const merged = new Map<string, PartialCandidate>();
  for (const [index, candidate] of partials.entries()) {
    const id = identities[index] || 'incomplete-' + index;
    const prior = merged.get(id);
    if (!prior) { merged.set(id, candidate); continue; }
    prior.issues.push(...candidate.issues);
    for (const [field, evidence] of candidate.fields) {
      const previous = prior.fields.get(field);
      if (!previous) prior.fields.set(field, evidence);
      else if (previous.value !== evidence.value) prior.issues.push({ code: 'conflicting-value', field });
    }
    for (const [field, code] of candidate.failures) {
      if (code !== 'missing-evidence' || !prior.failures.has(field)) prior.failures.set(field, code);
    }
  }
  return [...merged].map(([id, candidate]) => {
    const issues = [...candidate.issues];
    for (const field of fields) {
      const code = candidate.failures.get(field);
      if (!candidate.fields.has(field) || code && code !== 'missing-evidence') {
        issues.push({ code: code ?? 'missing-evidence', field });
      }
    }
    const disputed = new Set(issues.filter(({ code }) => code === 'conflicting-value').map(({ field }) => field));
    const evidence = Object.fromEntries([...candidate.fields].filter(([field]) => !disputed.has(field)));
    return { id, name: candidate.name, evidence, issues, state: issues.length ? 'needs-attention' : 'pass',
      fields: Object.fromEntries(fields.map(field => [field, Object.hasOwn(evidence, field) ? evidence[field].value : ''])) };
  });
}
