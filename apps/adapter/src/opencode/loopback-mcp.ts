import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jsonInput, send } from '../../../../scripts/phase0/probe-http.ts';

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26'];

export async function startLoopbackMcp(options: {
  name: string; tools: unknown[]; timeout: number; invalidArguments: string; failed: string;
  invoke: (name: unknown, args: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
}) {
  const key = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${key}`);
  const stopped = new AbortController();
  let host: string;
  const server = createServer({ requestTimeout: 8000, headersTimeout: 5000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const credential = Buffer.from(request.headers.authorization ?? '');
    if (request.headers.host !== host || request.headers.origin !== undefined ||
        credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' ||
        request.headers['content-encoding'] !== undefined) {
      response.writeHead(415).end();
      return;
    }
    let id: string | number | null = null;
    const rpcError = (code: number, message: string) => send(response, 200, { jsonrpc: '2.0', id, error: { code, message } });
    try {
      const input = await jsonInput<{ id?: unknown; jsonrpc?: unknown; method?: unknown; params?: unknown }>(request, 16 * 1024);
      if (typeof input?.id === 'string' || typeof input?.id === 'number') id = input.id;
      if (input?.jsonrpc !== '2.0' || typeof input.method !== 'string') return rpcError(-32600, 'Invalid request');
      if (id === null) { response.writeHead(202).end(); return; }
      const reply = (result: unknown) => send(response, 200, { jsonrpc: '2.0', id, result });
      switch (input.method) {
        case 'initialize': {
          const { protocolVersion } = (input.params ?? {}) as { protocolVersion?: string };
          reply({ protocolVersion: protocolVersion && supportedVersions.includes(protocolVersion) ? protocolVersion : supportedVersions[0],
            capabilities: { tools: {} }, serverInfo: { name: options.name, version: '1.0.0' } });
          return;
        }
        case 'ping': reply({}); return;
        case 'tools/list':
          reply({ tools: options.tools });
          return;
        case 'tools/call': {
          const params = input.params as { name?: unknown; arguments?: unknown } | undefined;
          const client = new AbortController();
          response.once('close', () => client.abort());
          const result = await options.invoke(params?.name, params?.arguments, AbortSignal.any([client.signal, stopped.signal]));
          if (!result) return rpcError(-32602, options.invalidArguments);
          if (!response.destroyed) reply(result);
          return;
        }
        default: return rpcError(-32601, 'Method unavailable');
      }
    } catch { if (!response.destroyed && !response.headersSent) rpcError(-32603, options.failed); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      host = `127.0.0.1:${port}`;
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    config: { type: 'remote', url: `http://${host!}/mcp`, headers: { Authorization: `Bearer ${key}` },
      oauth: false, codemode: false, timeout: { execution: options.timeout } } as const,
    close: () => {
      stopped.abort();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
