import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ProbeDeadlineError extends Error {
  constructor() { super('Probe deadline expired'); }
}

export class ProbeTransportError extends Error {
  constructor(message = 'Probe HTTP transport failed') { super(message); }
}

export function turnFailure(error: unknown) {
  if (error instanceof Error && error.name === 'ClientError' && 'reason' in error && error.reason === 'Transport') error = error.cause;
  if (error instanceof ProbeDeadlineError) return 'deadline';
  if (error instanceof ProbeTransportError) return 'transport-error';
  throw error;
}

export async function until<T>(operation: (signal: AbortSignal) => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = new AbortController();
  const signal = deadline.signal;
  const timer = setTimeout(() => deadline.abort(new ProbeDeadlineError()), ms);
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await operation(signal);
      signal.throwIfAborted();
      if (result !== undefined) return result;
      await delay(100, undefined, { signal }).catch((error) => {
        signal.throwIfAborted();
        throw error;
      });
    }
  } finally { clearTimeout(timer); }
}

export async function jsonInput<T>(request: IncomingMessage, maxBytes = 512 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) throw new Error('body limit');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function send(response: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) response.writeHead(status).end();
  else response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 502, { error: { message: 'Probe transport failed' } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close() { server.closeAllConnections(); server.close(); },
  };
}

export async function* sse(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      for (let line = pending.indexOf('\n'); line !== -1; line = pending.indexOf('\n')) {
        const content = pending.slice(0, line).trimEnd();
        pending = pending.slice(line + 1);
        if (content.startsWith('data:')) yield content.slice(5).trimStart();
      }
      if (pending.length > 1024 * 1024) throw new Error('event limit');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function subscribeEventStream(connect: (signal: AbortSignal) => Promise<Response>, deadline: AbortSignal,
  receive: (event: { type: string; data?: { sessionID?: string } }) => void) {
  const abort = new AbortController();
  const signal = AbortSignal.any([deadline, abort.signal]);
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  let connected = false;
  const abortStream = () => ended.reject(signal.reason);
  if (signal.aborted) abortStream();
  else signal.addEventListener('abort', abortStream, { once: true });

  const work = (async () => {
    const response = await connect(signal);
    if (!response.ok || !response.body) throw new ProbeTransportError('SSE response refused');
    for await (const data of sse(response.body)) {
      signal.throwIfAborted();
      const event = JSON.parse(data) as { type: string; data?: { sessionID?: string } };
      if (event.type === 'server.connected') { connected = true; ready.resolve(); continue; }
      receive(event);
    }
    if (!connected) throw new ProbeTransportError('SSE ended before server.connected');
  })();
  const completed = Promise.race([work, ended.promise]).catch((error) => {
    if (!connected) ready.reject(error);
    if (!abort.signal.aborted || deadline.aborted) throw error;
  }).finally(() => signal.removeEventListener('abort', abortStream));
  void ready.promise.catch(() => {});
  void completed.catch(() => {});
  return { ready: ready.promise, close: () => abort.abort(), completed };
}
