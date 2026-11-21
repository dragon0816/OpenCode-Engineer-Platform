import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { unzipSync } from 'fflate';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('兩次建置的 ZIP 完全相同，且清單涵蓋每個發行檔案', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oep-determinism-'));
  const filename = 'OEP-0.0.0-windows-x64.zip';
  try {
    const archives = ['first', 'second'].map((folder) => {
      const output = join(scratch, folder);
      execFileSync(process.execPath, ['scripts/release/build-release.mjs', '0.0.0', output], { stdio: 'inherit' });
      const archive = readFileSync(join(output, filename));
      assert.equal(readFileSync(join(output, 'SHA256SUMS'), 'utf8'), sha256(archive) + '  ' + filename + '\n');
      return archive;
    });
    assert.equal(sha256(archives[0]), sha256(archives[1]));
    const files = unzipSync(archives[0]);
    const manifestPath = 'config/release.manifest.json';
    const manifest = JSON.parse(Buffer.from(files[manifestPath]));
    assert.deepEqual(Object.keys(files), Object.keys(files).sort());
    assert.deepEqual(manifest.files, Object.keys(files).filter((path) => path !== manifestPath).map((path) => ({
      path, size: files[path].byteLength, sha256: sha256(files[path]),
    })));
    assert.ok(!Object.keys(files).some((path) => path.startsWith('.phase0/')));
    if (process.platform === 'win32') {
      const unpacked = join(scratch, 'unpacked');
      for (const [name, bytes] of Object.entries(files)) {
        const target = join(unpacked, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      const data = join(scratch, 'data');
      mkdirSync(data);
      const { SystemRoot } = process.env;
      const options = { cwd: unpacked, encoding: 'utf8',
        env: { SystemRoot, PATH: join(SystemRoot, 'System32'), OEP_DATA_DIR: data } };
      const upstream = execFileSync(join(unpacked, 'vendor/opencode/opencode.exe'), ['--version'], options).trim();
      const pin = JSON.parse(Buffer.from(files['config/opencode.pin.json']));
      assert.equal(upstream, 'opencode ' + pin.tag);
      execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
        "await import('./apps/launcher/src/web.ts'); const { goldFixture } = await import('./tests/fixtures/knowledge/gold.ts'); goldFixture();"],
      options);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
