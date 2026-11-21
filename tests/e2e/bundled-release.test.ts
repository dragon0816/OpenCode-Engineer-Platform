import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { until, waitForExit } from '../../scripts/phase0/probe-http.ts';
import { maintenanceFixture } from './maintenance-fixture.ts';

test('installed bundled runtimes run the synthetic Excel campaign and web launcher', {
  skip: process.platform !== 'win32' || process.env.OEP_TEST_BUNDLED !== '1',
}, async () => {
  const fixture = maintenanceFixture();
  try {
    fixture.run('Install-OEP', ['-Source', resolve(process.env.OEP_TEST_RELEASE ?? 'dist/OEP-0.0.0-windows-x64-bundled.zip')]);
    const { version } = JSON.parse(readFileSync(join(fixture.install, 'current.json'), 'utf8'));
    const installed = join(fixture.install, version);
    const env = { ...fixture.env, OEP_REPO_ROOT: installed, OEP_DATA_DIR: fixture.data,
      OEP_PYTHON: join(installed, 'vendor/python/python.exe') };
    for (const name of ['sop.md', 'sop.pdf']) {
      copyFileSync(join('tests/fixtures/d08', name), join(installed, 'tests/fixtures/d08', name));
    }
    execFileSync(join(installed, 'vendor/node/node.exe'),
      ['--disable-warning=ExperimentalWarning', resolve('tests/e2e/sop-to-xlsx.test.ts'), '--synthetic'],
      { cwd: installed, env, timeout: 180_000, stdio: 'inherit' });

    const data = join(fixture.root, 'launcher-data');
    mkdirSync(data);
    const preload = pathToFileURL(resolve('tests/e2e/launch-bridge.ts')).href;
    const syntheticURL = 'http://example.invalid/v1';
    const launcher = spawn(join(installed, 'vendor/node/node.exe'),
      ['--disable-warning=ExperimentalWarning', join(installed, 'apps/launcher/src/web.ts')],
      { cwd: installed, windowsHide: true, stdio: 'inherit', env: {
        ...env, OEP_DATA_DIR: data, NODE_OPTIONS: '--import=' + preload,
        OEP_LITELLM_BASE_URL: syntheticURL, OEP_LITELLM_API_KEY: randomUUID(),
      } });
    const ended = new Promise<number | null>((done, fail) => {
      launcher.once('error', fail);
      launcher.once('exit', done);
    });
    try {
      await Promise.race([until(async () => existsSync(join(data, 'browser.jsonl')) || undefined, 90_000),
        ended.then(() => { throw new Error('Bundled launcher exited before browser handoff'); })]);
      writeFileSync(join(data, 'stop-test'), '');
      assert.equal(await waitForExit(ended, 15_000), 0);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill();
        await waitForExit(ended, 15_000);
      }
    }
  } finally { fixture.cleanup(); }
});
