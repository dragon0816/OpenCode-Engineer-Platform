import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type BiDeliveryDestination = { accountId: string; conversationKey: string; bindingRevision: number; agentId: 'bi' };
export type BiProvenance = {
  origin: 'telegram' | 'owner' | 'schedule' | 'legacy';
  sourceKey?: string;
  runId?: string;
  destination?: BiDeliveryDestination;
};

export const biOwnershipSchema = `
CREATE TABLE bi_job_ownership (
  job_id TEXT PRIMARY KEY REFERENCES ingest_jobs(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  agent_id TEXT NOT NULL CHECK(agent_id='bi'), work_id TEXT, origin TEXT NOT NULL
    CHECK(origin IN ('telegram','owner','schedule','legacy'))
) STRICT;
CREATE TABLE review_provenance (
  review_id TEXT PRIMARY KEY REFERENCES reviews(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  agent_id TEXT NOT NULL CHECK(agent_id='bi'), origin TEXT NOT NULL CHECK(origin IN ('telegram','owner','schedule','legacy')),
  source_key TEXT, run_id TEXT, delivery_destination TEXT CHECK(json_valid(delivery_destination)),
  CHECK(origin<>'telegram' OR (source_key IS NOT NULL AND delivery_destination IS NOT NULL))
) STRICT;
CREATE TABLE bi_publication_ownership (
  publication_id INTEGER PRIMARY KEY REFERENCES publications(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  agent_id TEXT NOT NULL CHECK(agent_id='bi'), review_id TEXT REFERENCES reviews(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) STRICT;`;

export const biOwnershipTables = ['bi_job_ownership', 'review_provenance', 'bi_publication_ownership'];

const hasTable = (db: DatabaseSync | undefined, table: string) => Boolean(db?.prepare(
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));

export function openBiChannelStore(directory: string) {
  const path = join(directory, 'telegram.sqlite');
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || file.nlink !== 1) throw new Error('Unsafe BI source ownership database');
  return new DatabaseSync(path, { readOnly: true });
}

const provenOrigin = (sourceKey: string, destination: BiDeliveryDestination): BiProvenance =>
  ({ origin: 'telegram', sourceKey, destination });

export function legacyBiTelegramSource(db: DatabaseSync | undefined, sourceKey: string): BiProvenance | undefined {
  const match = /^telegram-bi-(0|[1-9]\d*)$/.exec(sourceKey);
  const id = Number(match?.[1]);
  if (!Number.isSafeInteger(id) || !hasTable(db, 'bi_sources') || !hasTable(db, 'inbox')) return;
  const row = db?.prepare(`SELECT i.topic FROM bi_sources s JOIN inbox i ON i.id=s.id
    WHERE s.id=? AND i.bot='bi'`).get(id);
  if (typeof row?.topic !== 'number' || !Number.isSafeInteger(row.topic) || row.topic < 0) return;
  return provenOrigin(sourceKey, { accountId: 'telegram-bi', conversationKey: 'topic:' + row.topic, bindingRevision: 1, agentId: 'bi' });
}

export function recoverBiTelegramSource(path: string, sourceKey: string) {
  using channel = openBiChannelStore(dirname(path));
  if (!hasTable(channel, 'bi_source_ownership')) return legacyBiTelegramSource(channel, sourceKey);
  const row = channel?.prepare(`SELECT account_id AS accountId, conversation_key AS conversationKey,
    binding_revision AS bindingRevision, agent_id AS agentId FROM bi_source_ownership
    WHERE source_key=? AND origin='telegram' AND agent_id='bi'`).get(sourceKey);
  if (row) return provenOrigin(sourceKey, row as BiDeliveryDestination);
}

export const reviewProvenanceRow = (id: string, provenance: BiProvenance): SQLInputValue[] =>
  [id, 'bi', provenance.origin, provenance.sourceKey ?? null, provenance.runId ?? null,
    provenance.destination ? JSON.stringify(provenance.destination) : null];

function legacyKind(body: unknown) {
  try { return JSON.parse(String(body))?.vault?.kind; }
  catch { return undefined; }
}

export function* legacyBiOwnership(db: DatabaseSync, channel: DatabaseSync | undefined, table: string): Generator<SQLInputValue[]> {
  if (table === 'bi_job_ownership') {
    if (!hasTable(db, 'ingest_jobs')) return;
    for (const { id } of db.prepare('SELECT id FROM ingest_jobs').iterate()) {
      yield [id, 'bi', null, legacyBiTelegramSource(channel, String(id)) ? 'telegram' : 'legacy'];
    }
  } else if (table === 'review_provenance') {
    if (!hasTable(db, 'reviews')) return;
    const jobs = hasTable(db, 'ingest_effects') ? db.prepare('SELECT job FROM ingest_effects WHERE review=?') : undefined;
    const vault = hasTable(db, 'publications') ? db.prepare("SELECT 1 FROM publications WHERE vault=? AND kind='bi'") : undefined;
    for (const row of db.prepare('SELECT id,vault,original,draft FROM reviews').iterate()) {
      const kind = legacyKind(row.original) ?? legacyKind(row.draft);
      const links = jobs?.all(row.id) ?? [];
      if (kind === 'wiki' || kind !== 'bi' && !links.length && !vault?.get(row.vault)) continue;
      const linked = links.length === 1 ? String(links[0].job) : links.length === 0 ? String(row.id) : '';
      yield reviewProvenanceRow(String(row.id), legacyBiTelegramSource(channel, linked) ?? { origin: 'legacy' });
    }
  } else if (table === 'bi_publication_ownership') {
    if (!hasTable(db, 'publications')) return;
    const reviews = hasTable(db, 'reviews') ? db.prepare('SELECT id FROM reviews WHERE vault=? AND publication=? LIMIT 2') : undefined;
    for (const row of db.prepare("SELECT id,vault,revision FROM publications WHERE kind='bi'").iterate()) {
      const matches = reviews?.all(row.vault, row.revision) ?? [];
      yield [row.id, 'bi', matches.length === 1 ? matches[0].id : null];
    }
  } else throw new Error('Unknown BI ownership table');
}

export function migrateBiOwnership(db: DatabaseSync, path: string) {
  using channel = path === ':memory:' ? undefined : openBiChannelStore(dirname(path));
  db.exec(biOwnershipSchema);
  for (const table of biOwnershipTables) {
    let insert;
    for (const row of legacyBiOwnership(db, channel, table)) {
      insert ??= db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => '?').join(',')})`);
      insert.run(...row);
    }
  }
}

export function verifyBiOwnership(db: DatabaseSync) {
  if (db.prepare(`SELECT 1 FROM ingest_jobs j LEFT JOIN bi_job_ownership o ON o.job_id=j.id WHERE o.job_id IS NULL
    UNION ALL SELECT 1 FROM publications p LEFT JOIN bi_publication_ownership o ON o.publication_id=p.id
      WHERE (p.kind='bi')<>(o.publication_id IS NOT NULL)
    UNION ALL SELECT 1 FROM reviews r LEFT JOIN review_provenance o ON o.review_id=r.id
      WHERE json_valid(r.original) AND json_extract(r.original,'$.vault.kind')='bi' AND o.review_id IS NULL
    LIMIT 1`).get() || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('BI ownership is invalid');
}
