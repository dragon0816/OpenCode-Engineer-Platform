import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('rollback only removes the verified version staged by the failed upgrade', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-rollback-version-'));
  try {
    const install = join(root, 'install');
    const data = join(root, 'data');
    const source = join(root, 'release');
    const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const release = (folder: string, version: string, contents: string) => {
      mkdirSync(join(folder, 'config'), { recursive: true });
      writeFileSync(join(folder, 'LICENSE'), contents);
      const manifest = JSON.stringify({ format: 1, platform: 'windows-x64', version,
        files: [{ path: 'LICENSE', sha256: sha256(contents), size: Buffer.byteLength(contents) }],
      });
      writeFileSync(join(folder, 'config/release.manifest.json'), manifest);
      return { version, manifestSha256: sha256(manifest) };
    };
    const previous = release(join(install, '0.1.0'), '0.1.0', 'original');
    const next = release(source, '0.2.0', 'new release');
    const pointer = join(install, 'current.json');
    writeFileSync(pointer, JSON.stringify(previous));
    mkdirSync(data);
    writeFileSync(join(data, 'note.txt'), 'prior bytes');
    const journalPath = join(install, 'upgrade.journal.json');
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '. ./scripts/windows/OEP-Maintenance.ps1',
      '. ./scripts/windows/OEP-Snapshot.ps1',
      '. ./scripts/windows/OEP-Upgrade.ps1',
      '$InstallRoot = Root-OEP $env:OEP_TEST_INSTALL',
      '$DataRoot = Root-OEP $env:OEP_TEST_DATA',
      '$source = Root-OEP $env:OEP_TEST_RELEASE_ROOT',
      'Guard-OEP $InstallRoot; Guard-OEP $DataRoot; Separate-OEP $InstallRoot $DataRoot',
      '$id = [guid]::NewGuid().ToString("N")',
      String.raw`$lock = [Threading.Mutex]::new($true, "Local\OEP.Maintenance.Test.$id")`,
      'try {',
      '  $release = Read-ReleaseOEP $source $null',
      '  if (Test-UpgradeTarget $InstallRoot $release) { throw "Version exists before staging" }',
      '  $target = Root-OEP (Join-Path $InstallRoot $release.manifest.version)',
      '  $previous = Read-OEP (Join-Path $InstallRoot "current.json")',
      '  $backup = New-Backup $DataRoot (Join-Path $InstallRoot "upgrade-backups") $previous.version',
      '  $journal = @{ format=1; state="prepared"; id=$id; createdVersion=$true; previous=$previous; dataRoot=$DataRoot',
      '    backup=$backup; backupHash=Hash-OEP (Join-Path $backup "backup.manifest.json")',
      '    next=@{ version=$release.manifest.version; manifestSha256=$release.hash } }',
      '  $journalPath = Join-Path $InstallRoot "upgrade.journal.json"',
      '  Write-OEP $journalPath $journal',
      '  Stage-ReleaseOEP $release $target (Join-Path $InstallRoot ".install-$id")',
      '  [IO.File]::WriteAllText((Join-Path $target "LICENSE"), "stale build")',
      '  try { [void](Test-UpgradeTarget $InstallRoot $release); throw "Mismatched version passed" } catch {',
      '    if ($script:failure -notmatch "非目前版本.*移出安裝根目錄") { throw }',
      '  }',
      '  if ([IO.File]::ReadAllText((Join-Path $target "LICENSE")) -ne "stale build") { throw "Mismatched version changed" }',
      '  [IO.File]::Copy((Join-Path $source "LICENSE"), (Join-Path $target "LICENSE"), $true)',
      '  try {',
      '    Remove-FailedUpgradeVersion $InstallRoot ($journal + @{} | ForEach-Object { $_.next = $previous; $_ })',
      '    throw "Protection failed"',
      '  } catch { if ($script:failure -notmatch "不可移除目前版本") { throw } }',
      '  [IO.File]::WriteAllText((Join-Path $DataRoot "note.txt"), "failed migration")',
      '  Restore-Upgrade $InstallRoot $DataRoot $journalPath $journal',
      '} catch { [Console]::Error.WriteLine($script:failure); throw }',
      'finally { $lock.ReleaseMutex(); $lock.Dispose() }',
    ].join('\n')], { encoding: 'utf8', timeout: 30_000, env: {
      ...process.env, OEP_MAINTENANCE_TEST: '1', OEP_TEST_INSTALL: install, OEP_TEST_DATA: data,
      OEP_TEST_RELEASE_ROOT: source,
    } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已回退至 0\.1\.0。資料比對通過/);
    assert.deepEqual(JSON.parse(readFileSync(pointer, 'utf8')), previous);
    assert.equal(readFileSync(join(install, previous.version, 'LICENSE'), 'utf8'), 'original');
    assert.equal(readFileSync(join(data, 'note.txt'), 'utf8'), 'prior bytes');
    assert.equal(existsSync(join(install, next.version)), false);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(journal.state, 'rolledBack');
    assert.equal(journal.createdVersion, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
