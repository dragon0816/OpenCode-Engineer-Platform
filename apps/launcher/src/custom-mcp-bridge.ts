import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { objectRecord } from '../../adapter/src/opencode/tool-transport.ts';
import type { CustomStdioMcp } from '../../adapter/src/runs/custom-mcp.ts';
import type { CredentialEnvironment } from '../../adapter/src/runs/custom-mcp-credentials.ts';
import { mcpExecutableIdentity } from '../../adapter/src/runs/mcp-trust.ts';
import { startJob } from './job-object.ts';

export async function startCustomMcpBridge(definition: CustomStdioMcp, readCredentials?: CredentialEnvironment['readCredentials']) {
  const original = mcpExecutableIdentity(definition.command[0]);
  const token = randomBytes(32).toString('hex');
  const circle = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const receive = (line: Buffer) => {
    try {
      const reply = objectRecord(JSON.parse(line.toString('utf8')));
      if (typeof reply?.id !== 'number') return;
      const request = pending.get(reply.id);
      if (reply.error !== undefined) request?.reject(new Error('Local MCP request failed'));
      else request?.resolve(reply.result);
    } catch { /* Invalid output cannot satisfy a pending call. */ }
  };
  let accepted = false;
  const server = createServer((socket) => {
    if (accepted) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(4000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let connected = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let end: number;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end);
        buffer = buffer.subarray(end + 1);
        if (line.length > 1024 * 1024) { socket.destroy(); return; }
        if (connected) receive(line);
        else {
          if (accepted || line.toString('ascii') !== token) { socket.destroy(); return; }
          connected = accepted = true;
          socket.setTimeout(0);
          circle.resolve(socket);
          for (const other of sockets) if (other !== socket) other.destroy();
        }
      }
      if (buffer.length > (connected ? 1024 * 1024 : token.length)) socket.destroy();
    });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      if (!connected) return;
      for (const request of pending.values()) request.reject(new Error('Local MCP connection closed'));
    });
  });
  const control = mkdtempSync(join(tmpdir(), 'oep-mcp-bridge-'));
  let job: ReturnType<typeof startJob> | undefined;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    try { await job?.stop(); }
    finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(control, { recursive: true, force: true });
    }
  })();
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local MCP bridge unavailable');
    writeFileSync(join(control, 'definition.json'), JSON.stringify(definition), { flag: 'wx' });
    writeFileSync(join(control, 'bridge.json'), JSON.stringify({ port: address.port, ticket: token }), { flag: 'wx' });
    const names = definition.environment.map(({ reference }) => reference);
    const injected = readCredentials?.(names);
    writeFileSync(join(control, 'mcp-credential-names.json'), JSON.stringify(injected ? [] : names), { flag: 'wx' });
    const system = process.env.SystemRoot!;
    job = startJob(control, control, {
      SystemRoot: system, WINDIR: system, SystemDrive: process.env.SystemDrive, COMSPEC: join(system, 'System32', 'cmd.exe'),
      PATH: [dirname(process.execPath), join(system, 'System32'), system].join(delimiter),
      HOME: control, USERPROFILE: control, APPDATA: control, LOCALAPPDATA: control, TEMP: control, TMP: control,
      OEP_JOB_MCP_PROBE: 'bridge', OEP_JOB_TEST_SCOPE: randomBytes(16).toString('hex'),
      ...(injected && Object.fromEntries(names.map((name) => [name, injected[name]]))),
    });
    await job.ready();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const clock = setTimeout(() => reject(new Error('Local MCP bridge timed out')), Math.min(definition.timeouts.startup, 15_000));
      void Promise.race([circle.promise, job!.finished.then(() => { throw new Error('Local MCP bridge closed'); })])
        .then(resolve, reject).finally(() => clearTimeout(clock));
    });
    let nextId = 0;
    const current = () => {
      try { return !socket.destroyed && mcpExecutableIdentity(definition.command[0]) === original; }
      catch { return false; }
    };
    async function send(method: string, phase: keyof CustomStdioMcp['timeouts'], params: unknown, signal?: AbortSignal) {
      if (!current()) throw new Error('Local MCP executable changed or disconnected');
      const timer = AbortSignal.timeout(definition.timeouts[phase]);
      const stop = signal ? AbortSignal.any([signal, timer]) : timer;
      stop.throwIfAborted();
      const notification = method.startsWith('notifications/');
      const id = notification ? undefined : ++nextId;
      const message = { jsonrpc: '2.0', id, method, params };
      if (id === undefined) { socket.write(JSON.stringify(message) + '\n'); return; }
      const reply = Promise.withResolvers<unknown>();
      pending.set(id, reply);
      const abort = () => {
        if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) + '\n');
        reply.reject(stop.reason);
      };
      stop.addEventListener('abort', abort, { once: true });
      try { socket.write(JSON.stringify(message) + '\n'); return await reply.promise; }
      finally { stop.removeEventListener('abort', abort); pending.delete(id); }
    }
    return { send, close, current };
  } catch (error) { await close(); throw error; }
}
