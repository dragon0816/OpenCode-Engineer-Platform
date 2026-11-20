import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until<T>(operation: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = performance.now() + ms;
  do {
    const result = await operation();
    if (result !== undefined) return result;
    await pause(100);
  } while (performance.now() < deadline);
  throw new Error('deadline');
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
