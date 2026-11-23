import { appendFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { maxUpload, uploadName, uploadType } from '../runs/attachments.ts';
import { WorkspacePathError } from '../runs/workspace.ts';
import type { ChatService } from './chat.ts';
import type { WebSession } from '../runs/web-store.ts';
import { header } from './auth.ts';
import { HttpError } from './errors.ts';

const clientUploadCodes = ['upload-client-file-read', 'upload-client-response', 'upload-client-unexpected'] as const;
type ClientUploadCode = typeof clientUploadCodes[number];
type ServerUploadCode = 'upload-storage-unavailable' | 'upload-storage-full' | 'upload-busy' | 'upload-incomplete';

function auditUpload(path: string, code: ClientUploadCode | ServerUploadCode | 'upload-unexpected') {
  const entry = JSON.stringify({ event: 'attachment-upload-failed', code, at: new Date().toISOString() });
  try { appendFileSync(path, entry + '\n', { mode: 0o600 }); }
  catch { console.error(entry); }
}

export function reportClientUpload(path: string, input: Record<string, unknown>) {
  const code = clientUploadCodes.find((code) => code === input.code);
  if (!code || Object.keys(input).length !== 1) throw new HttpError(400, 'invalid-json');
  auditUpload(path, code);
}

function uploadSystemError(error: unknown): { status: number; code: ServerUploadCode } | undefined {
  const { code, errcode } = error instanceof Error ? error as NodeJS.ErrnoException & { errcode?: number } : {};
  // Extended SQLite result codes retain the primary result in the low byte.
  const sqlite = code === 'ERR_SQLITE_ERROR' && errcode !== undefined ? errcode & 0xff : 0;
  if (code === 'ECONNRESET') return { status: 400, code: 'upload-incomplete' };
  if (sqlite === 5 || sqlite === 6) return { status: 429, code: 'upload-busy' };
  if (code === 'ENOSPC' || code === 'EDQUOT' || sqlite === 13) return { status: 507, code: 'upload-storage-full' };
  if (error instanceof WorkspacePathError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'EROFS', 'EIO'].includes(code ?? '') ||
      [8, 10, 14].includes(sqlite)) return { status: 503, code: 'upload-storage-unavailable' };
}

export function uploadFailure(error: unknown, audit: string) {
  if (error instanceof HttpError) return error;
  const known = uploadSystemError(error);
  auditUpload(audit, known?.code ?? 'upload-unexpected');
  return known ? new HttpError(known.status, known.code) : error;
}

export function upload(request: IncomingMessage, chat: ChatService, session: WebSession) {
  const rawLength = header(request, 'content-length');
  if (!/^\d{1,12}$/.test(rawLength) || header(request, 'transfer-encoding')) throw new HttpError(411, 'upload-length-required');
  const length = Number(rawLength);
  if (length > maxUpload) throw new HttpError(413, 'upload-too-large', { size: maxUpload / (1024 * 1024) });
  if (!length) throw new HttpError(400, 'upload-empty');
  if (header(request, 'content-encoding')) throw new HttpError(415, 'upload-encoding');
  const name = uploadName(header(request, 'x-oep-filename'));
  const mime = uploadType(name, header(request, 'content-type'));
  return chat.attachments.upload(session.id, chat.workspace(session), name, mime, length, async () => {
    const buffer = Buffer.alloc(length);
    let received = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (received + chunk.length > length) throw new HttpError(413, 'upload-length-mismatch');
      chunk.copy(buffer, received);
      received += chunk.length;
    }
    if (received !== length) throw new HttpError(400, 'upload-incomplete');
    return buffer;
  });
}

export function download(response: ServerResponse, chat: ChatService, session: WebSession, id: string) {
  const output = chat.download(session, id);
  sendDownload(response, output);
}

export function sendDownload(response: ServerResponse, output: { name: string; data: Buffer; sha256: string }, mime = 'application/octet-stream') {
  response.writeHead(200, {
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.name).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16))}`,
    'Content-Length': output.data.length,
    'X-OEP-SHA256': output.sha256,
  }).end(output.data);
}
