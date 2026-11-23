import { execFile } from 'node:child_process';
import { atRepo } from '../../../launcher/src/paths.ts';

export type Segment = { locator: string; text: string };
export type Projection = { sha256: string; title: string; segments: Segment[] };
export type Chunk = { id: string; text: string }[];
export type Plan = { prompt: string; chunks: Chunk[] };
export type SchemaStructure = { id: string; version: string; fields: string[] };
export type WorkerIssue = 'ocr' | 'pdf-unavailable' | 'pdf-encrypted' | 'limit' | 'encoding' | 'empty' | 'invalid';
const workerIssues = new Set(['ocr', 'pdf-unavailable', 'pdf-encrypted', 'limit', 'encoding', 'empty', 'invalid']);
export class DocumentWorkerError extends Error {
  readonly issue: WorkerIssue;
  constructor(issue: WorkerIssue) { super(issue); this.issue = issue; }
}

export function documentWorker<T>(args: string[], input: Buffer, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = execFile(process.env.OEP_PYTHON || 'python', ['-I', '-B', atRepo('workers/bi/worker.py'), ...args], {
      windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH },
    }, (error, output) => {
      if (error) {
        reject(signal.aborted ? signal.reason : new DocumentWorkerError(error.killed ? 'limit' : 'invalid'));
        return;
      }
      try {
        const payload = JSON.parse(output) as { result?: T; error?: WorkerIssue };
        if (payload.result !== undefined) resolve(payload.result);
        else reject(new DocumentWorkerError(payload.error && workerIssues.has(payload.error) ? payload.error : 'invalid'));
      } catch { reject(new DocumentWorkerError('invalid')); }
    });
    worker.stdin?.on('error', () => { /* The worker exit controls the result. */ });
    worker.stdin?.end(input);
  });
}
