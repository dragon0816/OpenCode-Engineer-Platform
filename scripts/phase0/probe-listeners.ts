import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { once } from 'node:events';
import { Agent, request as sendRequest } from 'node:http';
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { isConnectionError, ProbeDeadlineError, ProbeTransportError, until } from './probe-http.ts';

type Listener = { family: 4 | 6; address: string; port: number };

export function parseListeners(table: string, family: 4 | 6, owned: Set<string>): Listener[] {
  return table.trim().split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !owned.has(fields[9])) return [];
    const [address, port] = fields[1].split(':');
    return [{ family, address, port: Number.parseInt(port, 16) }];
  });
}

function socketInodes(pid: number) {
  const sockets = new Set<string>();
  for (const name of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${name}`));
      if (inode) sockets.add(inode[1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return sockets;
}

export function processListeners(pid: number): Listener[] {
  const sockets = socketInodes(pid);
  return [
    ...parseListeners(readFileSync(`/proc/${pid}/net/tcp`, 'utf8'), 4, sockets),
    ...parseListeners(readFileSync(`/proc/${pid}/net/tcp6`, 'utf8'), 6, sockets),
  ];
}

export function onlyExpectedListener(listeners: Listener[], port: number): boolean {
  return listeners.length === 1 && listeners[0].family === 4 && listeners[0].address === '0100007F' && listeners[0].port === port;
}

export type PeerTuple = { serverPort: number; clientPort: number };

export function ownsLinuxPeer(pid: number, { serverPort, clientPort }: PeerTuple): boolean {
  const socket = (port: number) => `0100007F:${port.toString(16).padStart(4, '0').toUpperCase()}`;
  const owned = socketInodes(pid);
  return readFileSync(`/proc/${pid}/net/tcp`, 'utf8').split('\n').some((line) => {
    const [, local, remote, state, , , , , , inode] = line.trim().split(/\s+/);
    return local === socket(serverPort) && remote === socket(clientPort) && state === '01' && owned.has(inode);
  });
}

export function ownsWindowsPeer(output: string, pid: number, { serverPort, clientPort }: PeerTuple): boolean {
  return output.split(/\r?\n/).some((line) => {
    const [protocol, local, remote, state, owner] = line.trim().split(/\s+/);
    return protocol === 'TCP' && local === `127.0.0.1:${serverPort}` && remote === `127.0.0.1:${clientPort}` &&
      state === 'ESTABLISHED' && Number(owner) === pid;
  });
}

export function ownerCheckedFetch(origin: string, ownsListener: () => boolean, ownsPeer: (peer: PeerTuple) => boolean,
  beforeSend?: (request: Request, body: Buffer) => void): typeof fetch {
  return async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    const serverPort = Number(url.port);
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !serverPort || !ownsListener()) {
      throw new ProbeTransportError('OpenCode listener ownership not verified');
    }
    const body = Buffer.from(await request.arrayBuffer());
    const signal = request.signal;
    signal.throwIfAborted();
    const socket = createConnection({ host: '127.0.0.1', port: serverPort, family: 4 });
    let socketError: Error | undefined;
    socket.on('error', (error) => { socketError = error; });
    const verifySocket = () => {
      if (socketError) throw isConnectionError(socketError) ? new ProbeTransportError() : socketError;
      if (socket.destroyed) throw new ProbeTransportError();
    };
    try {
      try { await once(socket, 'connect', { signal }); }
      catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason) signal.throwIfAborted();
        if (isConnectionError(error)) throw new ProbeTransportError();
        throw error;
      }
      const clientPort = socket.localPort;
      if (socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== serverPort || !clientPort) throw new ProbeTransportError();
      // Wake deferred accepts with a single HTTP-tolerated empty line, before any headers or credentials.
      socket.write('\r\n');
      try {
        await until(async () => {
          signal.throwIfAborted();
          verifySocket();
          return ownsPeer({ serverPort, clientPort }) ? true : undefined;
        }, 750);
      } catch (error) {
        if (error instanceof ProbeDeadlineError) {
          signal.throwIfAborted();
          throw new ProbeTransportError('OpenCode peer ownership not verified');
        }
        throw error;
      }
      signal.throwIfAborted();
      verifySocket();

      const agent = new Agent({ keepAlive: false });
      // The agent receives the already-connected socket. It cannot open a replacement connection.
      agent.createConnection = () => socket;
      beforeSend?.(request, body);
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = sendRequest(url, { agent, method: request.method, signal, headers: Object.fromEntries(request.headers) });
        outgoing.once('error', (error) => {
          if (error.name === 'AbortError' && error.cause === signal.reason) reject(signal.reason);
          else reject(isConnectionError(error) ? new ProbeTransportError() : error);
        });
        outgoing.once('response', (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400 && incoming.headers.location) {
            incoming.destroy();
            reject(new ProbeTransportError('OpenCode redirect refused'));
            return;
          }
          const stream = request.method === 'HEAD' || [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
          if (!stream) incoming.resume();
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          resolve(new Response(stream, { status, headers }));
        });
        outgoing.end(body.length ? body : undefined);
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}
