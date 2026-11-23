import { spawn } from 'node:child_process';
import { atRepo } from '../../../launcher/src/paths.ts';
import { ocrFrameLimit } from './document-ocr.ts';
import type { DocumentOcr, OcrProvenance } from './document-ocr.ts';
import type { OcrLine } from './windows-ocr.ts';

export type Segment = { locator: string; text: string; ocr?: OcrProvenance; lines?: OcrLine[]; width?: number; height?: number };
export type PageStatus = { locator: string; status: 'text-layer' | 'local' | 'model' | 'failed'; ocr?: OcrProvenance; warning?: string };
export type Projection = { sha256: string; title: string; segments: Segment[]; pages?: PageStatus[] };
export type Chunk = { id: string; text: string }[];
export type Plan = { prompt: string; chunks: Chunk[] };
export type SchemaStructure = { id: string; version: string; fields: string[] };
export type WorkerIssue = 'ocr' | 'pdf-unavailable' | 'pdf-encrypted' | 'limit' | 'encoding' | 'empty' | 'invalid';
const workerIssues = new Set(['ocr', 'pdf-unavailable', 'pdf-encrypted', 'limit', 'encoding', 'empty', 'invalid']);
export class DocumentWorkerError extends Error {
  readonly issue: WorkerIssue;
  constructor(issue: WorkerIssue) { super(issue); this.issue = issue; }
}

export function documentResult<T>(value: unknown): T {
  const payload = value as { result?: T; error?: WorkerIssue } | null;
  if (payload?.result !== undefined) return payload.result;
  throw new DocumentWorkerError(payload?.error && workerIssues.has(payload.error) ? payload.error : 'invalid');
}

export async function documentWorker<T>(args: string[], input: Buffer, parent: AbortSignal, recognize?: DocumentOcr) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(recognize ? 600_000 : 10_000)]);
  signal.throwIfAborted();
  const worker = spawn(process.env.OEP_PYTHON || 'python', ['-I', '-B', atRepo('workers/bi/worker.py'), ...args], {
    windowsHide: true, signal, stdio: ['pipe', 'pipe', 'ignore'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
  });
  const exited = new Promise<number | null>(resolve => worker.once('close', resolve));
  worker.on('error', () => { /* The exit code controls the result. */ });
  worker.stdin.on('error', () => { /* The exit code controls the result. */ });
  const send = (value: unknown) => worker.stdin.write(JSON.stringify(value) + '\n');
  send({ base64: input.toString('base64') });
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let result: unknown;
  let sequence = 0;
  try {
    for await (const piece of worker.stdout as AsyncIterable<Buffer>) {
      signal.throwIfAborted();
      buffer = Buffer.concat([buffer, piece]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (result !== undefined || newline > ocrFrameLimit) throw new DocumentWorkerError('invalid');
        const frame = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        buffer = buffer.subarray(newline + 1);
        if (Object.hasOwn(frame, 'result') && newline <= 2 * 1024 * 1024) {
          result = frame.result;
          worker.stdin.end();
        } else if (recognize && frame.method === 'bi.ocr' && frame.jsonrpc === '2.0' && frame.id === ++sequence && sequence <= 120) {
          send({ id: sequence, result: await recognize(frame.params, signal) });
        } else throw new DocumentWorkerError('invalid');
      }
      if (buffer.length > ocrFrameLimit) throw new DocumentWorkerError('limit');
    }
    const code = await exited;
    signal.throwIfAborted();
    if (code !== 0 || buffer.length) throw new DocumentWorkerError('invalid');
    return documentResult<T>(result);
  } catch (error) {
    parent.throwIfAborted();
    throw error instanceof DocumentWorkerError ? error : new DocumentWorkerError(signal.aborted ? 'limit' : 'invalid');
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await exited;
  }
}
