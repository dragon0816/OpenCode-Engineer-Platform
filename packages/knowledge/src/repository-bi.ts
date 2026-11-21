import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { RepositoryError, sqlIdentifier, sqliteColumns, sqliteTables } from './repository-files.ts';
import { canonical, identifier, sha256, snapshotFormat, validateSnapshot } from './snapshot.ts';
import type { Card, Snapshot, Source } from './snapshot.ts';

type Row = Record<string, SQLOutputValue>;
type Identity = Pick<Snapshot, 'vault' | 'publication'> & { repository: NonNullable<Snapshot['repository']> };

function stableId(value: string, prefix: string) {
  return identifier.test(value) ? value : `${prefix}-${sha256(value)}`;
}

function locator(value: string, seq: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return { label: parsed || `evidence:${seq}` };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { rev, line_start, line_end } = parsed as Record<string, unknown>;
      const version = (typeof rev === 'number' && Number.isSafeInteger(rev)) || (typeof rev === 'string' && rev.trim())
        ? String(rev) : undefined;
      return { label: Number.isSafeInteger(line_start) && Number.isSafeInteger(line_end)
        ? `#L${line_start}-L${line_end}` : canonical(parsed), version };
    }
  } catch { /* Older snapshots may keep a plain-text locator. */ }
  return { label: value || `evidence:${seq}` };
}

export function readBiSnapshot(db: DatabaseSync, file: string, identity: Identity): Snapshot {
  const tables = new Map(sqliteTables(db).filter((row) => row.type === 'table')
    .map((row) => [String(row.name), sqliteColumns(db, String(row.name)).map((col) => String(col.name))]));
  const problem = (detail: string): never => { throw new RepositoryError(file, detail); };

  function read(table: string, required: string[], optional: string[] = [], necessary = false) {
    const columns = tables.get(table);
    if (!columns && !necessary) return [];
    if (!columns || required.some((column) => !columns.includes(column))) {
      return problem(`Unsupported BI schema at ${table}.`);
    }
    const projection = [...required, ...optional.filter((column) => columns.includes(column))].map(sqlIdentifier);
    const order = required.map(sqlIdentifier).join(', ');
    const rows = db.prepare(`SELECT ${projection.join(', ')} FROM main.${sqlIdentifier(table)} ORDER BY ${order} LIMIT 100001`).all();
    if (rows.length > 100_000) problem(`BI row limit exceeded at ${table}.`);
    return rows;
  }

  function text(row: Row, column: string, table: string) {
    const value = row[column];
    if (typeof value !== 'string') return problem(`Invalid BI row at ${table}.`);
    return value;
  }

  function integer(row: Row, column: string, table: string) {
    const value = row[column];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return problem(`Invalid BI row at ${table}.`);
    return String(value);
  }

  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (![8, 9, 14].includes(userVersion)) problem('Unsupported BI SQLite user_version.');
  const reference = read('meta', ['key', 'value']).find((row) => row.key === 'schema')?.value;
  if (reference !== undefined && typeof reference !== 'string') problem('Invalid BI schema reference.');
  const separator = typeof reference === 'string' ? reference.lastIndexOf('@') : -1;
  const schemaId = separator > 0 ? reference!.toString().slice(0, separator) : '';
  const schemaVersion = separator > 0 ? reference!.toString().slice(separator + 1) : '';
  const document = { sqliteUserVersion: userVersion, schemaReference: reference ?? null,
    tables: Object.fromEntries([...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  const snapshot: Snapshot = {
    ...identity, format: snapshotFormat, status: 'published',
    schema: { id: identifier.test(schemaId) ? schemaId : 'aep-bi-sqlite', version: schemaVersion || String(userVersion),
      document, sha256: sha256(canonical(document)) },
    sources: [], cards: [], relationships: [], passages: [],
  };
  const cards = new Map<string, Card>();
  for (const row of read('cards', ['id', 'entity_type', 'canonical_key', 'name', 'version'], [], true)) {
    const originalId = text(row, 'id', 'cards');
    const card: Card = { id: stableId(originalId, 'card'), type: text(row, 'entity_type', 'cards'),
      key: text(row, 'canonical_key', 'cards'), title: text(row, 'name', 'cards'), version: integer(row, 'version', 'cards'),
      fields: Object.create(null), fieldProvenance: Object.create(null) };
    if (cards.has(originalId)) problem('Duplicate BI card ID.');
    cards.set(originalId, card);
    snapshot.cards.push(card);
  }
  const cardAt = (row: Row, column: string, table: string) =>
    cards.get(text(row, column, table)) ?? problem(`Unknown BI card reference at ${table}.`);
  for (const row of read('fields', ['card_id', 'field', 'value'], ['kind', 'ref', 'by', 'at'], true)) {
    const card = cardAt(row, 'card_id', 'fields');
    const name = text(row, 'field', 'fields');
    if (Object.hasOwn(card.fields, name)) problem('Duplicate BI field.');
    try { card.fields[name] = JSON.parse(text(row, 'value', 'fields')); }
    catch { problem('Invalid BI field JSON.'); }
    const { card_id, field, value, ...provenance } = row;
    card.fieldProvenance![name] = provenance;
  }
  const stateColumns = tables.get('field_states');
  if (stateColumns?.includes('card_id') && stateColumns.includes('field')) {
    for (const row of read('field_states', ['card_id', 'field'], ['state', 'status', 'reason', 'note', 'by', 'at'])) {
      const { card_id, field, ...state } = row;
      const card = cards.get(String(card_id));
      if (card && Object.keys(state).length) {
        card.fieldStates ??= Object.create(null) as Record<string, unknown>;
        card.fieldStates[String(field)] = state;
      }
    }
  }
  for (const row of read('relations', ['relation_id', 'from_card_id', 'relation_type', 'to_card_id'],
    ['status', 'origin', 'source_field', 'scope', 'note', 'by', 'at'])) {
    const { from_card_id, relation_type, to_card_id, ...provenance } = row;
    snapshot.relationships.push({ from: cardAt(row, 'from_card_id', 'relations').id,
      to: cardAt(row, 'to_card_id', 'relations').id, kind: text(row, 'relation_type', 'relations'), provenance });
  }
  identity.repository.history = read('history', ['seq', 'card_id', 'field'],
    ['old', 'new', 'kind', 'ref', 'by', 'at', 'import_id', 'reason', 'old_source', 'old_evidence']);
  identity.repository.relationEvidence = read('relation_evidence', ['evidence_link_id', 'relation_id', 'basis_card_id', 'reference_id'],
    ['stance', 'assessment', 'by', 'at']);
  const sources = new Map<string, Source>();
  const evidenceRows = read('evidence', ['seq', 'card_id', 'field', 'source_id', 'source_name', 'locator', 'excerpt'],
    ['run_id', 'basis', 'at', 'reference_id', 'stance', 'reference_at', 'reference_time_basis', 'assessment']);
  identity.repository.evidence = evidenceRows.map((row) => {
    const seq = integer(row, 'seq', 'evidence');
    const card = cardAt(row, 'card_id', 'evidence');
    const { excerpt, ...provenance } = row;
    const quote = text(row, 'excerpt', 'evidence');
    const { label, version: sourceRevision } = locator(text(row, 'locator', 'evidence'), seq);
    const source = text(row, 'source_id', 'evidence');
    const ref = text(row, 'source_name', 'evidence') || source || 'AEP evidence';
    const version = sourceRevision ?? identity.repository.commit;
    const sourceId = `source-${sha256(canonical([source, ref, version]))}`;
    if (!sources.has(sourceId)) sources.set(sourceId, { id: sourceId, ref, version });
    // A blanked or inferred reference can be retained for provenance without serving it as a quote.
    if (!quote.trim() || row.basis === 'inference') return { ...provenance, sourceId };
    let start = 0;
    let chunk = 0;
    const passageIds: string[] = [];
    while (start < quote.length) {
      let end = Math.min(start + 4000, quote.length);
      if (!quote.slice(start, end).isWellFormed() && end < quote.length) end--;
      const id = `evidence-${seq}${chunk ? `-${chunk + 1}` : ''}`;
      const text = quote.slice(start, end);
      if (text.trim()) {
        const place = quote.length > 4000 ? `${label}#excerpt=${start}-${end}` : label;
        snapshot.passages.push({ id, cardId: card.id, sourceId, locator: place, text, sha256: sha256(text) });
        passageIds.push(id);
      }
      start = end;
      chunk++;
    }
    return { ...provenance, sourceId, passageIds };
  });
  snapshot.sources = [...sources.values()];
  try { return validateSnapshot(snapshot); }
  catch { return problem('BI snapshot contains invalid or unsupported values, links, or schema version.'); }
}
