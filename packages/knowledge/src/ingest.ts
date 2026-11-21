import { canonical, identifier, record, sha256, snapshotFormat, string, validateSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

export type Candidate = {
  vault: Snapshot['vault'];
  schema: string;
  sources: { id: string; ref: string; original: string; markdown: string }[];
  cards: Snapshot['cards'];
  relationships: Snapshot['relationships'];
  evidence: { sourceId: string; cardId?: string; field?: string; start: number; end: number }[];
  allowModel?: boolean;
};

export function key(value: unknown) {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid identifier');
  return value;
}

export function materialize(value: unknown, schema: Snapshot['schema'], revision: string, parent?: string, passagePrefix = '', sourceLimit = 100_000, evidenceOnly: ReadonlySet<string> = new Set()) {
  record(value, 'candidate');
  const input = value as Candidate;
  if (input.schema !== schema.sha256) throw new Error('Candidate schema is stale');
  if (input.allowModel !== undefined && typeof input.allowModel !== 'boolean') throw new Error('Invalid consent');
  const sources = input.sources.map(({ id, ref, original, markdown }) => {
    string(original, 'source.original', sourceLimit);
    string(markdown, 'source.markdown', sourceLimit);
    return { id, ref, version: sha256(markdown), sha256: sha256(original) };
  });
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const fields = new Map<string, Map<string, string[]>>();
  const cardsById = new Map(input.cards.map((card) => [card.id, card]));
  const passages = input.evidence.map(({ sourceId, cardId, field, start, end }, index) => {
    const source = byId.get(sourceId);
    if (!source || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end > source.markdown.length) throw new Error('Invalid evidence range');
    const id = passagePrefix + 'passage-' + index;
    const text = source.markdown.slice(start, end);
    if (input.vault.kind === 'bi') {
      const card = cardsById.get(cardId ?? '');
      if (!card || typeof field !== 'string' || !Object.hasOwn(card.fields, field)) throw new Error('Invalid field evidence');
      const byField = fields.get(card.id) ?? new Map<string, string[]>();
      fields.set(card.id, byField);
      const ids = byField.get(field) ?? [];
      ids.push(id);
      byField.set(field, ids);
    }
    return { id, sourceId, ...(cardId !== undefined && { cardId }),
      locator: 'markdown:' + start + '-' + end, text, sha256: sha256(text) };
  });
  if (!passagePrefix && !passages.length) throw new Error('Evidence is required');
  const allowed = schema.document.fields as string[];
  const cards = input.cards.map((card) => {
    const byField = fields.get(card.id);
    if (evidenceOnly.has(card.id)) {
      const provenance = { ...card.fieldProvenance };
      for (const [field, ids] of byField ?? []) {
        const old = Object.hasOwn(provenance, field) ? provenance[field] : undefined;
        Object.defineProperty(provenance, field, { enumerable: true, configurable: true, writable: true,
          value: Array.isArray(old) ? [...old, ...ids] : old === undefined ? ids : [old, ...ids] });
      }
      return { ...card, fieldProvenance: provenance };
    }
    if (!byField || allowed.some((field) => !Object.hasOwn(card.fields, field) || !byField.has(field)) ||
        Object.keys(card.fields).some((field) => !allowed.includes(field) || !byField.has(field))) {
      throw new Error('Card fields require schema-matched evidence');
    }
    return { ...card, fieldProvenance: Object.fromEntries(byField) };
  });
  if (input.vault.kind === 'bi' ? !passagePrefix && !cards.length : cards.length) throw new Error('Invalid vault content');
  return validateSnapshot({
    format: snapshotFormat, status: 'published', vault: input.vault,
    publication: { revision, publishedAt: new Date().toISOString(), publisher: 'local-owner', ...(parent && { parent }) },
    schema, sources, cards, relationships: input.relationships, passages,
  });
}

export function reviewSchema(id: unknown, version: unknown, fields: unknown): Snapshot['schema'] {
  if (!Array.isArray(fields) || fields.length > 100 || new Set(fields).size !== fields.length) throw new Error('Invalid schema fields');
  const document = { id: key(id), version: key(version), fields: fields.map(key) };
  return { id: document.id, version: document.version, document, sha256: sha256(canonical(document)) };
}
export type ChangeSet = {
  vault: Candidate['vault'];
  schema: string;
  parent: string | null;
  addCards: Candidate['cards'];
  updateCards: Candidate['cards'];
  removeCards: string[];
  sources: { id: string; ref: string; sha256: string }[];
  evidence: Candidate['evidence'];
  relationships: Candidate['relationships'];
  allowModel?: boolean;
};

export const sourceUploadLimit = 1024 * 1024;

export function materializeChange(change: ChangeSet, parent: Snapshot | undefined, schema: Snapshot['schema'],
  revision: string, readSource: (hash: string) => string) {
  if ((parent?.publication.revision ?? null) !== change.parent) throw new Error('Published base has changed');
  if (change.vault.kind !== 'bi' || (parent && parent.vault.kind !== 'bi')) throw new Error('Expected a BI vault');
  const existing = new Map(parent?.cards.map((card) => [card.id, card]));
  const replaced = new Set<string>();
  for (const id of [...change.removeCards, ...change.updateCards.map((card) => card.id)]) {
    if (!existing.has(id) || replaced.has(id)) throw new Error('Unknown or repeated card change');
    replaced.add(id);
  }
  for (const card of change.addCards) {
    if (existing.has(card.id)) throw new Error('Added card already exists');
  }
  const evidenceOnly = new Set<string>();
  for (const { cardId, field } of change.evidence) {
    const card = existing.get(cardId ?? '');
    if (!card || replaced.has(card.id)) continue;
    if (!(schema.document.fields as string[]).includes(field ?? '')) throw new Error('Invalid field evidence');
    evidenceOnly.add(card.id);
  }
  const sources = change.sources.map(({ id, ref, sha256 }) => {
    const text = readSource(sha256);
    return { id, ref, original: text, markdown: text };
  });
  const delta = materialize({
    vault: change.vault, schema: change.schema, sources,
    cards: [...change.addCards, ...change.updateCards, ...[...evidenceOnly].map((id) => existing.get(id)!)], evidence: change.evidence,
    relationships: [], ...(change.allowModel !== undefined && { allowModel: change.allowModel }),
  }, schema, revision, parent?.publication.revision, revision + '-', sourceUploadLimit, evidenceOnly);
  const removed = new Set(change.removeCards);
  const cards = [...existing.values()].filter(({ id }) => !replaced.has(id) && !evidenceOnly.has(id)).concat(delta.cards);
  const passages = (parent?.passages ?? []).filter(({ cardId }) => !cardId || !replaced.has(cardId)).concat(delta.passages);
  if (!cards.length || !passages.length) throw new Error('Cards and evidence are required');
  return validateSnapshot({
    ...delta, cards, passages,
    sources: [...parent?.sources ?? [], ...delta.sources],
    relationships: [
      ...(parent?.relationships ?? []).filter(({ from, to }) => !removed.has(from) && !removed.has(to)),
      ...change.relationships,
    ],
  });
}
