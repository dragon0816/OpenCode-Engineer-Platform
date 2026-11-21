import { createHash } from 'node:crypto';

export const snapshotFormat = 'oep-published-snapshot/1';
export const identifier = /^[\p{L}\p{N}][\p{L}\p{N}._:@/-]{0,191}$/u;
export const digestPattern = /^[a-f0-9]{64}$/;
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export type Source = { id: string; ref: string; version: string; sha256?: string };
export type Card = { id: string; type: string; key: string; title: string; version: string; fields: Record<string, unknown>;
  fieldStates?: Record<string, unknown>; fieldProvenance?: Record<string, unknown> };
export type Relationship = { from: string; to: string; kind: string; provenance?: Record<string, unknown> };
export type SnapshotPassage = { id: string; sourceId: string; cardId?: string; locator: string; text: string; sha256: string };
export type Snapshot = {
  format: typeof snapshotFormat;
  status: 'published';
  vault: { id: string; title: string; kind: 'bi' | 'wiki' };
  publication: { revision: string; publishedAt: string; publisher: string; parent?: string };
  schema: { id: string; version: string; document: Record<string, unknown>; sha256: string };
  sources: Source[];
  cards: Card[];
  relationships: Relationship[];
  passages: SnapshotPassage[];
  repository?: {
    tag: string; commit: string; author: string; clock: number; seq: number;
    history?: Record<string, unknown>[]; evidence?: Record<string, unknown>[]; relationEvidence?: Record<string, unknown>[];
  };
};

type PublicationOrder = Pick<NonNullable<Snapshot['repository']>, 'clock' | 'author' | 'seq'>;

export function compareRepositoryPublications(a: PublicationOrder, b: PublicationOrder) {
  return a.clock - b.clock || (a.author < b.author ? -1 : a.author > b.author ? 1 : a.seq - b.seq);
}

export function invalid(location: string): never {
  throw new Error(`Invalid published snapshot at ${location}`);
}

export function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(location);
  return value as Record<string, unknown>;
}

export function rows(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) invalid(location);
  return value;
}

export function string(value: unknown, location: string, limit = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit ||
      !value.isWellFormed() || /[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) invalid(location);
  return value;
}

function id(value: unknown, location: string) {
  if (typeof value !== 'string' || !identifier.test(value)) invalid(location);
  return value;
}

export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) invalid('JSON depth');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string' && value.isWellFormed()) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  const object = record(value, 'JSON value');
  return `{${Object.keys(object).sort().map((key) =>
    `${canonical(key, depth + 1)}:${canonical(object[key], depth + 1)}`).join(',')}}`;
}

export function validateSnapshot(value: unknown): Snapshot {
  canonical(value);
  const input = record(value, 'root');
  if (input.format !== snapshotFormat || input.status !== 'published') invalid('format/status');
  const vault = record(input.vault, 'vault');
  id(vault.id, 'vault.id');
  string(vault.title, 'vault.title');
  if (vault.kind !== 'bi' && vault.kind !== 'wiki') invalid('vault.kind');
  const publication = record(input.publication, 'publication');
  const revision = id(publication.revision, 'publication.revision');
  const time = string(publication.publishedAt, 'publication.publishedAt');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(time) ||
      !Number.isFinite(Date.parse(time))) invalid('publication.publishedAt');
  string(publication.publisher, 'publication.publisher');
  if (publication.parent !== undefined && id(publication.parent, 'publication.parent') === revision) invalid('publication.parent');
  const schema = record(input.schema, 'schema');
  id(schema.id, 'schema.id');
  if (typeof schema.version !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._:@/+\-]{0,191}$/u.test(schema.version)) invalid('schema.version');
  if (sha256(canonical(record(schema.document, 'schema.document'))) !== schema.sha256) invalid('schema.sha256');
  if (input.repository !== undefined) {
    const repo = record(input.repository, 'repository');
    id(repo.tag, 'repository.tag');
    id(repo.author, 'repository.author');
    if (typeof repo.commit !== 'string' || !digestPattern.test(repo.commit) ||
        typeof repo.clock !== 'number' || !Number.isSafeInteger(repo.clock) || repo.clock < 0 ||
        typeof repo.seq !== 'number' || !Number.isSafeInteger(repo.seq) || repo.seq < 1) invalid('repository order');
    for (const key of ['history', 'evidence', 'relationEvidence']) {
      if (repo[key] !== undefined) rows(repo[key], `repository.${key}`).forEach((row) => record(row, `repository.${key}`));
    }
  }

  const sourceIds = new Set<string>();
  const cardIds = new Set<string>();
  const cardKeys = new Set<string>();
  const edges = new Set<string>();
  const passages = new Set<string>();
  function unique(set: Set<string>, key: string, location: string) {
    if (set.has(key)) invalid(location);
    set.add(key);
  }
  for (const [index, value] of rows(input.sources, 'sources').entries()) {
    const at = `sources[${index}]`;
    const source = record(value, at);
    unique(sourceIds, id(source.id, at), at);
    string(source.ref, at, 2048);
    string(source.version, at);
    if (source.sha256 !== undefined && (typeof source.sha256 !== 'string' || !digestPattern.test(source.sha256))) invalid(at);
  }
  for (const [index, value] of rows(input.cards, 'cards').entries()) {
    const at = `cards[${index}]`;
    const card = record(value, at);
    unique(cardIds, id(card.id, at), at);
    unique(cardKeys, JSON.stringify([string(card.type, at), string(card.key, at)]), at);
    string(card.title, at);
    string(card.version, at);
    record(card.fields, at);
    if (card.fieldStates !== undefined) record(card.fieldStates, at);
    if (card.fieldProvenance !== undefined) record(card.fieldProvenance, at);
  }
  for (const [index, value] of rows(input.relationships, 'relationships').entries()) {
    const at = `relationships[${index}]`;
    const edge = record(value, at);
    if (!cardIds.has(id(edge.from, at)) || !cardIds.has(id(edge.to, at))) invalid(at);
    unique(edges, JSON.stringify([edge.from, edge.to, string(edge.kind, at)]), at);
    if (edge.provenance !== undefined) record(edge.provenance, at);
  }
  for (const [index, value] of rows(input.passages, 'passages').entries()) {
    const at = `passages[${index}]`;
    const passage = record(value, at);
    unique(passages, id(passage.id, at), at);
    if (!sourceIds.has(id(passage.sourceId, at)) ||
        (passage.cardId !== undefined && !cardIds.has(id(passage.cardId, at)))) invalid(at);
    string(passage.locator, at, 2048);
    if (sha256(string(passage.text, at, 4000)) !== passage.sha256) invalid(`${at}.sha256`);
  }
  return value as Snapshot;
}
