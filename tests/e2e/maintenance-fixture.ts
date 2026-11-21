import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function maintenanceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oep-maintenance-'));
  const install = join(root, 'program');
  const data = join(root, 'data');
  mkdirSync(data);
  const run = (script: string, args: string[], failure?: RegExp | 87) => {
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', 'scripts/windows/' + script + '.ps1',
      '-InstallRoot', install, '-DataRoot', data, ...args], {
      encoding: 'utf8', timeout: 120_000, env: { ...process.env, OEP_MAINTENANCE_TEST: '1',
        OEP_TEST_INTERRUPT_RESTORE: failure === 87 ? '1' : '0' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, failure === 87 ? 87 : failure ? 1 : 0, result.stderr);
    if (failure instanceof RegExp) assert.match(result.stderr, failure);
    return result.stdout;
  };
  return { root, install, data, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
