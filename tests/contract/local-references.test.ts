import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HttpError } from '../../apps/adapter/src/http/errors.ts';
import { AttachmentService } from '../../apps/adapter/src/runs/attachments.ts';
import { ExternalSources } from '../../apps/adapter/src/runs/external-sources.ts';
import { LocalReferences, referenceReadArgs } from '../../apps/adapter/src/runs/local-references.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { workbook } from '../../apps/adapter/src/runs/workbook.ts';
import { canonicalWorkspaceDirectory } from '../../apps/adapter/src/runs/workspace.ts';
import { workbookFixture } from '../e2e/synthetic-excel.ts';
import { sha256 } from '../../packages/knowledge/src/snapshot.ts';

function rejects(code: string) {
  return (error: unknown) => error instanceof HttpError && error.detail.code === code;
}

test('Explorer path paste handles quoted and unquoted Windows paths without treating prose as a selection', async () => {
  const { pastedLocalPaths } = await import(new URL('../../apps/web/src/local-paths.js', import.meta.url).href) as {
    pastedLocalPaths: (text: string) => string[];
  };
  assert.deepEqual(pastedLocalPaths('"C:\\synthetic\\file with spaces.json"\r\nD:\\合成資料\\表格.csv'),
    ['C:\\synthetic\\file with spaces.json', 'D:\\合成資料\\表格.csv']);
  assert.deepEqual(pastedLocalPaths('Review this file:\r\nC:\\synthetic\\source.csv'), []);
  assert.deepEqual(pastedLocalPaths('\\\\synthetic\\share\\file.csv'), []);
  assert.deepEqual(pastedLocalPaths('"C:\\synthetic\\file.csv'), []);
});

test('reference arguments allow bounded ranges and relative members only', () => {
  const reference = randomUUID();
  assert.ok(referenceReadArgs({ reference, path: '中文/space name.csv', offset: 1_200_000_000, length: 16384 }));
  assert.ok(referenceReadArgs({ reference, list: true, after: 'last.csv' }));
  assert.ok(!referenceReadArgs({ reference, path: '../outside.csv' }));
  assert.ok(!referenceReadArgs({ reference, path: 'C:/outside.csv' }));
  assert.ok(!referenceReadArgs({ reference, path: 'notes.csv:secret' }));
  assert.ok(!referenceReadArgs({ reference, length: 16385 }));
  assert.ok(!referenceReadArgs({ reference, offset: 0.5 }));
  assert.ok(!referenceReadArgs({ reference, attachment: randomUUID() }));
  assert.ok(!referenceReadArgs({ reference, list: true, offset: 0 }));
});

test('reference grants pin large files and folder members, verify identity and audit hashes', { skip: process.platform !== 'win32' }, async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'oep-references-contract-'));
  const root = canonicalWorkspaceDirectory(temporary);
  const folder = join(root, 'synthetic allowed');
  const data = join(temporary, 'synthetic private');
  mkdirSync(folder);
  mkdirSync(data);
  const file = join(folder, 'big.csv');
  writeFileSync(file, 'first,row\n');
  const system = process.env.SystemRoot!;
  execFileSync(join(system, 'System32/fsutil.exe'), ['sparse', 'setflag', file], { windowsHide: true });
  const tail = 1024 ** 3 + 123;
  const fd = openSync(file, 'r+');
  try { writeSync(fd, Buffer.from('last,row\n'), 0, 9, tail); }
  finally { closeSync(fd); }
  assert.equal(statSync(file).size, tail + 9);
  const privateFile = join(root, 'synthetic private', 'secret.csv');
  writeFileSync(privateFile, 'synthetic restricted');
  symlinkSync(data, join(folder, 'escape'), 'junction');
  writeFileSync(join(folder, '.env'), 'synthetic credential fixture');
  writeFileSync(join(folder, '.git-credentials'), 'synthetic credential fixture');
  const notes = join(folder, '中文.json');
  writeFileSync(notes, '{"message":"合成資料"}');
  const book = join(folder, 'sample.xlsx');
  writeFileSync(book, workbook(workbookFixture()));
  const pdf = join(folder, 'sample.pdf');
  execFileSync(process.env.OEP_PYTHON || 'python', ['-I', '-c', [
    'import sys',
    'from pypdf import PdfWriter',
    'from pypdf.generic import DecodedStreamObject, NameObject, DictionaryObject',
    'writer = PdfWriter()',
    'page = writer.add_blank_page(300, 300)',
    'font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})',
    'page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})',
    'stream = DecodedStreamObject()',
    'stream.set_data(b"BT /F1 12 Tf 30 200 Td (Synthetic PDF text) Tj ET")',
    'page[NameObject("/Contents")] = writer._add_object(stream)',
    'writer.write(sys.argv[1])',
  ].join('\n'), pdf], { windowsHide: true });
  const database = join(data, 'web.sqlite');
  const store = new WebStore(database);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const session = { id: randomUUID(), upstreamID: 'synthetic-reference-first', agent: 'inspector' as const,
    alias: 'synthetic', createdAt: 1, project: 'default' as const };
  store.createSession(session);
  const other = { ...session, id: randomUUID(), upstreamID: 'synthetic-reference-other' };
  store.createSession(other);
  let accepted = true;
  const signal = AbortSignal.timeout(60_000);
  const references = new LocalReferences(store.references!, data, async (kind, locale, received) => {
    assert.equal(received, signal);
    assert.equal(locale, 'zh-TW');
    return accepted ? [kind === 'file' ? file : folder] : [];
  });
  const [large] = await references.pick(session.id, 'file', 'zh-TW', signal, () => true);
  assert.equal(large.identity.size, tail + 9);
  assert.equal(large.identity.sha256, undefined);
  assert.equal(store.attachmentBytes(session.id), 0);
  assert.deepEqual(store.attachments(session.id), []);
  assert.equal(references.get(other.id, large.id), undefined);
  await assert.rejects(() => references.read(other.id, large, { reference: large.id }), rejects('reference-changed'));
  assert.equal((await references.read(session.id, large, { reference: large.id, length: 5 })).text, 'first');
  const last = await references.read(session.id, large, { reference: large.id, offset: tail, length: 9 });
  assert.equal(last.text, 'last,row\n');
  assert.equal(last.next, null);
  assert.match(last.chunkSha256!, /^[a-f0-9]{64}$/);
  const [directory] = await references.pick(session.id, 'folder', 'zh-TW', signal, () => true);
  const page = await references.read(session.id, directory, { reference: directory.id, list: true });
  assert.deepEqual(page.entries?.map(({ name }) => name), ['big.csv', 'sample.pdf', 'sample.xlsx', '中文.json']);
  const read = (path: string) => references.read(session.id, directory, { reference: directory.id, path });
  assert.equal((await read('中文.json')).text, '{"message":"合成資料"}');
  assert.match((await read('sample.xlsx')).text!, /Sheet,/);
  assert.match((await read('sample.pdf')).text!, /Synthetic PDF text/);
  writeFileSync(notes, '{"message":"已變更"}');
  await assert.rejects(() => read('中文.json'), rejects('reference-changed'));
  const confirmed = await references.reconfirm(session.id, directory, () => true);
  assert.equal(confirmed.id, directory.id);
  assert.notEqual(confirmed.revision, directory.revision);
  assert.equal((await references.read(session.id, confirmed, { reference: confirmed.id, path: '中文.json' })).text,
    '{"message":"已變更"}');
  await assert.rejects(() => references.read(session.id, confirmed, { reference: confirmed.id, path: 'escape/secret.csv' }),
    rejects('reference-unavailable'));
  for (const rejected of [privateFile, root, join(system, 'kernel.fixture'), join(folder, 'escape', 'secret.csv'),
    join(folder, '.env'), join(folder, '.git-credentials'), '\\\\synthetic-host\\share\\file.csv', '\\\\?\\C:\\fixture.csv', file + ':alternate']) {
    await assert.rejects(() => references.attach(session.id, [rejected], () => true), rejects('reference-unavailable'));
  }
  if (root.toLowerCase() !== temporary.toLowerCase()) {
    await assert.rejects(() => references.attach(session.id, [join(temporary, 'synthetic allowed', 'big.csv')], () => true),
      rejects('reference-unavailable'));
  }
  const changed = openSync(file, 'r+');
  try { writeSync(changed, Buffer.from('other'), 0, 5, 0); }
  finally { closeSync(changed); }
  await assert.rejects(() => references.read(session.id, large, { reference: large.id, length: 5 }), rejects('reference-changed'));
  const classified = references.classify(session.id, confirmed, 'confidential');
  assert.equal(references.confidential(notes), true);
  store.addProjectFolder('default', folder);
  const external = new ExternalSources(store, { attachments: new AttachmentService(store), references, workspace: () => data }, data);
  const exportMember = () => external.register(session, { kind: 'workspace', folder: sha256(folder), path: 'big.csv' });
  assert.throws(exportMember, /external-confidential/);
  references.remove(session.id, classified);
  assert.equal(references.get(session.id, directory.id), undefined);
  assert.equal(references.confidential(notes), true);
  assert.throws(exportMember, /external-confidential/);
  await assert.rejects(() => references.read(session.id, classified, { reference: directory.id, list: true }), rejects('reference-changed'));
  accepted = false;
  assert.deepEqual(await references.pick(session.id, 'file', 'zh-TW', signal, () => true), []);
  assert.equal(references.list(session.id).length, 1);
  const audit = new DatabaseSync(database);
  try {
    const rows = audit.prepare('SELECT * FROM local_reference_audit').all();
    assert.ok(rows.some(({ event, chunk_hash }) => event === 'read' && chunk_hash === last.chunkSha256));
    assert.ok(rows.some(({ event }) => event === 'revoke'));
    assert.doesNotMatch(JSON.stringify(rows), /last,row|synthetic allowed|合成資料/);
  } finally { audit.close(); }
  assert.ok(readdirSync(data).every((name) => name.startsWith('web.sqlite') || name === 'secret.csv'));
});
