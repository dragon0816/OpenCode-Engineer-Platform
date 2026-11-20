import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

type Listener = { family: 4 | 6; address: string; port: number };

export function parseListeners(table: string, family: 4 | 6, owned: Set<string>): Listener[] {
  return table.trim().split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !owned.has(fields[9])) return [];
    const [address, port] = fields[1].split(':');
    return [{ family, address, port: Number.parseInt(port, 16) }];
  });
}

export function processListeners(pid: number): Listener[] {
  const sockets = new Set<string>();
  for (const name of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${name}`));
      if (inode) sockets.add(inode[1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [
    ...parseListeners(readFileSync(`/proc/${pid}/net/tcp`, 'utf8'), 4, sockets),
    ...parseListeners(readFileSync(`/proc/${pid}/net/tcp6`, 'utf8'), 6, sockets),
  ];
}

export function onlyExpectedListener(listeners: Listener[], port: number): boolean {
  return listeners.length === 1 && listeners[0].family === 4 && listeners[0].address === '0100007F' && listeners[0].port === port;
}

export function ownerCheckedFetch(origin: string, ownsListener: () => boolean): typeof fetch {
  return async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || !ownsListener()) throw new Error('OpenCode listener ownership not verified');
    return fetch(input, { ...options, redirect: 'error' });
  };
}
