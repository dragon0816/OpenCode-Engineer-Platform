import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { requireTestDataDir } from '../test-data-guard.ts';

test('test entry points reject missing, live and redirected data roots before running', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-test-guard-'));
  try {
    const local = join(root, 'local');
    const live = join(local, 'OEP');
    const alias = join(root, 'alias');
    mkdirSync(live, { recursive: true });
    symlinkSync(live, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const message = /Tests require OEP_DATA_DIR.*outside/;
    for (const path of [undefined, 'relative', live, join(live, 'new'), join(alias, 'new')]) {
      assert.throws(() => requireTestDataDir({ LOCALAPPDATA: local, OEP_DATA_DIR: path }), message);
    }
    const separate = join(local, 'OEP-tests');
    assert.equal(requireTestDataDir({ LOCALAPPDATA: local, OEP_DATA_DIR: separate }), separate);
    const scripts = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const [name, command] of Object.entries<string>(scripts.scripts)) {
      if (!name.startsWith('test:')) continue;
      for (const part of command.split(' && ')) assert.match(part, /^node --import \.\/tests\/require-test-data\.mjs /, name);
    }
    for (const args of [
      ['--import', './tests/require-test-data.mjs', '-e', 'process.exit(42)'],
      [resolve('tests/e2e/custom-mcp-probe.ts')],
    ]) {
      const env = { ...process.env };
      delete env.OEP_DATA_DIR;
      const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
