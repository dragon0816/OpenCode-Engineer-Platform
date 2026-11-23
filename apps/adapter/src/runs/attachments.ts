import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SessionPromptInput } from '@opencode/client';
import { atRepo } from '../../../launcher/src/paths.ts';
import { HttpError } from '../http/errors.ts';
import type { Attachment, WebStore } from './web-store.ts';
import { checkDirectory, openWorkspaceFile, scopedPath } from './workspace.ts';
import { writeWorkspaceFile } from './workspace-write.ts';

export const MiB = 1024 * 1024;
export const maxUpload = 20 * MiB;
const quota = 200 * MiB;
export const maxProjection = MiB;
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ff', 'hex');
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const isAttachmentImage = (mime: string) => imageTypes.has(mime);
const media = (mime: string) => isAttachmentImage(mime) || mime === 'application/pdf';
const files = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.pdf', 'application/pdf'],
  ['.xlsx', workbookType],
]);
const textExtensions = new Set([
  '.txt', '.md', '.csv', '.htm', '.json', '.jsonc', '.yaml', '.yml', '.xml', '.log', '.ini', '.cfg', '.conf', '.toml', '.tsv',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.c', '.h', '.cpp', '.hpp', '.cs', '.java', '.go', '.rs', '.ps1',
  '.sh', '.bat', '.sql', '.html', '.css', '.scpi', '.m',
]);
const textApplicationTypes = new Set([
  'application/json', 'application/jsonc', 'application/javascript', 'application/x-javascript', 'application/typescript',
  'application/xml', 'application/yaml', 'application/x-yaml', 'application/toml', 'application/sql',
  'application/x-python', 'application/x-powershell', 'application/x-sh', 'application/x-shellscript', 'application/x-bat',
]);

export const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const sourceName = (id: string) => `attachments/${id}.source`;
const projectionName = (id: string) => `attachments/${id}.csv`;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function uploadName(encoded: string) {
  let name: string;
  try { name = decodeURIComponent(encoded); }
  catch { throw new HttpError(400, 'filename-invalid'); }
  if (!name || name !== name.trim() || name.length > 150 || name.includes('..') ||
      /[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new HttpError(400, 'filename-invalid');
  return name;
}

export function uploadType(name: string, declared: string) {
  const extension = extname(name).toLowerCase();
  const input = declared.split(';')[0].trim().toLowerCase();
  const generic = input === 'application/octet-stream';
  // File pickers can report these extensions using their Windows media or executable associations.
  const ambiguous = extension === '.ts' && input === 'video/mp2t' || extension === '.bat' && input === 'application/x-msdownload';
  if (textExtensions.has(extension) && (generic || input.startsWith('text/') || textApplicationTypes.has(input) || ambiguous)) return 'text/plain';
  const mime = files.get(extension);
  if (mime && (generic || input === mime)) return mime;
  throw new HttpError(415, 'attachment-type');
}

function decodeText(bytes: Buffer) {
  try {
    const value = textDecoder.decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Invalid text');
    return value;
  } catch { throw new HttpError(422, 'attachment-text-encoding'); }
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
      if (error) reject(new HttpError(422, error.killed ? 'excel-conversion-limit' :
        'excel-conversion-unavailable'));
      else resolve(output);
    });
    worker.stdin?.on('error', () => { /* The worker exit controls the result. */ });
    worker.stdin?.end(data);
  });
}

export function validateAttachment(data: Buffer, mime: string) {
  if (mime === 'text/plain' || mime === 'text/html') decodeText(data);
  else if (mime === 'image/png' && (!startsWith(data, png) || data.subarray(12, 16).toString() !== 'IHDR') ||
    mime === 'image/jpeg' && !startsWith(data, jpeg) ||
    mime === 'image/gif' && !(startsWith(data, 'GIF87a') || startsWith(data, 'GIF89a')) ||
    mime === 'image/webp' && !(startsWith(data, 'RIFF') && data.subarray(8, 12).toString() === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(data.subarray(12, 16).toString())) ||
    mime === 'application/pdf' && !startsWith(data, '%PDF-') ||
    mime === workbookType && !startsWith(data, Buffer.from('504b0304', 'hex'))) {
    throw new HttpError(415, 'attachment-type-mismatch');
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

  importVerified(sessionID: string, workspace: string, record: Pick<Attachment, 'name' | 'mime'>, data: Buffer, projection?: Buffer) {
    const id = randomUUID();
    const root = scopedPath(workspace, 'attachments');
    const folder = { root, inode: String(checkDirectory(root).ino) };
    const original = writeWorkspaceFile(folder, `${id}.source`, data, maxUpload, 'copy');
    const converted = projection && writeWorkspaceFile(folder, `${id}.csv`, projection, maxProjection, 'copy');
    this.store.saveAttachment(sessionID, { id, ...record, original, projection: converted });
    return id;
  }

  async upload(sessionID: string, workspace: string, name: string, mime: string, bytes: number, body: () => Promise<Buffer>, ownerUpload = true) {
    if (this.pending >= 3) throw new HttpError(429, 'upload-busy');
    if (this.store.attachmentBytes(sessionID) + bytes > quota) throw new HttpError(413, 'session-storage-full');
    this.pending++;
    try {
      const data = await body();
      validateAttachment(data, mime);
      const projection = mime === workbookType ? await convertWorkbook(data) : undefined;
      if (this.store.attachmentBytes(sessionID) + data.length + (projection?.length ?? 0) > quota) {
        throw new HttpError(413, 'session-storage-full');
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
        this.store.saveAttachment(sessionID, record, ownerUpload);
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
    if (!record) throw new HttpError(404, 'session-attachment-not-found');
    const projection = preview && record.projection;
    const identity = projection || record.original;
    try {
      const { data } = openWorkspaceFile(workspace, projection ? projectionName(id) : sourceName(id),
        preview && !media(record.mime) ? maxProjection : maxUpload, identity);
      return { data, name: record.name, sha256: identity.sha256, mime: projection ? 'text/plain' : record.mime };
    } catch { throw new HttpError(409, 'attachment-preview-unavailable'); }
  }

  remove(sessionID: string, workspace: string, id: string) {
    if (!this.store.deleteAttachment(sessionID, id)) throw new HttpError(404, 'session-attachment-not-found');
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
    for (const { record, data, projection, decoded } of this.verifiedSelection(sessionID, workspace, references)) {
      if (decoded === undefined) parts.push({ uri: `data:${record.mime};base64,${data.toString('base64')}`, name: record.name });
      else text.push(`Attachment ${JSON.stringify(record.name)} (${projection ? 'sheet/row CSV' : 'UTF-8 text'}):\n${decoded}`);
    }
    return { files: parts, text: text.join('\n\n') };
  }

  *verifiedSelection(sessionID: string, workspace: string, references: readonly string[]) {
    let mediaBytes = 0;
    let textBytes = 0;
    for (const id of references) {
      const record = this.store.attachment(sessionID, id);
      if (!record) throw new HttpError(404, 'session-attachment-not-found');
      try {
        const { data } = openWorkspaceFile(workspace, sourceName(id), maxUpload, record.original);
        let projection: Buffer | undefined;
        let decoded: string | undefined;
        if (media(record.mime)) {
          mediaBytes += data.length;
          if (mediaBytes > 40 * MiB) throw new HttpError(413, 'message-media-limit');
        } else {
          projection = record.projection && openWorkspaceFile(workspace, projectionName(id), maxProjection, record.projection).data;
          const bytes = projection ?? data;
          textBytes += bytes.length;
          if (textBytes > maxProjection) throw new HttpError(413, 'message-text-limit');
          decoded = decodeText(bytes);
        }
        yield { record, data, projection, decoded };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, 'attachment-changed');
      }
    }
  }
}
