import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { HttpError } from '../../apps/adapter/src/http/errors.ts';
import type { WebMessageCode } from '../../apps/adapter/src/http/messages.ts';
import { AttachmentService, convertWorkbook } from '../../apps/adapter/src/runs/attachments.ts';
import { failRun, finishWorkbook, verifyWorkbookReceipt } from '../../apps/adapter/src/runs/excel.ts';
import { Ledger } from '../../apps/adapter/src/runs/ledger.ts';
import { canonicalWorkspaceDirectory, checkDirectory, openWorkspaceFile, scopedPath } from '../../apps/adapter/src/runs/workspace.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { publishWorkbook } from '../../apps/adapter/src/runs/web-workbook.ts';
import { runFiles, workbookInput } from '../../apps/adapter/src/runs/controlled-files.ts';

function rejectsWith(status: number, code: WebMessageCode) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    assert.equal(error.detail.code, code);
    return true;
  };
}

function directory() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(join(process.cwd(), '.phase0', 'workspace-'));
}

test('workspace data roots accept DOS short names and reject junctions', { skip: process.platform !== 'win32' }, (t) => {
  const root = directory();
  try {
    const data = join(root, 'long workspace data root');
    mkdirSync(data);
    const alias = spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-c', [
      'import ctypes, sys',
      'short_name = ctypes.windll.kernel32.GetShortPathNameW',
      'buffer = ctypes.create_unicode_buffer(32768)',
      'if not 0 < short_name(sys.argv[1], buffer, len(buffer)) < len(buffer): sys.exit(1)',
      'sys.stdout.buffer.write(buffer.value.encode("utf-8"))',
    ].join('\n'), data], { windowsHide: true, encoding: 'utf8', timeout: 8_000 });
    assert.ifError(alias.error);
    assert.equal(alias.status, 0, alias.stderr);
    const junction = join(root, 'linked workspace data root');
    symlinkSync(data, junction, 'junction');
    assert.throws(() => canonicalWorkspaceDirectory(junction), /unsafe/);
    if (basename(alias.stdout).toLowerCase() === basename(data)) {
      t.diagnostic('This volume did not create an 8.3 alias for the fixture.');
      return;
    }
    assert.equal(canonicalWorkspaceDirectory(alias.stdout).toLowerCase(), data.toLowerCase());
    assert.throws(() => checkDirectory(alias.stdout), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace opens by identity and refuses traversal, UNC, ADS, reparse paths and handle races', (t) => {
  const root = directory();
  const inside = join(root, 'inside');
  const outside = join(root, 'outside');
  mkdirSync(inside);
  mkdirSync(outside);
  const path = join(inside, 'file.txt');
  const saved = join(inside, 'saved.txt');
  const foreign = join(outside, 'file.txt');
  writeFileSync(path, 'hello');
  writeFileSync(foreign, 'world');
  const { data, identity } = openWorkspaceFile(inside, 'file.txt', 20);
  assert.equal(data.toString(), 'hello');
  for (const bad of ['../outside/file.txt', '/file.txt', 'C:/file.txt', 'file.txt:stream', 'file:/x', '\\\\test.invalid\\file.txt', 'NUL.txt']) {
    assert.throws(() => scopedPath(inside, bad), /unsafe/);
  }
  symlinkSync(outside, join(inside, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => openWorkspaceFile(inside, 'linked/file.txt', 20));
  const portableLink = join(inside, 'link.txt');
  try {
    symlinkSync(foreign, portableLink, 'file');
    assert.throws(() => openWorkspaceFile(inside, 'link.txt', 20));
  }
  catch (error) {
    if (process.platform !== 'win32' || !(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    t.diagnostic('Windows file symlink creation is unavailable for this account. A real junction was checked.');
  }
  const open = fs.openSync;
  let attempted = false;
  fs.openSync = ((...args: Parameters<typeof open>) => {
    if (args[0] !== path) return open(...args);
    attempted = true;
    renameSync(path, saved);
    try { return open(foreign, args[1], args[2]); }
    finally { renameSync(saved, path); }
  }) as typeof open;
  syncBuiltinESMExports();
  try {
    assert.throws(() => openWorkspaceFile(inside, 'file.txt', 20, identity), /unsafe/);
    assert.equal(attempted, true);
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
  writeFileSync(path, 'abcde');
  assert.throws(() => openWorkspaceFile(inside, 'file.txt', 20, identity));
});

test('XLSX conversion keeps both worksheet names, all fixture cells and row locations, with bounded parsing', async () => {
  const source = readFileSync('tests/fixtures/attachments/table.xlsx');
  const expected = [
    'Sheet,量測', 'Row 1,Item,Limit,Enabled', 'Row 2,SYN-48B,12.5,TRUE', 'Row 3,SYN-61A,0,FALSE', '',
    'Sheet,Notes', 'Row 1,Code,Comment', 'Row 2,R1,合成資料', 'Row 3,R2,"a,b"', '', '',
  ].join('\r\n');
  assert.equal((await convertWorkbook(source)).toString(), expected);
  const path = 'xl/worksheets/sheet1.xml';
  const rewrite = (edit: (value: string) => string) => {
    const files = unzipSync(source);
    files[path] = strToU8(edit(Buffer.from(files[path]).toString()));
    return Buffer.from(zipSync(files));
  };
  const formula = rewrite((value) => value.replace('<v>12.5</v>', '<f>1+1</f><v>12.5</v>'));
  assert.match((await convertWorkbook(formula)).toString(), /\[formula omitted\]/);
  for (const file of [
    rewrite((xml) => xml.replace('r="C1"', 'r="AY1"')),
    rewrite((xml) => xml.replace('r="3"', 'r="501"')),
    rewrite((xml) => '<!DOCTYPE worksheet [<!ENTITY nested "BOUNDED">]>' + xml),
    Buffer.from('not a zip'),
  ]) await assert.rejects(convertWorkbook(file), rejectsWith(422, 'excel-conversion-unavailable'));
  const parts = unzipSync(source);
  const book = Buffer.from(parts['xl/workbook.xml']).toString();
  const item = book.match(/<sheet .*?\/>/)![0];
  parts['xl/workbook.xml'] = strToU8(book.replace('</sheets>', item.repeat(9) + '</sheets>'));
  await assert.rejects(convertWorkbook(Buffer.from(zipSync(parts))), rejectsWith(422, 'excel-conversion-unavailable'));
  const inflated = Buffer.from(source);
  const directoryEntry = inflated.indexOf(Buffer.from('504b0102', 'hex'));
  assert.notEqual(directoryEntry, -1);
  inflated.writeUInt32LE(100 * 1024 * 1024 + 1, directoryEntry + 24);
  await assert.rejects(convertWorkbook(inflated), rejectsWith(422, 'excel-conversion-unavailable'));
});

test('upload quota includes projections and staging cleanup preserves indexed files', async () => {
  const root = directory();
  mkdirSync(join(root, 'attachments'));
  const store = new WebStore(join(root, 'web.sqlite'));
  try {
    store.createSession({ id: 'owner', upstreamID: 'upstream', agent: 'inspector', alias: 'synthetic', createdAt: 1 });
    const service = new AttachmentService(store);
    const data = readFileSync('tests/fixtures/attachments/table.xlsx');
    const identity = { device: '', inode: '', created: '', modified: '', changed: '', sha256: '', bytes: 200 * 1024 * 1024 - data.length };
    store.saveAttachment('owner', { id: 'control', name: 'synthetic', mime: 'text/plain', original: identity });
    await assert.rejects(service.upload('owner', root, 'table.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data.length, async () => data), rejectsWith(413, 'session-storage-full'));
    assert.equal(store.attachments('owner').length, 1);
    store.createSession({ id: 'clean', upstreamID: 'second', agent: 'inspector', alias: 'synthetic', createdAt: 2 });
    const uploaded = await service.upload('clean', root, 'notes.txt', 'text/plain', 3, async () => Buffer.from('abc'));
    const staged = join(root, 'attachments', 'staging-00000000-0000-0000-0000-000000000000.tmp');
    writeFileSync(staged, 'temporary');
    service.clean('clean', root);
    assert.throws(() => readFileSync(staged));
    assert.match(service.prompt('clean', root, [uploaded.id]).text, /abc/);
  } finally { store.close(); }
});

test('forward migration preserves Phase 1 run records and saves a consistent rollback copy', () => {
  const root = directory();
  const file = join(root, 'runs.sqlite');
  const original = new Ledger(file);
  const record = original.create({ id: 'prior', workspace: root, mode: 'synthetic', state: 'accepted', createdAt: 1, retries: 0, errors: [] });
  original.close();
  const web = new WebStore(file);
  try { assert.deepEqual(web.get(record.id), record); }
  finally { web.close(); }
  const backup = readdirSync(root).find((name) => name.startsWith('runs.sqlite.before-v2-'));
  assert.ok(backup);
  const reverted = new Ledger(join(root, backup));
  try { assert.deepEqual(reverted.get(record.id), record); }
  finally { reverted.close(); }
});

test('invalid model workbook JSON produces no downloadable file', async () => {
  const root = directory();
  const data = join(root, 'generated');
  const output = join(root, 'artifacts');
  mkdirSync(data);
  mkdirSync(output);
  const run = { id: 'invalid', workspace: root, mode: 'synthetic', state: 'background' as const, createdAt: 1, retries: 0, errors: [] };
  const files = runFiles(root, run.id);
  files.write(workbookInput, '[{"name":"Notes","rows":[["A"]}]');
  await assert.rejects(publishWorkbook(output, files, run), rejectsWith(422, 'workbook-data-invalid'));
  assert.deepEqual(readdirSync(output), []);
});

test('run files require a verified manifest, exact safe names, and their own run directory', () => {
  const root = directory();
  mkdirSync(join(root, 'generated'));
  const files = runFiles(root, 'first');
  const foreign = runFiles(root, 'second');
  for (const name of ['../escape', 'C:/escape', '//host/share', 'a.txt:extra', 'LONGNA~1.TXT', 'nul.txt', 'Mixed.txt',
    'note.txt.', 'manifest-note.txt.json', 'second/note.txt']) {
    assert.throws(() => files.write(name, 'blocked'));
    assert.throws(() => files.read(name));
  }
  const receipt = files.write('note.txt', 'verified bytes');
  assert.equal(receipt.sha256, files.read('note.txt').identity.sha256);
  assert.throws(() => foreign.read('note.txt'));
  assert.throws(() => files.write('note.txt', 'replacement'));
  const stored = join(root, 'generated', 'first', 'note.txt');
  linkSync(stored, join(root, 'synthetic-other-link'));
  assert.throws(() => files.read('note.txt'));
});

test('Windows write pins the output root during rename and rejects a replaced root or colliding destination', () => {
  const root = directory();
  const safe = join(root, 'safe');
  mkdirSync(safe);
  mkdirSync(join(root, 'foreign'));
  const probe = spawnSync(process.env.OEP_PYTHON || 'python', ['-I', '-B', 'tests/fixtures/windows-write-race.py',
    safe, String(checkDirectory(safe).ino)], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(readFileSync(join(root, 'safe-moved', 'notes.txt'), 'utf8'), 'pinned');
  assert.deepEqual(readdirSync(join(root, 'foreign')), []);
  assert.deepEqual(readdirSync(join(root, 'safe')), ['COLLISION.TXT']);
});

test('Phase 1 workbook consumers preserve a cancelled terminal run', async () => {
  const root = directory();
  const ledger = new Ledger(join(root, 'runs.sqlite'));
  try {
    const id = 'cancelled-workbook';
    ledger.create({ id, workspace: root, mode: 'synthetic', state: 'accepted', createdAt: 1, retries: 0, errors: [] });
    ledger.change(id, 'running');
    ledger.change(id, 'background');
    const cancelled = ledger.change(id, 'cancelled', { finishedAt: 2 });
    const receipt = { runID: id, programSha256: 'synthetic', startedAt: 1, finishedAt: 2,
      exitCode: 0, signal: null, stdout: '', stderr: '' };
    assert.deepEqual(await finishWorkbook(ledger, id), cancelled);
    assert.deepEqual(verifyWorkbookReceipt(ledger, id, receipt), cancelled);
    assert.deepEqual(failRun(ledger, id, 'late failure'), cancelled);
    assert.throws(() => ledger.change(id, 'verified'));
    assert.deepEqual(ledger.get(id), cancelled);
  } finally { ledger.close(); }
});

test('the workbook writer is byte-identical for the same data at different times', async (t) => {
  const { workbook } = await import('../../apps/adapter/src/runs/workbook.ts');
  const value = [{ name: 'Synthetic', rows: [['Item', 'Limit'], ['SYN-1', 1]] }];
  const first = Buffer.from(workbook(value));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 60_000 });
  try { assert.deepEqual(Buffer.from(workbook(value)), first); }
  finally { t.mock.timers.reset(); }
});
