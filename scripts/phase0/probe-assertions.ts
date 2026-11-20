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
    async send<T>(id: string, transport: () => Promise<T>) {
      sends.set(id, (sends.get(id) ?? 0) + 1);
      return transport();
    },
    get captured() { return visible.filter((session) => session === owner).length; },
    verify(operations: string[], elapsed: number[]) {
      const foreignExposed = visible.filter((session) => session !== owner).length;
      const duplicateSubmissions = [...sends.values()].reduce((total, count) => total + count - 1, 0);
      check('S4', {
        receiver: foreignExposed === 0, sender: duplicateSubmissions === 0 &&
          sends.size === operations.length && operations.every((id) => sends.get(id) === 1),
        reconnectDeadline: elapsed.length === 3 && elapsed.every((ms) => ms >= 0 && ms <= 5000),
      });
      return { foreignExposed, duplicateSubmissions, trackedOperations: sends.size };
    },
  };
}
