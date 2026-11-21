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

export function materialize(value: unknown, schema: Snapshot['schema'], revision: string, parent?: string) {
  record(value, 'candidate');
  const input = value as Candidate;
  if (input.schema !== schema.sha256) throw new Error('Candidate schema is stale');
  if (input.allowModel !== undefined && typeof input.allowModel !== 'boolean') throw new Error('Invalid consent');
  const sources = input.sources.map(({ id, ref, original, markdown }) => {
    string(original, 'source.original', 100_000);
    string(markdown, 'source.markdown', 100_000);
    return { id, ref, version: sha256(markdown), sha256: sha256(original) };
  });
  const byId = new Map(input.sources.map((source) => [source.id, source]));
  const fields = new Map<string, Map<string, string[]>>();
  const passages = input.evidence.map(({ sourceId, cardId, field, start, end }, index) => {
    const source = byId.get(sourceId);
    if (!source || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end > source.markdown.length) throw new Error('Invalid evidence range');
    const id = 'passage-' + index;
    const text = source.markdown.slice(start, end);
    if (input.vault.kind === 'bi') {
      const card = input.cards.find((item) => item.id === cardId);
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
  if (!passages.length) throw new Error('Evidence is required');
  const allowed = schema.document.fields as string[];
  const cards = input.cards.map((card) => {
    const byField = fields.get(card.id);
    if (!byField || allowed.some((field) => !byField.has(field)) ||
        Object.keys(card.fields).some((field) => !allowed.includes(field) || !byField.has(field))) {
      throw new Error('Card fields require schema-matched evidence');
    }
    return { ...card, fieldProvenance: Object.fromEntries(byField) };
  });
  if (input.vault.kind === 'bi' ? !cards.length : cards.length) throw new Error('Invalid vault content');
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
