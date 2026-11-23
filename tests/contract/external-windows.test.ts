import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ExternalExecutor } from '../../apps/adapter/src/runs/external-executor.ts';
import { windowsExternalIsolation, type WindowsHelperOs } from '../../apps/adapter/src/runs/external-windows.ts';

test('Windows helper provisioning and token probes exercise platform fakes without changing host configuration', {
  skip: process.platform !== 'win32', timeout: 25_000,
}, () => {
  const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const fixture = fileURLToPath(new URL('../fixtures/external-helpers/setup-fake.ps1', import.meta.url));
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.match(output, /Synthetic setup, repair, removal and verification passed\./);
});

test('Windows helper boundary fails closed and forwards credentials and release only to the pinned OS connection', async () => {
  const folder = mkdtempSync(join(process.env.OEP_DATA_DIR || tmpdir(), 'oep-helper-boundary-'));
  try {
    const copyRoot = join(folder, 'runs');
    const run = join(copyRoot, '13869f9a-5b24-40e9-9318-f35d140734db');
    const work = join(run, 'work');
    const inputs = join(work, 'oep-inputs');
    const scratch = join(run, 'scratch');
    mkdirSync(inputs, { recursive: true });
    mkdirSync(scratch);
    const output = (root: string) => ({ root, inode: 'synthetic' });
    const copy = { work: output(work), inputs: output(inputs), scratch: output(scratch), prompt: 'Synthetic public task' };
    const pin = { version: '1.2.3' as const, sha256: 'a'.repeat(64) };
    const os = {
      inspection: { isolation: 'unavailable', installation: 'unknown' } as Awaited<ReturnType<WindowsHelperOs['inspect']>>,
      signedIn: false,
      async inspect() { return this.inspection; },
      async invoke(request, _signal, release) {
        assert.deepEqual(request.pin, pin);
        assert.equal(request.provider, 'codex_cli');
        const receipt = (exit: number, stdout = '') => ({ exit, stdout, members: 1, orphans: 0 });
        if (request.operation === 'version') return receipt(0, 'codex-cli 1.2.3');
        if (request.operation === 'status') return this.signedIn ? receipt(0, 'Logged in using ChatGPT') : receipt(1, 'Not logged in');
        if (request.operation === 'key') {
          assert.equal(request.input, 'synthetic-key-value\n');
          assert.ok(request.arguments.includes('--with-api-key'));
          assert.ok(!request.arguments.includes('synthetic-key-value'));
          this.signedIn = true;
          return receipt(0);
        }
        assert.equal(request.operation, 'run');
        assert.equal(request.runId, '13869f9a-5b24-40e9-9318-f35d140734db');
        assert.equal(request.input, copy.prompt);
        release?.();
        return receipt(0, 'synthetic result');
      },
    } satisfies WindowsHelperOs & { inspection: Awaited<ReturnType<WindowsHelperOs['inspect']>>; signedIn: boolean };
    const stop = new AbortController().signal;
    const isolation = windowsExternalIsolation(folder, os);
    const executor = new ExternalExecutor(folder, isolation);
    assert.equal((await executor.refresh('codex_cli', stop)).isolation, 'unavailable');
    await assert.rejects(executor.authenticate('codex_cli', { action: 'key', key: 'synthetic-key-value' }, stop), {
      code: 'external-isolation-unavailable',
    });
    os.inspection = { isolation: 'verified', installation: 'missing' };
    assert.equal((await executor.refresh('codex_cli', stop)).installation, 'missing');
    os.inspection = { isolation: 'verified', installation: 'unsupported' };
    assert.equal((await executor.refresh('codex_cli', stop)).installation, 'unsupported');
    os.inspection = { isolation: 'verified', copyRoot, pin };
    assert.equal((await executor.refresh('codex_cli', stop)).login, 'signedOut');
    assert.equal((await executor.authenticate('codex_cli', { action: 'key', key: 'synthetic-key-value' }, stop)).login, 'signedIn');
    const cli = await isolation.connect('codex_cli', stop);
    assert.ok('run' in cli);
    assert.equal(cli.copyRoot, copyRoot);
    assert.throws(() => cli.run([], { ...copy, scratch: output(folder) }, stop, assert.fail), { code: 'external-isolation-unavailable' });
    await assert.rejects(cli.run([], copy, stop, () => { throw new Error('Synthetic launch gate rejected changed input'); }), /launch gate/);
    let releases = 0;
    assert.equal((await cli.run([], copy, stop, () => { releases++; })).stdout, 'synthetic result');
    assert.equal(releases, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
