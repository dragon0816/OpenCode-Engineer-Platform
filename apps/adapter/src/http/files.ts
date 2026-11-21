import type { IncomingMessage, ServerResponse } from 'node:http';
import { maxUpload, uploadName, uploadType } from '../runs/attachments.ts';
import type { ChatService } from './chat.ts';
import type { WebSession } from '../runs/web-store.ts';
import { header } from './auth.ts';
import { HttpError } from './errors.ts';

export function upload(request: IncomingMessage, chat: ChatService, session: WebSession) {
  const rawLength = header(request, 'content-length');
  if (!/^\d{1,12}$/.test(rawLength) || header(request, 'transfer-encoding')) throw new HttpError(411, 'A file length is required');
  const length = Number(rawLength);
  if (length > maxUpload) throw new HttpError(413, 'File exceeds 20 MiB');
  if (!length) throw new HttpError(400, 'Empty file');
  if (header(request, 'content-encoding')) throw new HttpError(415, 'Encoded upload bodies are unsupported');
  const name = uploadName(header(request, 'x-oep-filename'));
  const mime = uploadType(name, header(request, 'content-type'));
  return chat.attachments.upload(session.id, chat.workspace(session), name, mime, length, async () => {
    const buffer = Buffer.alloc(length);
    let received = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (received + chunk.length > length) throw new HttpError(413, 'File exceeds its declared length');
      chunk.copy(buffer, received);
      received += chunk.length;
    }
    if (received !== length) throw new HttpError(400, 'Incomplete upload');
    return buffer;
  });
}

export function download(response: ServerResponse, chat: ChatService, session: WebSession, id: string) {
  const output = chat.download(session, id);
  sendDownload(response, output);
}

export function sendDownload(response: ServerResponse, output: { name: string; data: Buffer; sha256: string }) {
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.name).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16))}`,
    'Content-Length': output.data.length,
    'X-OEP-SHA256': output.sha256,
  }).end(output.data);
}
