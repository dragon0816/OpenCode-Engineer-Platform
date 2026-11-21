import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SessionPromptInput } from '@opencode/client';
import { atRepo } from '../../../launcher/src/paths.ts';
import { HttpError } from '../http/errors.ts';
import type { Attachment, WebStore } from './web-store.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';

export const MiB = 1024 * 1024;
export const maxUpload = 20 * MiB;
const quota = 200 * MiB;
const maxProjection = MiB;
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ff', 'hex');
const media = (mime: string) => mime === 'image/png' || mime === 'image/jpeg' || mime === 'application/pdf';
const files = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.pdf', 'application/pdf'],
  ['.xlsx', workbookType], ['.txt', 'text/plain'], ['.md', 'text/plain'], ['.csv', 'text/plain'],
  ['.html', 'text/html'], ['.htm', 'text/html'],
]);

export const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const sourceName = (id: string) => `attachments/${id}.source`;
const projectionName = (id: string) => `attachments/${id}.csv`;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function uploadName(encoded: string) {
  let name: string;
  try { name = decodeURIComponent(encoded); }
  catch { throw new HttpError(400, 'Invalid filename'); }
  if (!name || name !== name.trim() || name.length > 150 || name.includes('..') ||
      /[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new HttpError(400, 'Invalid filename');
  return name;
}

export function uploadType(name: string, declared: string) {
  const mime = files.get(extname(name).toLowerCase());
  const input = declared.split(';')[0].trim().toLowerCase();
  const text = mime === 'text/plain' && ['text/plain', 'text/csv', 'text/markdown'].includes(input);
  if (!mime || !(input === mime || input === 'application/octet-stream' || text)) {
    throw new HttpError(415, 'Unsupported file type');
  }
  return mime;
}

function decodeText(bytes: Buffer) {
  try {
    const value = textDecoder.decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Invalid text');
    return value;
  } catch { throw new HttpError(422, 'Text attachments must contain UTF-8 text'); }
}

function startsWith(data: Buffer, signature: Buffer | string) {
  const expected = Buffer.from(signature);
  return data.subarray(0, expected.length).equals(expected);
}

export function convertWorkbook(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = execFile(process.env.OEP_PYTHON || 'python', ['-I', atRepo('workers/office/xlsx_to_text.py')], {
      windowsHide: true, timeout: 10_000, maxBuffer: maxProjection + 4096, encoding: 'buffer',
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
    }, (error, output) => {
      if (error) reject(new HttpError(422, error.killed ? 'Excel conversion timed out or exceeded its output limit' :
        'Unsupported XLSX, conversion limit exceeded, or Python unavailable'));
      else resolve(output);
    });
    worker.stdin?.on('error', () => { /* The worker exit controls the result. */ });
    worker.stdin?.end(data);
  });
}

function validate(data: Buffer, mime: string) {
  if (mime === 'text/plain' || mime === 'text/html') decodeText(data);
  else if (mime === 'image/png' && (!startsWith(data, png) || data.subarray(12, 16).toString() !== 'IHDR') ||
    mime === 'image/jpeg' && !startsWith(data, jpeg) ||
    mime === 'application/pdf' && !startsWith(data, '%PDF-') ||
    mime === workbookType && !startsWith(data, Buffer.from('504b0304', 'hex'))) {
    throw new HttpError(415, 'File contents do not match the declared type');
  }
}

export function publicAttachment(record: Attachment) {
  return { id: record.id, name: record.name, mime: record.mime, bytes: record.original.bytes,
    createdAt: Number(BigInt(record.original.created) / 1_000_000n), sha256: record.original.sha256, converted: Boolean(record.projection), projectionSha256: record.projection?.sha256 };
}

export class AttachmentService {
  private pending = 0;
  private readonly store: WebStore;

  constructor(store: WebStore) { this.store = store; }

  async upload(sessionID: string, workspace: string, name: string, mime: string, bytes: number, body: () => Promise<Buffer>) {
    if (this.pending >= 3) throw new HttpError(429, 'Uploads are busy. Try again shortly');
    if (this.store.attachmentBytes(sessionID) + bytes > quota) throw new HttpError(413, 'Session workspace quota exceeded');
    this.pending++;
    try {
      const data = await body();
      validate(data, mime);
      const projection = mime === workbookType ? await convertWorkbook(data) : undefined;
      if (this.store.attachmentBytes(sessionID) + data.length + (projection?.length ?? 0) > quota) {
        throw new HttpError(413, 'Session workspace quota exceeded');
      }
      const id = randomUUID();
      const paths: string[] = [];
      checkDirectory(join(workspace, 'attachments'));
      const save = (name: string, bytes: Buffer) => {
        const path = scopedPath(workspace, name);
        const temporary = scopedPath(workspace, `attachments/staging-${randomUUID()}.tmp`);
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        paths.push(temporary);
        renameSync(temporary, path);
        paths[paths.length - 1] = path;
        return openWorkspaceFile(workspace, name, maxUpload).identity;
      };
      try {
        const original = save(sourceName(id), data);
        const converted = projection ? save(projectionName(id), projection) : undefined;
        const record = { id, name, mime, original, projection: converted };
        this.store.saveAttachment(sessionID, record);
        return publicAttachment(record);
      } catch (error) {
        try {
          checkDirectory(join(workspace, 'attachments'));
          for (const path of paths) unlinkSync(path);
        } catch { /* Startup removes unreferenced files. */ }
        throw error;
      }
    } finally { this.pending--; }
  }

  read(sessionID: string, workspace: string, id: string, preview: boolean) {
    const record = this.store.attachment(sessionID, id);
    if (!record) throw new HttpError(404, 'Attachment not found in this session');
    const projection = preview && record.projection;
    const identity = projection || record.original;
    try {
      const { data } = openWorkspaceFile(workspace, projection ? projectionName(id) : sourceName(id),
        preview && !media(record.mime) ? maxProjection : maxUpload, identity);
      return { data, name: record.name, sha256: identity.sha256, mime: projection ? 'text/plain' : record.mime };
    } catch { throw new HttpError(409, 'Attachment is missing, too large to preview, or has changed'); }
  }

  remove(sessionID: string, workspace: string, id: string) {
    if (!this.store.deleteAttachment(sessionID, id)) throw new HttpError(404, 'Attachment not found in this session');
    try { this.clean(sessionID, workspace); }
    catch { /* Startup retries cleanup of unreferenced files. */ }
  }

  clean(sessionID: string, workspace: string) {
    const folder = join(workspace, 'attachments');
    checkDirectory(folder);
    for (const name of readdirSync(folder)) {
      const [id, extension] = name.split('.');
      if (/^staging-[a-f\d-]+\.tmp$/.test(name) ||
          uuid.test(id) && name === `${id}.${extension}` && ['source', 'csv'].includes(extension) &&
          !this.store.attachment(sessionID, id)) unlinkSync(scopedPath(workspace, `attachments/${name}`));
    }
  }

  prompt(sessionID: string, workspace: string, references: string[]) {
    const parts: NonNullable<SessionPromptInput['files']>[number][] = [];
    const text: string[] = [];
    let mediaBytes = 0;
    let textBytes = 0;
    for (const id of references) {
      const record = this.store.attachment(sessionID, id);
      if (!record) throw new HttpError(404, 'Attachment not found in this session');
      try {
        const { data } = openWorkspaceFile(workspace, sourceName(id), maxUpload, record.original);
        if (media(record.mime)) {
          mediaBytes += data.length;
          if (mediaBytes > 40 * MiB) throw new HttpError(413, 'Media in one message exceeds 40 MiB');
          parts.push({ uri: `data:${record.mime};base64,${data.toString('base64')}`, name: record.name });
        } else {
          const bytes = record.projection ?
            openWorkspaceFile(workspace, projectionName(id), maxProjection, record.projection).data : data;
          textBytes += bytes.length;
          if (textBytes > maxProjection) throw new HttpError(413, 'Text in one message exceeds 1 MiB. Select a smaller document');
          text.push(`Attachment ${JSON.stringify(record.name)} (${record.projection ? 'sheet/row CSV' : 'UTF-8 text'}):\n${decodeText(bytes)}`);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, 'Attachment is missing or has changed. Upload it again');
      }
    }
    return { files: parts, text: text.join('\n\n') };
  }
}
