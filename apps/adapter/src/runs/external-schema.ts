import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';

export const externalTables = ['external_helper_settings', 'external_sources', 'external_snapshots', 'external_confirmations'];
const definitions = () => readFileSync(atRepo('apps/adapter/migrations/006_external_helpers.sql'), 'utf8');
const modelSources = () => readFileSync(atRepo('apps/adapter/migrations/007_agent_model_sources.sql'), 'utf8');

export function migrateExternalHelpers(db: DatabaseSync) {
  db.exec(definitions());
}

export function verifyExternalHelpers(db: DatabaseSync) {
  verifyDefinitions(db, externalTables, definitions());
}

export function migrateAgentModelSources(db: DatabaseSync) {
  db.exec(modelSources());
}

export function verifyAgentModelSources(db: DatabaseSync) {
  verifyDefinitions(db, ['agent_model_sources'], modelSources());
}

function verifyDefinitions(db: DatabaseSync, tables: string[], definitions: string) {
  const rows = db.prepare('SELECT sql FROM sqlite_schema WHERE tbl_name IN (SELECT value FROM json_each(?)) AND sql IS NOT NULL')
    .all(JSON.stringify(tables));
  const normalize = (sql: string) => sql.trim().replace('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE ').replace(/\s+/g, ' ');
  const actual = new Set(rows.map(({ sql }) => normalize(String(sql))));
  const expected = definitions.split(';').map(normalize).filter(Boolean);
  if (actual.size !== expected.length || expected.some((sql) => !actual.has(sql))) {
    throw new Error('External helper tables or indexes do not match the migration');
  }
}
