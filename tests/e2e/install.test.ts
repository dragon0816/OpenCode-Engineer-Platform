import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { maintenanceFixture } from './maintenance-fixture.ts';

test('release installation and destructive-action guards', { skip: process.platform !== 'win32' }, () => {
  const fixture = maintenanceFixture();
  try {
    const input = process.env.OEP_TEST_RELEASE ?? readdirSync('dist').find((name) => /^OEP-.*-windows-x64\.zip$/.test(name))?.replace(/^/, 'dist/');
    assert.ok(input, 'Run npm run build:release first');
    const source = resolve(input);
    const zip = basename(source);
    const install = (...args: string[]) => fixture.run('Install-OEP', ['-Source', source, ...args]);
    const checksumFolder = join(fixture.root, 'checksum');
    mkdirSync(checksumFolder);
    copyFileSync(source, join(checksumFolder, zip));
    writeFileSync(join(checksumFolder, 'SHA256SUMS'), '0'.repeat(64) + '  ' + zip + '\n');
    fixture.run('Install-OEP', ['-Source', join(checksumFolder, zip)], /ZIP 的 SHA-256/);
    install('-WhatIf');
    assert.ok(!existsSync(fixture.install));
    assert.deepEqual(readdirSync(fixture.data), []);
    install();
    install();
    assert.deepEqual(readdirSync(fixture.data), []);
    const pointer = join(fixture.install, 'current.json');
    const original = readFileSync(pointer);
    const current = JSON.parse(original.toString());
    writeFileSync(pointer, JSON.stringify({ ...current, version: '999.0.0' }));
    fixture.run('Install-OEP', ['-Source', source], /已安裝較新版本/);
    writeFileSync(pointer, original);

    const files = unzipSync(readFileSync(source));
    const altered = join(fixture.root, 'altered.zip');
    const check = (contents: typeof files, message: RegExp) => {
      writeFileSync(altered, zipSync(contents, { level: 0 }));
      fixture.run('Install-OEP', ['-Source', altered], message);
    };
    const license = files.LICENSE.slice();
    license[0] ^= 1;
    check({ ...files, LICENSE: license }, /SHA-256 不符/);
    check({ ...files, 'extra.txt': new Uint8Array([1]) }, /清單以外/);
    check({ ...files, '../escape.txt': new Uint8Array([1]) }, /不安全的路徑/);
    assert.ok(!existsSync(join(fixture.root, 'escape.txt')));

    writeFileSync(join(fixture.data, 'keep.txt'), 'synthetic');
    fixture.run('Uninstall-OEP', ['-All', '-WhatIf']);
    assert.ok(existsSync(pointer));
    fixture.run('Uninstall-OEP', ['-All', '-RemoveData'], /刪除資料需要/);
    fixture.run('Uninstall-OEP', ['-All']);
    assert.ok(!existsSync(pointer));
    assert.equal(readFileSync(join(fixture.data, 'keep.txt'), 'utf8'), 'synthetic');
    fixture.run('Uninstall-OEP', ['-All', '-RemoveData', '-ConfirmRemoveData', 'DELETE OEP DATA']);
    assert.ok(!existsSync(fixture.data));
  } finally { fixture.cleanup(); }
});
