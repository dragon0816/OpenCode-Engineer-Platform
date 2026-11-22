import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { requireTestDataDir } from '../test-data-guard.ts';

export function maintenanceFixture() {
  const base = requireTestDataDir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'oep-maintenance-'));
  const install = join(root, 'program');
  const data = join(root, 'data');
  mkdirSync(data);
  const bundled = process.env.OEP_TEST_BUNDLED === '1';
  const powershell = bundled ? join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe') : 'pwsh.exe';
  const env = { ...process.env, OEP_MAINTENANCE_TEST: '1' };
  if (bundled) Object.assign(env, { PATH: join(process.env.SystemRoot!, 'System32'), OEP_PYTHON: '' });
  const run = (script: string, args: string[], failure?: RegExp | 87) => {
    const result = spawnSync(powershell, ['-NoProfile', '-File', 'scripts/windows/' + script + '.ps1',
      '-InstallRoot', install, '-DataRoot', data, ...args], {
      encoding: 'utf8', timeout: 120_000, env: { ...env,
        OEP_TEST_INTERRUPT_RESTORE: failure === 87 ? '1' : '0' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, failure === 87 ? 87 : failure ? 1 : 0, result.stderr);
    if (failure instanceof RegExp) assert.match(result.stderr, failure);
    return result.stdout;
  };
  return { root, install, data, run, env, powershell, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
