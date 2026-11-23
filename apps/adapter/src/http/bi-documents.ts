import type { IncomingMessage } from 'node:http';
import { biDocumentFile, documentFileLimit } from '../bi/document-extraction.ts';
import { uploadName } from '../runs/attachments.ts';
import { header } from './auth.ts';
import { HttpError } from './errors.ts';

export async function receiveBiDocument(request: IncomingMessage) {
  const declared = header(request, 'content-length');
  const length = Number(declared);
  if (!/^\d{1,8}$/.test(declared) || header(request, 'transfer-encoding')) throw new HttpError(411, 'upload-length-required');
  if (length > documentFileLimit) throw new HttpError(413, 'upload-too-large', { size: documentFileLimit / (1024 * 1024) });
  if (!length) throw new HttpError(400, 'upload-empty');
  if (header(request, 'content-encoding')) throw new HttpError(415, 'upload-encoding');
  const ref = uploadName(header(request, 'x-oep-filename'));
  if (!biDocumentFile(ref)) throw new HttpError(415, 'bi-document-format');
  const bytes = Buffer.alloc(length);
  let received = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (received + chunk.length > length) throw new HttpError(413, 'upload-length-mismatch');
    received += chunk.copy(bytes, received);
  }
  if (received !== length) throw new HttpError(400, 'upload-incomplete');
  return { ref, bytes };
}
