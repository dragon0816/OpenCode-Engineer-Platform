import { OpenCode } from '@opencode/client';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ownerCheckedFetch, ownsWindowsPeer } from '../../../../scripts/phase0/probe-listeners.ts';

export type Endpoint = ReturnType<typeof openCodeEndpoint>;
export const call = () => ({ signal: AbortSignal.timeout(8_000) });

export function openCodeEndpoint(port: number, pid: number, password: string, alive: () => boolean) {
  const url = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const netstat = join(process.env.SystemRoot!, 'System32', 'netstat.exe');
  const table = () => execFileSync(netstat, ['-ano'], {
    encoding: 'utf8', windowsHide: true, timeout: 4_000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const listeners = () => table().split(/\r?\n/).map((row) => row.trim().split(/\s+/))
    .filter(([protocol, , , state, owner]) => protocol === 'TCP' && state === 'LISTENING' && Number(owner) === pid)
    .map(([, local]) => local);
  const ownsListener = () => {
    const owned = listeners();
    return alive() && owned.length === 1 && owned[0] === `127.0.0.1:${port}`;
  };
  const guarded = ownerCheckedFetch(url, ownsListener, (peer) => alive() && ownsWindowsPeer(table(), pid, peer));
  const client = OpenCode.make({ baseUrl: url, fetch: guarded, headers: { authorization } });
  return {
    client, listeners,
    request: (path: '/api/info' | '/api/event', signal: AbortSignal, authenticated = true) =>
      guarded(`${url}${path}`, { headers: authenticated ? { authorization } : {}, signal }),
  };
}
