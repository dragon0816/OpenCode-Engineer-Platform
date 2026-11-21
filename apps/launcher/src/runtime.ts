import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { gatewayAliases, gatewaySettings, startGateway } from '../../adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../adapter/src/opencode/gateway.ts';
import { assistantMessages, createSession, promptID, submitOnce } from '../../adapter/src/opencode/sessions.ts';
import { waitForOutcome } from '../../adapter/src/opencode/reconcile.ts';
import { supervise } from './supervisor.ts';
import { startKnowledgeRuntime } from './knowledge.ts';

import type { CustomMcp } from '../../adapter/src/runs/custom-mcp.ts';

export type Runtime = Awaited<ReturnType<typeof startRuntime>>;

type SyntheticGateway = Omit<Parameters<typeof startGateway>[0], 'trace' | 'web'> & { isolatedJob?: boolean };

export async function startRuntime(root: string, synthetic?: SyntheticGateway, profile?: string, customMcp: readonly CustomMcp[] = []) {
  const alias = synthetic?.alias ?? process.env.OEP_MODEL_ALIAS ?? gatewayAliases[0];
  if (!synthetic && !gatewayAliases.some((candidate) => candidate === alias)) throw new Error('Model alias is not approved');
  const audit = (name: string, record: object) => appendFileSync(join(root, name), `${JSON.stringify(record)}\n`);
  const requests: GatewayTrace[] = [];
  const settings = { ...(synthetic ?? gatewaySettings()), alias };
  const aliases: readonly string[] = profile ? synthetic?.aliases ?? (synthetic ? [alias] : gatewayAliases) : [alias];
  const relay = await startGateway({
    ...settings, aliases, web: Boolean(profile), trace: (value) => {
      requests.push(value);
      audit('gateway.jsonl', value);
    },
  });
  const gatewaySince = (cursor: number) => requests.filter((request) => request.request > cursor);
  const startupFailed = () => writeFileSync(join(root, 'startup-failed'),
    'OpenCode startup or model health failed. Inspect status-only audit records.\n');
  let supervisor: Awaited<ReturnType<typeof supervise>>;
  let knowledge: Awaited<ReturnType<typeof startKnowledgeRuntime>> | undefined;
  async function closeRelays() {
    try { await knowledge?.close(); }
    finally { await relay.close(); }
  }
  try {
    if (profile) knowledge = await startKnowledgeRuntime(profile, root, settings);
    supervisor = await supervise(root, relay, aliases, profile, knowledge?.config, synthetic?.isolatedJob, customMcp);
  } catch (error) {
    try { await closeRelays(); }
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
    } finally { await closeRelays(); }
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
    if (!profile) {
      const firstHealth = await checkHealth(0);
      const health = firstHealth === 'empty-output' ? await checkHealth(1) : firstHealth;
      if (health !== 'passed') throw new Error('Model health turn failed');
    }
    let aliasHealth = aliases.map((name) => ({ alias: name, healthy: false }));
    let nextCheck = 0;
    let checking = false;
    async function checkAliases() {
      if (checking || Date.now() < nextCheck) return false;
      checking = true;
      nextCheck = Date.now() + 30_000;
      try {
        aliasHealth = await Promise.all(aliases.map(async (name) => ({ alias: name, healthy: await relay.ping(name) })));
        audit('health.jsonl', { checkedAt: Date.now(), aliases: aliasHealth });
        return true;
      } finally { checking = false; }
    }
    if (profile && (!synthetic || synthetic.aliases)) {
      await checkAliases();
      nextCheck = 0;
    }
    return { ...initial, root, alias, aliases, aliasHealth: () => aliasHealth, checkAliases, endpoint: supervisor.endpoint, client, stop, finished: supervisor.finished, redact: relay.redact, knowledge, customMcp,
      gatewayCursor: relay.requestCursor, setTurnBoundary: relay.setTurnBoundary, gatewaySince };
  } catch (error) {
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Health check and runtime cleanup failed'); }
    finally { startupFailed(); }
    throw error;
  }
}
