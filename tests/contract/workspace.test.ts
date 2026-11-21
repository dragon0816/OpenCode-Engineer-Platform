import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { AttachmentService, convertWorkbook } from '../../apps/adapter/src/runs/attachments.ts';
import { Ledger } from '../../apps/adapter/src/runs/ledger.ts';
import { openWorkspaceFile, scopedPath } from '../../apps/adapter/src/runs/workspace.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { publishWorkbook, workbookInput } from '../../apps/adapter/src/runs/web-workbook.ts';

function directory() {
  mkdirSync('.phase0', { recursive: true });
  return mkdtempSync(join(process.cwd(), '.phase0', 'workspace-'));
}

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
  ]) await assert.rejects(convertWorkbook(file), /Unsupported XLSX/);
  const parts = unzipSync(source);
  const book = Buffer.from(parts['xl/workbook.xml']).toString();
  const item = book.match(/<sheet .*?\/>/)![0];
  parts['xl/workbook.xml'] = strToU8(book.replace('</sheets>', item.repeat(9) + '</sheets>'));
  await assert.rejects(convertWorkbook(Buffer.from(zipSync(parts))), /Unsupported XLSX/);
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
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data.length, async () => data), /quota/);
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
  writeFileSync(scopedPath(root, workbookInput(run.id)), '[{"name":"Notes","rows":[["A"]}]');
  await assert.rejects(publishWorkbook(output, root, run), /invalid workbook JSON/);
  assert.deepEqual(readdirSync(output), []);
});
