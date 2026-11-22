import assert from 'node:assert/strict';

export const knowledgeStorePath = 'packages/knowledge/src/store.ts';

export function historicalKnowledgeStore(source: string) {
  const latestVersion = 'export const knowledgeSchemaVersion = vaultClassificationsVersion;';
  const sliceMigration = /^          if \(version < vaultClassificationsVersion\) \{[\s\S]*?^          }$/m;
  assert.ok(source.includes('const vaultClassificationsVersion = 2;'));
  assert.ok(source.includes(latestVersion));
  assert.ok(source.includes('if (version > knowledgeSchemaVersion)'));
  assert.match(source, sliceMigration);
  // Preserve the historical reader and writer for the pinned v1 DDL.
  return source.replace(latestVersion, 'export const knowledgeSchemaVersion = 1;')
    .replace(sliceMigration, "          if (version === 0) this.db.exec(`PRAGMA user_version=${knowledgeSchemaVersion}`);");
}
