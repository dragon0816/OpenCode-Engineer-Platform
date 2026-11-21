import { matchesToolResult, tokenFor, type Trace } from './model-probe.ts';

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

export function validCalls(traces: Trace[], slots: string[]) {
  if (traces.length !== 2) return false;
  const [first, followUp] = traces;
  if (first.model !== followUp.model || !traces.every((trace) => trace.status === 200 && trace.streaming && trace.done) ||
      first.finish !== 'tool_calls' || followUp.finish !== 'stop' || first.returned.length !== 0 || followUp.calls.length !== 0 ||
      first.calls.length !== slots.length || followUp.returned.length !== slots.length) return false;
  const expectedSlots = new Set(slots);
  const expectedResults = new Map<string, string>();
  try {
    for (const call of first.calls) {
      const args: unknown = JSON.parse(call.args);
      if (!call.id || expectedResults.has(call.id) || call.name !== 'fixture_lookup' || !args || typeof args !== 'object' ||
          Object.keys(args).length !== 1 || !('slot' in args) || typeof args.slot !== 'string' || !expectedSlots.delete(args.slot)) return false;
      const token = tokenFor.get(args.slot);
      if (!token) return false;
      expectedResults.set(call.id, token);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  for (const result of followUp.returned) {
    const expected = expectedResults.get(result.id);
    if (!expected || !matchesToolResult(result.content, expected)) return false;
    expectedResults.delete(result.id);
  }
  return expectedSlots.size === 0 && expectedResults.size === 0;
}

export function reconnectionAudit(owner: string) {
  const visible: string[] = [];
  const sends = new Map<string, number>();
  const keyFor = (sessionID: string, id: string) => JSON.stringify([sessionID, id]);
  return {
    receive(serialized: string) { visible.push((JSON.parse(serialized) as { sessionID: string }).sessionID); },
    observePrompt(request: Request, body: Buffer) {
      const match = /^\/api\/session\/([^/]+)\/prompt\/?$/.exec(decodeURIComponent(new URL(request.url).pathname));
      if (request.method !== 'POST' || !match) return;
      const payload = JSON.parse(body.toString('utf8')) as { id?: unknown };
      if (typeof payload.id !== 'string' || !payload.id) throw new Error('S4 prompt omitted its operation ID');
      const key = keyFor(match[1], payload.id);
      sends.set(key, (sends.get(key) ?? 0) + 1);
    },
    get captured() { return visible.filter((session) => session === owner).length; },
    verify(operations: { sessionID: string; id: string }[], elapsed: number[]) {
      const foreignExposed = visible.filter((session) => session !== owner).length;
      const duplicateSubmissions = [...sends.values()].reduce((total, count) => total + count - 1, 0);
      const expected = new Set(operations.map(({ sessionID, id }) => keyFor(sessionID, id)));
      check('S4', {
        receiver: foreignExposed === 0, sender: duplicateSubmissions === 0 &&
          expected.size === operations.length && sends.size === expected.size && [...expected].every((key) => sends.get(key) === 1),
        reconnectDeadline: elapsed.length === 3 && elapsed.every((ms) => ms >= 0 && ms <= 5000),
      });
      return { foreignExposed, duplicateSubmissions, trackedOperations: sends.size };
    },
  };
}
