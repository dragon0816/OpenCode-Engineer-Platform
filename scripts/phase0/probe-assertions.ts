import type { Trace } from './model-probe.ts';

export function check(name: string, conditions: Record<string, boolean>) {
  const failed = Object.entries(conditions).filter(([, passed]) => passed !== true).map(([key]) => key);
  if (failed.length) throw new Error(`${name}: ${failed.join(', ')}`);
}

export function verifySecurity(evidence: {
  bind: boolean; noAuth: number; authenticated: number; upstreamLocalhostCors: boolean; proxy: number;
  badHost: number; badOrigin: number; missingCsrf: number; noSession: number; passwordVisible: boolean;
}) {
  check('S5', {
    bind: evidence.bind, noAuth: evidence.noAuth === 401, authenticated: evidence.authenticated === 200,
    cors: evidence.upstreamLocalhostCors, proxy: evidence.proxy === 200, host: evidence.badHost === 403,
    origin: evidence.badOrigin === 403, csrf: evidence.missingCsrf === 403, session: evidence.noSession === 401,
    password: evidence.passwordVisible === false,
  });
}

export function verifyAliasRuns(aliases: string[], healthy: Set<string>, runs: Map<string, boolean[]>) {
  for (const alias of aliases) check('S2', {
    healthy: healthy.has(alias), tenTurns: runs.get(alias)?.length === 10,
    allPassed: runs.get(alias)?.every(Boolean) === true,
  });
}

export function verifyToolAnswer(traces: Trace[], finalText: string, tokens: string[]) {
  const calls = traces.flatMap((trace) => trace.calls);
  return calls.length === tokens.length && calls.every((call) => call.name === 'fixture_lookup') &&
    finalText.trim().split(/[\s,]+/).sort().join(',') === [...tokens].sort().join(',');
}

export function reconnectionAudit(owner: string) {
  const visible: string[] = [];
  const sends = new Map<string, number>();
  return {
    receive(serialized: string) { visible.push((JSON.parse(serialized) as { sessionID: string }).sessionID); },
    observePrompt(request: Request, body: Buffer) {
      const match = /^\/api\/session\/([^/]+)\/prompt$/.exec(new URL(request.url).pathname);
      if (request.method !== 'POST' || !match) return;
      const payload = JSON.parse(body.toString('utf8')) as { id?: unknown };
      if (typeof payload.id !== 'string' || !payload.id) throw new Error('S4 prompt omitted its operation ID');
      const key = `${decodeURIComponent(match[1])}/${payload.id}`;
      sends.set(key, (sends.get(key) ?? 0) + 1);
    },
    get captured() { return visible.filter((session) => session === owner).length; },
    verify(operations: { sessionID: string; id: string }[], elapsed: number[]) {
      const foreignExposed = visible.filter((session) => session !== owner).length;
      const duplicateSubmissions = [...sends.values()].reduce((total, count) => total + count - 1, 0);
      check('S4', {
        receiver: foreignExposed === 0, sender: duplicateSubmissions === 0 &&
          sends.size === operations.length && operations.every(({ sessionID, id }) => sends.get(`${sessionID}/${id}`) === 1),
        reconnectDeadline: elapsed.length === 3 && elapsed.every((ms) => ms >= 0 && ms <= 5000),
      });
      return { foreignExposed, duplicateSubmissions, trackedOperations: sends.size };
    },
  };
}
