import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
