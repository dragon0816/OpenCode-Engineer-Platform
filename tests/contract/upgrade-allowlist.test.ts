import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';

// Tables present before any upgrade-tracked addition; everything else must be allow-listed.
const original = new Set(['runs', 'run_events']);

function webAdditions() {
  const source = readFileSync('scripts/windows/data-snapshot.mjs', 'utf8');
  const body = source.match(/const webAdditions = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(body, 'webAdditions allowlist not found');
  return new Set([...body[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

test('every web store table is accepted by the upgrade reconciliation allowlist', () => {
  mkdirSync('.phase0', { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.phase0', 'upgrade-allowlist-'));
  try {
    const file = join(root, 'web.sqlite');
    new WebStore(file).close();
    const db = new DatabaseSync(file, { readOnly: true });
    let tables: string[];
    try {
      tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map((row) => row.name);
    } finally { db.close(); }
    const allowed = webAdditions();
    const missing = tables.filter((name) => !original.has(name) && !allowed.has(name));
    assert.deepEqual(missing, [], 'Add new web tables to webAdditions in scripts/windows/data-snapshot.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-model WebStore schema migrates from an actual old snapshot and reconciles', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-previous-schema-'));
  try {
    const data = join(root, 'data');
    const backup = join(root, 'backup');
    const file = join(data, 'web', 'web.sqlite');
    mkdirSync(join(data, 'web'), { recursive: true });
    {
      using db = new DatabaseSync(file);
      db.exec(readFileSync(new URL('../fixtures/upgrade/web-before-model-selection.sql', import.meta.url), 'utf8'));
    }
    const run = (file: string, ...args: string[]) => {
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args],
        { encoding: 'utf8', timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const snapshot = 'scripts/windows/data-snapshot.mjs';
    run(snapshot, 'copy', data, backup);
    run(snapshot, 'describe', backup, join(backup, 'backup.manifest.json'));
    const migration = JSON.parse(run('scripts/windows/migrate-data.ts', data))['web/web.sqlite'];
    for (const table of ['web_model_catalog', 'web_model_selection']) {
      assert.equal(Object.hasOwn(migration.before.counts, table), false);
      assert.equal(migration.after.counts[table], 0);
    }
    assert.equal(migration.before.counts.runs, 1);
    assert.equal(migration.before.counts.run_events, 1);
    assert.equal(migration.before.counts.web_sessions, 1);
    run(snapshot, 'reconcile-upgrade', data, backup);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
