import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';

const tables = ['delegations', 'delegation_events', 'delegation_request_keys', 'delegation_files', 'delegation_notices'];
const definitions = () => readFileSync(atRepo('apps/adapter/migrations/005_delegations.sql'), 'utf8');

export function migrateDelegations(db: DatabaseSync) {
  db.exec(definitions());
}

export function verifyDelegations(db: DatabaseSync) {
  const saved = db.prepare('SELECT sql FROM sqlite_schema WHERE tbl_name IN (SELECT value FROM json_each(?)) AND sql IS NOT NULL')
    .all(JSON.stringify(tables));
  const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');
  const actual = new Set(saved.map(({ sql }) => normalize(String(sql))));
  const expected = definitions().split(';').map(normalize).filter(Boolean);
  if (actual.size !== expected.length || expected.some((sql) => !actual.has(sql)) || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Delegation tables, indexes, or foreign keys do not match the migration');
  }
}
