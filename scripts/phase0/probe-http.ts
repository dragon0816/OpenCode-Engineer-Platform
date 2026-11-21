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

export function isConnectionError(error: unknown) {
  return error instanceof Error && 'code' in error && [
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ].some((code) => error.code === code);
}

export function transportCause(error: unknown): unknown {
  if (error instanceof Error && error.name === 'ClientError' && 'reason' in error && error.reason === 'Transport') error = error.cause;
  return error;
}

export function turnFailure(error: unknown) {
  error = transportCause(error);
  if (error instanceof ProbeDeadlineError) return 'deadline';
  if (error instanceof ProbeTransportError) return 'transport-error';
  throw error;
}

export function retryReadiness(error: unknown) {
  const cause = transportCause(error);
  if (cause instanceof ProbeTransportError || cause instanceof DOMException && cause.name === 'TimeoutError') return undefined;
  throw error;
}

export async function finishFailedTurn(error: unknown, interrupt: (signal: AbortSignal) => Promise<unknown>) {
  const cleanup = new AbortController();
  const timeout = new ProbeDeadlineError();
  const timer = setTimeout(() => cleanup.abort(timeout), 6000);
  try {
    await interrupt(cleanup.signal);
  } catch (cleanupError) {
    if (transportCause(cleanupError) !== timeout) throw new AggregateError([error, cleanupError], 'Turn and interrupt both failed');
  } finally { clearTimeout(timer); }
  return turnFailure(error);
}

export async function waitForExit<T>(finished: Promise<T>, ms: number) {
  const timeout = Promise.withResolvers<null>();
  const timer = setTimeout(() => timeout.resolve(null), ms);
  try { return await Promise.race([finished, timeout.promise]); }
  finally { clearTimeout(timer); }
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
        if (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason) signal.throwIfAborted();
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
    if (length > maxBytes) throw new ProbeInputError('body limit');
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
    void handler(request, response).catch((error: unknown) => {
      if (!(error instanceof SyntaxError || error instanceof ProbeInputError || error instanceof ProbeTransportError || isConnectionError(error))) {
        // Handler defects fail the probe without printing request data or arbitrary errors.
        process.exitCode = 1;
        console.error('Unexpected Phase 0 HTTP handler failure');
      }
      if (response.headersSent) response.destroy();
      else send(response, 502, { error: { message: 'Probe transport failed' } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close() { server.closeAllConnections(); server.close(); },
  };
}

class ProbeInputError extends Error {}

export async function* sse(body: ReadableStream<Uint8Array>, close?: AbortSignal) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = '';
  let cancelOnExit = true;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation = reader.cancel();
    // The original cancellation is awaited in finally, including any error from the stream.
    void cancellation.catch(() => undefined);
  };
  if (close?.aborted) cancel();
  else close?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      cancelOnExit = false;
      const { value, done } = await reader.read();
      if (done) return;
      cancelOnExit = true;
      pending += decoder.decode(value, { stream: true });
      for (let line = pending.indexOf('\n'); line !== -1; line = pending.indexOf('\n')) {
        const content = pending.slice(0, line).trimEnd();
        pending = pending.slice(line + 1);
        if (content.startsWith('data:')) yield content.slice(5).trimStart();
      }
      if (pending.length > 1024 * 1024) throw new Error('event limit');
    }
  } finally {
    close?.removeEventListener('abort', cancel);
    try {
      if (cancellation) await cancellation;
      else if (cancelOnExit) await reader.cancel();
    }
    finally { reader.releaseLock(); }
  }
}

export function subscribeEventStream(connect: (signal: AbortSignal) => Promise<Response>, deadline: AbortSignal,
  receive: (event: { type: string; data?: { sessionID?: string } }) => void) {
  const abort = new AbortController();
  const handshake = new AbortController();
  const signal = AbortSignal.any([deadline, handshake.signal]);
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const closedByProbe = new Error('SSE closed by probe');
  let connected = false;
  let reading = false;
  const abortStream = () => ended.reject(deadline.reason);
  if (deadline.aborted) abortStream();
  else deadline.addEventListener('abort', abortStream, { once: true });

  const work = (async () => {
    const response = await connect(signal);
    if (!response.ok || !response.body) throw new ProbeTransportError('SSE response refused');
    reading = true;
    for await (const data of sse(response.body, abort.signal)) {
      signal.throwIfAborted();
      const event = JSON.parse(data) as { type: string; data?: { sessionID?: string } };
      if (event.type === 'server.connected') { connected = true; ready.resolve(); continue; }
      receive(event);
    }
    if (!abort.signal.aborted) throw new ProbeTransportError(connected ? 'SSE ended before reconciliation' : 'SSE ended before server.connected');
    if (!connected) ready.reject(closedByProbe);
  })();
  const completed = Promise.race([work, ended.promise]).catch((error: unknown) => {
    if (!connected) ready.reject(error);
    if (error !== closedByProbe && !(error instanceof Error && error.name === 'AbortError' && error.cause === closedByProbe)) throw error;
  }).finally(() => deadline.removeEventListener('abort', abortStream));
  // Either promise can settle before the caller attaches its await. Keep the original rejection observable.
  void ready.promise.catch(() => undefined);
  void completed.catch(() => undefined);
  const during = <T>(operation: Promise<T>) => Promise.race([operation, completed.then(() => { throw closedByProbe; })]);
  const close = () => {
    abort.abort(closedByProbe);
    if (!reading) handshake.abort(closedByProbe);
  };
  return { ready: ready.promise, close, completed, during };
}
