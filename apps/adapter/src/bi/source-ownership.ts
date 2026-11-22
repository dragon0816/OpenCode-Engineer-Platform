import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { legacyBiOwnership } from '../../../../packages/knowledge/src/bi/ownership.ts';

export const sourceOwnershipSchema = `CREATE TABLE bi_source_ownership (
  source_id INTEGER PRIMARY KEY REFERENCES bi_sources(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_key TEXT UNIQUE, agent_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('telegram','web','delegation','legacy')),
  account_id TEXT, conversation_key TEXT, binding_revision INTEGER,
  delegation_id TEXT, work_id TEXT, review_id TEXT,
  CHECK((origin='telegram' AND account_id IS NOT NULL AND conversation_key IS NOT NULL AND binding_revision > 0
      AND binding_revision IS NOT NULL) OR
    (origin<>'telegram' AND account_id IS NULL AND conversation_key IS NULL AND binding_revision IS NULL))
) STRICT;`;

export const legacyBiReviewKey = (id: number) => 'telegram-bi-' + id;

export function openBiReviewStore(directory: string) {
  const path = join(directory, 'knowledge.sqlite');
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return;
  if (!file.isFile() || file.nlink !== 1) throw new Error('Unsafe BI review ownership database');
  return new DatabaseSync(path, { readOnly: true });
}

export function* legacyBiSourceOwners(db: DatabaseSync, knowledge?: DatabaseSync): Generator<SQLInputValue[]> {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='bi_sources'").get()) return;
  const reviews = new Map<SQLInputValue, SQLInputValue>();
  if (knowledge) {
    for (const [review, , , source] of legacyBiOwnership(knowledge, db, 'review_provenance')) {
      if (source) reviews.set(source, reviews.has(source) ? null : review);
    }
  }
  const hasInbox = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='inbox'").get();
  const inbox = hasInbox ? db.prepare("SELECT topic FROM inbox WHERE bot='bi' AND id=?") : undefined;
  for (const { id } of db.prepare('SELECT id FROM bi_sources').iterate()) {
    const message = inbox?.get(id);
    const linked = typeof message?.topic === 'number' && Number.isSafeInteger(message.topic) && message.topic >= 0;
    const key = legacyBiReviewKey(Number(id));
    yield [id, key, 'bi', linked ? 'telegram' : 'legacy',
      linked ? 'telegram-bi' : null, linked ? 'topic:' + message.topic : null, linked ? 1 : null, null, null, reviews.get(key) ?? null];
  }
}

export function verifyBiSourceOwners(db: DatabaseSync) {
  if (db.prepare(`SELECT 1 FROM bi_sources AS source LEFT JOIN bi_source_ownership AS o ON o.source_id=source.id
    WHERE o.source_id IS NULL OR o.agent_id<>'bi' LIMIT 1`).get() || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('BI source ownership is invalid');
  }
}

export function verifyBiSourceReceipts(db: DatabaseSync, knowledge?: DatabaseSync) {
  if (!knowledge?.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='review_provenance'").get()) return;
  const match = db.prepare(`SELECT account_id AS accountId, conversation_key AS conversationKey,
    binding_revision AS bindingRevision, agent_id AS agentId FROM bi_source_ownership
    WHERE origin='telegram' AND agent_id='bi' AND source_key=?`);
  for (const row of knowledge.prepare(`SELECT p.review_id,p.source_key,p.delivery_destination,
      EXISTS(SELECT 1 FROM ingest_effects e WHERE e.job=p.source_key AND e.review=p.review_id) AS linked
    FROM review_provenance p WHERE p.origin='telegram'`).iterate()) {
    if ((!row.linked && row.source_key !== row.review_id) ||
      JSON.stringify(match.get(row.source_key)) !== row.delivery_destination) throw new Error('BI review destination is invalid');
  }
}
