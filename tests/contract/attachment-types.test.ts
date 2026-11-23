import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HttpError } from '../../apps/adapter/src/http/errors.ts';
import { uploadType, validateAttachment } from '../../apps/adapter/src/runs/attachments.ts';

const extensions = [
  'txt', 'md', 'csv', 'htm', 'json', 'jsonc', 'yaml', 'yml', 'xml', 'log', 'ini', 'cfg', 'conf', 'toml', 'tsv',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs', 'ps1',
  'sh', 'bat', 'sql', 'html', 'css', 'scpi', 'm',
];
const failure = (status: number, code: string) => (error: unknown) =>
  error instanceof HttpError && error.status === status && error.detail.code === code;

test('engineering attachment extensions are offered by the picker and validated as UTF-8 text', () => {
  const page = readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
  const allowed = page.match(/id="file-input"[^>]+accept="([^"]+)"/)?.[1].split(',');
  for (const extension of extensions) {
    assert.ok(allowed?.includes('.' + extension), extension);
    const mime = uploadType(`sample.${extension.toUpperCase()}`, 'application/octet-stream');
    assert.equal(mime, 'text/plain', extension);
    assert.doesNotThrow(() => validateAttachment(Buffer.from('合成\ttext\r\n'), mime), extension);
    assert.throws(() => validateAttachment(Buffer.from([0xff, 0xfe]), mime), failure(422, 'attachment-text-encoding'));
    assert.throws(() => validateAttachment(Buffer.from('PK\u0003\u0004'), mime), failure(422, 'attachment-text-encoding'));
  }
  for (const [name, type] of [
    ['tsconfig.json', 'Application/JSON; charset=utf-8'], ['sample.py', 'text/x-python'], ['sample.html', 'text/html'],
    ['sample.ts', 'video/mp2t'], ['sample.bat', 'application/x-msdownload'], ['sample.xml', 'application/xml'],
  ]) assert.equal(uploadType(name, type), 'text/plain');
});

test('binary uploads keep their original MIME and signature rules', () => {
  assert.equal(uploadType('sample.png', 'application/octet-stream'), 'image/png');
  assert.equal(uploadType('sample.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => uploadType('sample.json', 'image/png'), failure(415, 'attachment-type'));
  assert.throws(() => uploadType('sample.bin', 'text/plain'), failure(415, 'attachment-type'));
  assert.throws(() => uploadType('sample.png', 'text/plain'), failure(415, 'attachment-type'));
  assert.throws(() => validateAttachment(Buffer.from('plain text'), 'image/png'), failure(415, 'attachment-type-mismatch'));
});
