import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { discoverGatewayModels, gatewayAliases, gatewayPing, gatewaySettings, startGateway } from '../../adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../adapter/src/opencode/gateway.ts';
import { assistantMessages, createSession, promptID, submitOnce } from '../../adapter/src/opencode/sessions.ts';
import { waitForOutcome } from '../../adapter/src/opencode/reconcile.ts';
import { supervise } from './supervisor.ts';
import { startKnowledgeRuntime } from './knowledge.ts';
import { WebStore } from '../../adapter/src/runs/web-store.ts';

import type { CustomMcp } from '../../adapter/src/runs/custom-mcp.ts';

export type Runtime = Awaited<ReturnType<typeof startRuntime>>;

type SyntheticGateway = Omit<Parameters<typeof startGateway>[0], 'trace' | 'web'> & { isolatedJob?: boolean };

export async function startRuntime(root: string, synthetic?: SyntheticGateway, profile?: string, customMcp: readonly CustomMcp[] = []) {
  const settings = synthetic ?? gatewaySettings();
  const builtInAliases = synthetic ? synthetic.aliases ?? [synthetic.alias] : gatewayAliases;
  let alias = synthetic?.alias ?? process.env.OEP_MODEL_ALIAS ?? gatewayAliases[0];
  let aliases = builtInAliases;
  async function refreshModels(store: WebStore) {
    const catalog = await discoverGatewayModels(settings);
    if (!catalog) return false;
    store.saveModelCatalog(catalog, builtInAliases);
    return true;
  }
  if (profile) {
    const store = new WebStore(join(dirname(profile), 'web.sqlite'));
    try {
      await refreshModels(store);
      if (store.defaultAlias() === undefined && !builtInAliases.includes(alias)) throw new Error('Model alias is not approved');
      const selection = store.modelSelection(builtInAliases, alias);
      aliases = selection.ids;
      alias = selection.defaultAlias;
    } finally { store.close(); }
  }
  if (!aliases.includes(alias)) throw new Error('Model alias is not approved');
  if (!profile) aliases = [alias];
  const audit = (name: string, record: object) => appendFileSync(join(root, name), `${JSON.stringify(record)}\n`);
  const requests: GatewayTrace[] = [];
  const relay = await startGateway({
    ...settings, alias, aliases, web: Boolean(profile), managed: true, trace: (value) => {
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
    if (profile) knowledge = await startKnowledgeRuntime(profile, root, { ...settings, alias, aliases }, () => alias);
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
    const health = new Map(aliases.map((name) => [name, false]));
    const aliasHealth = () => aliases.map((name) => ({ alias: name, healthy: health.get(name) ?? false }));
    const testModel = gatewayPing(settings);
    let testing = false;
    async function checkModel(name: string) {
      if (checking || testing) return;
      testing = true;
      try {
        const healthy = await testModel(name);
        health.set(name, healthy);
        return { healthy };
      } finally { testing = false; }
    }
    let nextCheck = 0;
    let checking = false;
    async function checkAliases() {
      if (checking || testing || Date.now() < nextCheck) return false;
      checking = true;
      nextCheck = Date.now() + 30_000;
      try {
        await Promise.all(aliases.map(async (name) => { health.set(name, await relay.ping(name)); }));
        audit('health.jsonl', { checkedAt: Date.now(), aliases: aliasHealth() });
        return true;
      } finally { checking = false; }
    }
    if (profile && (!synthetic || synthetic.aliases)) {
      await checkAliases();
      nextCheck = 0;
    }
    return { ...initial, root, get alias() { return alias; }, aliases, builtInAliases, aliasHealth, checkAliases, checkModel, refreshModels,
      setDefaultAlias(name: string) {
        if (!aliases.includes(name)) throw new Error('Model alias is not approved');
        alias = name;
      },
      endpoint: supervisor.endpoint, client, stop, finished: supervisor.finished, redact: relay.redact, knowledge, customMcp,
      gatewayCursor: relay.requestCursor, setTurnBoundary: relay.setTurnBoundary, gatewaySince };
  } catch (error) {
    try { await stop(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Health check and runtime cleanup failed'); }
    finally { startupFailed(); }
    throw error;
  }
}
