import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { gatewayAliases, gatewaySettings, startGateway } from '../../adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../adapter/src/opencode/gateway.ts';
import { assistantMessages, createSession, promptID, submitOnce } from '../../adapter/src/opencode/sessions.ts';
import { waitForOutcome } from '../../adapter/src/opencode/reconcile.ts';
import { supervise } from './supervisor.ts';

export type Runtime = Awaited<ReturnType<typeof startRuntime>>;

type SyntheticGateway = Omit<Parameters<typeof startGateway>[0], 'trace'>;

export async function startRuntime(root: string, synthetic?: SyntheticGateway) {
  const alias = synthetic?.alias ?? process.env.OEP_MODEL_ALIAS ?? gatewayAliases[0];
  if (!synthetic && !gatewayAliases.some((candidate) => candidate === alias)) throw new Error('Model alias is not approved');
  const audit = (name: string, record: object) => appendFileSync(join(root, name), `${JSON.stringify(record)}\n`);
  const requests: GatewayTrace[] = [];
  const relay = await startGateway({
    ...(synthetic ?? gatewaySettings()), alias, trace: (value) => {
      requests.push(value);
      audit('gateway.jsonl', value);
    },
  });
  const gatewaySince = (cursor: number) => requests.filter((request) => request.request > cursor);
  const startupFailed = () => writeFileSync(join(root, 'startup-failed'),
    'OpenCode startup or model health failed. Inspect status-only audit records.\n');
  let supervisor: Awaited<ReturnType<typeof supervise>>;
  try {
    supervisor = await supervise(root, relay, alias);
  } catch (error) {
    try { await relay.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Supervisor and relay cleanup failed'); }
    finally { startupFailed(); }
    throw error;
  }
  let stopped: ReturnType<typeof supervisor.stop> | undefined;
  const stop = () => stopped ??= (async () => {
    try {
      const result = await supervisor.stop();
      audit('lifecycle.jsonl', { event: 'stop', ...result });
      return result;
    } finally { await relay.close(); }
  })();
  const { client } = supervisor.endpoint;
  try {
    const initial = { event: 'ready', version: supervisor.version, unauthenticated: supervisor.unauthorized,
      ipv4: supervisor.endpoint.listeners().length, jobMembers: supervisor.members };
    audit('lifecycle.jsonl', initial);
    async function checkHealth(retries: number) {
      const started = Date.now();
      const cursor = relay.requestCursor();
      const workspace = mkdtempSync(join(root, 'health-'));
      const nonce = `READY-${randomBytes(4).toString('hex').toUpperCase()}`;
      const submissionID = promptID();
      let sessionID: string | undefined;
      let reason = 'turn-failed';
      try {
        sessionID = await createSession(client, workspace, 'inspector', alias);
        const admitted = await submitOnce(client, { sessionID, id: submissionID, text: `Reply with exactly ${nonce} and no other content.` });
        if (admitted === 'indeterminate') return reason;
        const outcome = await waitForOutcome(client, sessionID, undefined, 45_000);
        const calls = gatewaySince(cursor);
        if (!calls.length || calls.some((request) => request.status !== 200)) reason = 'gateway-failed';
        else if (calls.every((request) => request.output === 'empty')) reason = 'empty-output';
        else if (outcome === 'succeeded') {
          const reply = (await assistantMessages(client, sessionID)).at(-1)?.content
            .flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim();
          reason = reply === nonce ? 'passed' : reply ? 'reply-mismatch' : 'empty-output';
        }
        return reason;
      } finally {
        audit('health.jsonl', { alias, sessionID, submissionID, retries, passed: reason === 'passed', reason,
          elapsedMs: Date.now() - started, modelCalls: gatewaySince(cursor) });
      }
    }
    const firstHealth = await checkHealth(0);
    const health = firstHealth === 'empty-output' ? await checkHealth(1) : firstHealth;
    if (health !== 'passed') throw new Error('Model health turn failed');
    return { ...initial, root, alias, endpoint: supervisor.endpoint, client, stop, finished: supervisor.finished, redact: relay.redact,
      gatewayCursor: relay.requestCursor, gatewaySince };
  } catch (error) {
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Health check and runtime cleanup failed'); }
    finally { startupFailed(); }
    throw error;
  }
}
