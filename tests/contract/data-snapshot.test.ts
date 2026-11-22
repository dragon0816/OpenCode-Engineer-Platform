import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const malformed = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(512, 0xff)]);
const snapshot = (...args: string[]) => spawnSync(process.execPath, [
  '--disable-warning=ExperimentalWarning', 'scripts/windows/data-snapshot.mjs', ...args,
], { encoding: 'utf8', timeout: 15_000 });

test('snapshot copies and hashes unknown SQLite files and sidecars without opening them', () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-snapshot-scope-'));
  try {
    const data = join(root, 'data');
    const unknown = 'old-browser-profile/web.sqlite';
    mkdirSync(join(data, 'old-browser-profile'), { recursive: true });
    writeFileSync(join(data, unknown), malformed);
    writeFileSync(join(data, unknown + '-wal'), 'synthetic sidecar');
    const database = join(data, 'runs.sqlite');
    {
      using db = new DatabaseSync(database);
      db.exec('CREATE TABLE fixture (id INTEGER); INSERT INTO fixture VALUES (1);');
    }
    assert.throws(() => {
      using db = new DatabaseSync(join(data, unknown), { readOnly: true });
      db.prepare('PRAGMA quick_check').get();
    });
    const copied = join(root, 'copied');
    let result = snapshot('copy', data, copied);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(copied, unknown)), malformed);
    assert.equal(readFileSync(join(copied, unknown + '-wal'), 'utf8'), 'synthetic sidecar');
    const manifest = join(root, 'backup.manifest.json');
    result = snapshot('describe', copied, manifest);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.deepEqual(Object.keys(metadata.databases), ['runs.sqlite']);
    assert.equal(metadata.databases['runs.sqlite'].counts.fixture, 1);
    assert.deepEqual(metadata.inventory.find(({ path }: { path: string }) => path === unknown), {
      path: unknown, size: malformed.length, sha256: createHash('sha256').update(malformed).digest('hex'),
    });
    metadata.databases[unknown] = { userVersion: 0, counts: {} };
    writeFileSync(manifest, JSON.stringify(metadata));
    result = snapshot('reconcile-restore', copied, manifest);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(manifest, '{}');
    const invalid = snapshot('reconcile-restore', copied, manifest);
    assert.ifError(invalid.error);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.trim(), '【backup.manifest.json】備份清單讀取或 JSON 結構檢查失敗。');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('snapshot diagnostics name a broken OEP database in the console and journals', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-snapshot-error-'));
  try {
    const data = join(root, 'data');
    const install = join(root, 'install');
    mkdirSync(join(data, 'web'), { recursive: true });
    mkdirSync(install);
    writeFileSync(join(data, 'web/web.sqlite'), malformed);
    const report = join(root, 'inventory.json');
    const direct = snapshot('describe', data, report);
    assert.ifError(direct.error);
    assert.equal(direct.status, 1);
    const diagnostic = '【web/web.sqlite】SQLite 結構、筆數或發布修訂讀取失敗。';
    assert.equal(direct.stderr.trim(), diagnostic);
    const journal = join(install, 'upgrade.journal.json');
    writeFileSync(journal, JSON.stringify({
      format: 1, id: 'a'.repeat(32), state: 'prepared', dataRoot: data,
    }));
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '. ./scripts/windows/OEP-Maintenance.ps1',
      '. ./scripts/windows/OEP-Snapshot.ps1',
      '. ./scripts/windows/OEP-Upgrade.ps1',
      '$InstallRoot = Root-OEP $env:OEP_TEST_INSTALL',
      '$DataRoot = Root-OEP $env:OEP_TEST_DATA',
      'Guard-OEP $InstallRoot; Guard-OEP $DataRoot; Separate-OEP $InstallRoot $DataRoot',
      '$script:failureLogRoot = $InstallRoot',
      "try { Invoke-Snapshot 'describe' $DataRoot $env:OEP_TEST_REPORT } catch {",
      "    Report-OEPFailure '升級失敗'",
      "    Record-UpgradeFailure (Join-Path $InstallRoot 'upgrade.journal.json') $DataRoot '升級失敗'",
      "    $pending = Join-Path $DataRoot 'locked.tmp'",
      '    $held = [IO.File]::Open($pending, "Create", "ReadWrite", "None")',
      '    try { Clear-OEPArtifact $pending } finally { $held.Dispose() }',
      '    if (!$script:cleanupFailed) { throw "Expected locked file cleanup to fail" }',
      '    exit 1',
      '}',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000, env: {
      ...process.env, OEP_MAINTENANCE_TEST: '1', OEP_TEST_INSTALL: install, OEP_TEST_DATA: data, OEP_TEST_REPORT: report,
    } });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr.trim(), diagnostic);
    const cleanupDiagnostic = '【locked.tmp】清除維護暫存項目失敗。';
    assert.ok(result.stdout.includes(cleanupDiagnostic));
    const log = readFileSync(join(install, 'maintenance.log'), 'utf8');
    assert.ok(log.includes(diagnostic));
    assert.ok(log.includes(cleanupDiagnostic));
    const record = JSON.parse(readFileSync(journal, 'utf8'));
    assert.equal(record.failures[0].message, diagnostic);
    assert.equal(record.state, 'prepared');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
