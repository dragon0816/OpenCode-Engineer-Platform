import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { atRepo } from '../../../launcher/src/paths.ts';

export const pluginRegistryVersion = 12;

export function migratePlugins(db: DatabaseSync) {
  db.exec(readFileSync(atRepo('apps/adapter/migrations/012_plugins.sql'), 'utf8'));
}

export function verifyPluginRegistry(db: DatabaseSync) {
  db.prepare('SELECT plugin_id, version, artifact, digest, description FROM plugin_packages');
  db.prepare('SELECT plugin_id, version, previous_version, state, generation FROM plugin_installations');
  db.prepare('SELECT operation_id, plugin_id, operation, version, retired_artifact FROM plugin_operations');
  for (const table of ['plugin_packages', 'plugin_installations', 'plugin_operations']) {
    if (db.prepare(`PRAGMA foreign_key_check(${table})`).get()) throw new Error('Plugin registry relationships are invalid');
  }
}
