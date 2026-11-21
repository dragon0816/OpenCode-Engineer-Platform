import { OpenCode } from '@opencode/client';
import type { OpenCodeClient, SessionPromptInput } from '@opencode/client';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { candidateAliases, fixtureGateway, forcedChoice, mockAliases, startModelProbe, syntheticMarker, tokenFor, workingAliases } from './model-probe.ts';
import { redactFields } from './probe-redaction.ts';
import { finishFailedTurn, listen, pause, retryReadiness, send, subscribeEventStream, until, waitForExit } from './probe-http.ts';
import { check, reconnectionAudit, verifyAliasRuns, verifySecurity, verifyToolAnswer } from './probe-assertions.ts';
import { onlyExpectedListener, ownerCheckedFetch, ownsLinuxPeer, processListeners, type PeerTuple } from './probe-listeners.ts';

const binary = '/work/.phase0/assets/linux/opencode';
const providerID = 'oep-phase-zero';
const report = (test: string, facts: object) => console.log(JSON.stringify({ test, ...facts }));
const callOptions = () => ({ signal: AbortSignal.timeout(6_000) });
const permission = { action: '*', resource: '*', effect: 'deny' as const };
type Client = OpenCodeClient;
type Probe = Awaited<ReturnType<typeof startModelProbe>>;
type Server = Awaited<ReturnType<typeof startOpenCode>>;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startOpenCode(probe: Probe, root: string, automation = false, models = mockAliases) {
  const port = await availablePort();
  const password = randomBytes(24).toString('hex');
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  const url = `http://127.0.0.1:${port}`;
  const config = {
    update: 'disable', share: 'disabled',
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: providerID, effect: 'allow' }],
    providers: {
      [providerID]: {
        package: '@opencode/ai/providers/openai-compatible',
        name: 'Phase Zero',
        settings: { baseURL: `${probe.endpoint.url}/v1`, apiKey: probe.apiKey },
        models: Object.fromEntries(models.flatMap((id) => {
          const model = { modelID: id, capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'] }, limit: { context: 32000, output: 256 } };
          return [
            [id, model],
            ...(workingAliases.includes(id) ? [
              [`${id}-forced`, { ...model, body: { tool_choice: forcedChoice, parallel_tool_calls: true } }],
              [`${id}-none`, { ...model, body: { tool_choice: 'none' } }],
              [`${id}-schema`, { ...model, body: { tool_choice: 'none', response_format: { type: 'json_schema', json_schema: { name: 'phase_zero', strict: true, schema: { type: 'object', properties: { code: { type: 'string', enum: ['VIOLET-92'] } }, required: ['code'], additionalProperties: false } } } } }],
            ] : []),
          ];
        })),
      },
    },
    permissions: [permission, { action: 'fixture_lookup', resource: '*', effect: 'allow' }],
    mcp: { servers: { fixture: { type: 'remote', url: `${probe.mcp.url}/mcp`, oauth: false } } },
  };
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), TMPDIR: root,
    OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_FLAGS: automation ? 'automations' : '-automations',
  };
  const directory = join(root, 'workspace');
  mkdirSync(directory, { recursive: true });
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: directory, env, stdio: 'ignore' });
  const stopped = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitForExit(stopped, 1500);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
  };
  const listeners = () => child.pid && child.exitCode === null && child.signalCode === null ? processListeners(child.pid) : [];
  const ownsListener = () => onlyExpectedListener(listeners(), port);
  const ownsPeer = (peer: PeerTuple) => !!child.pid && child.exitCode === null && child.signalCode === null && ownsLinuxPeer(child.pid, peer);
  const guardedFetch = ownerCheckedFetch(url, ownsListener, ownsPeer);
  const makeClient = (fetch = guardedFetch) => OpenCode.make({ baseUrl: url, headers: { authorization: auth }, fetch });
  const client = makeClient();
  const observeClient = (observe: (request: Request, body: Buffer) => void) => makeClient(ownerCheckedFetch(url, ownsListener, ownsPeer, observe));
  try {
    const version = await until(async () => {
      if (child.exitCode !== null) throw new Error('server exited');
      try {
        // A protected readiness endpoint can open before SQLite migrations have finished.
        const info = await client.server.info(callOptions());
        await client.session.active(callOptions());
        return info.version;
      } catch (error) { return retryReadiness(error); }
    });
    return { client, observeClient, version, stop, url, directory, auth, fetch: guardedFetch, listeners, ownsListener };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function createSession(server: Server, model = 'probe-model', ask = false) {
  return server.client.session.create({
    title: 'Synthetic phase zero', location: { directory: server.directory }, model: { id: model, providerID },
    permissions: ask ? [{ action: 'phase-zero-review', resource: '*', effect: 'ask' }] : undefined,
  }, callOptions());
}

async function waitForTurn(client: Client, sessionID: string, timeout = 35_000) {
  return until(async (signal) => {
    const session = await client.session.get({ sessionID }, { signal });
    return session.outcome && !(await client.session.active({ signal }))[sessionID] ? session.outcome : undefined;
  }, timeout);
}

async function turn(server: Server, model: string, text: string, files?: SessionPromptInput['files'], timeout?: number) {
  const { client } = server;
  const { id: sessionID } = await createSession(server, model);
  try {
    await client.session.prompt({ sessionID, text, files }, callOptions());
    const outcome = await waitForTurn(client, sessionID, timeout);
    const messages = await client.message.list({ sessionID, type: 'assistant', order: 'asc' }, callOptions());
    const assistantText = messages.data.filter((message) => message.type === 'assistant').map((message) =>
      message.content.flatMap((part) => part.type === 'text' ? [part.text] : []));
    return { outcome, transcript: assistantText.flat().join('\n'), finalText: assistantText.at(-1)?.join('') ?? '' };
  } catch (error) {
    const outcome = await finishFailedTurn(error, (signal) => client.session.interrupt({ sessionID }, { signal }));
    return { outcome, transcript: '', finalText: '' };
  }
}

async function contract(server: Server, probe: Probe) {
  const { client } = server;
  const ids = await createSession(server, 'slow-model', true);
  const sessionID = ids.id;
  const tools = probe.traces.length;
  const admitted = await client.session.prompt({ sessionID, text: 'Say READY-P0.' }, callOptions());
  await until(async () => probe.traces.length > tools || undefined);
  const active = !!(await client.session.active(callOptions()))[sessionID];
  await client.session.interrupt({ sessionID }, callOptions());
  const interrupted = await waitForTurn(client, sessionID);
  const pending = client.permission.create({ sessionID, action: 'phase-zero-review', resources: ['synthetic'] }, { signal: AbortSignal.timeout(5000) });
  // Observe early rejection until the permission reply is sent and the original promise is awaited.
  void pending.catch(() => undefined);
  const ask = await until(async () => (await client.permission.list({ sessionID }, callOptions()))[0], 4000);
  await client.permission.reply({ sessionID, requestID: ask.id, decision: 'reject' }, callOptions());
  const effect = (await pending).effect;
  const cleared = (await client.permission.list({ sessionID }, callOptions())).length === 0;
  report('S1-client', { create: !!ids.id, prompt: !!admitted.id, active, interrupt: interrupted, permission: effect, cleared });
  check('S1-client', { create: !!ids.id, prompt: !!admitted.id, active, interrupt: interrupted === 'interrupted', permission: effect === 'ask', cleared });
}

async function automation(server: Server, probe: Probe, root: string) {
  const off = await server.fetch(`${server.url}/api/experimental/automation?directory=${encodeURIComponent(server.directory)}`, { headers: { authorization: server.auth }, signal: AbortSignal.timeout(5000) });
  report('S1-automation-off', { status: off.status });
  await off.body?.cancel();
  check('S1-automation-off', { status: off.status === 403 });
  await server.stop();
  let enabled = await startOpenCode(probe, root, true);
  try {
    const session = await createSession(enabled);
    const at = new Date(Date.now() + 3500);
    const schedule = await enabled.client.experimental.automation.create({
      directory: enabled.directory, sessionID: session.id, name: 'synthetic late run',
      trigger: { type: 'at', at: at.toISOString() }, action: { type: 'prompt', prompt: 'Say READY-P0.' },
    }, callOptions());
    await enabled.stop();
    await pause(Math.max(0, at.getTime() - Date.now()) + 400);
    enabled = await startOpenCode(probe, root, true);
    const observed = await until(async () => {
      const state = await enabled.client.experimental.automation.get({ automationID: schedule.id }, callOptions());
      return state.runCount > 0 ? state : undefined;
    });
    await pause(1200);
    const stable = await enabled.client.experimental.automation.get({ automationID: schedule.id }, callOptions());
    report('S1-automation-on', { first: observed.runCount, after: stable.runCount, status: stable.status, outcome: stable.lastOutcome });
    check('S1-automation-on', { first: observed.runCount === 1, after: stable.runCount === 1, status: stable.status === 'done', outcome: stable.lastOutcome === 'fired' });
  } finally { await enabled.stop(); }
}

async function reconnection(server: Server) {
  const { client } = server;
  const a = await createSession(server, 'slow-model');
  const b = await createSession(server, 'slow-model');
  const owned = new Set([a.id]);
  const audit = reconnectionAudit(a.id);
  const promptClient = server.observeClient(audit.observePrompt);
  const operation = (sessionID: string, text: string) => ({ id: `msg_${randomBytes(12).toString('hex')}`, sessionID, text });
  const plan = Array.from({ length: 3 }, (_, index) => ({
    a: operation(a.id, `Synthetic A ${index + 1}`), b: operation(b.id, `Synthetic B ${index + 1}`),
  }));
  const submit = (planned: ReturnType<typeof operation>) => promptClient.session.prompt(planned, callOptions());
  let foreignDropped = 0;
  const projected = new Set<string>();
  const seenReplies = new Set<string>();
  const subscribe = (deadline = AbortSignal.timeout(5000)) => subscribeEventStream(
    (signal) => server.fetch(`${server.url}/api/event`, { headers: { authorization: server.auth }, signal }), deadline, (event) => {
      if (!['session.execution.started', 'session.execution.succeeded'].includes(event.type)) return;
      const owner = event.data?.sessionID;
      if (!owner) return;
      if (!owned.has(owner)) { foreignDropped++; return; }
      audit.receive(JSON.stringify({ sessionID: owner }));
    });

  const elapsed: number[] = [];
  for (let cycle = 1; cycle <= 3; cycle++) {
    const pre = subscribe();
    try {
      await pre.ready;
      const previous = foreignDropped;
      await submit(plan[cycle - 1].b);
      await until(async () => foreignDropped > previous || undefined, 4000);
      const capturedBefore = audit.captured;
      await submit(plan[cycle - 1].a);
      await until(async () => audit.captured > capturedBefore || undefined, 4000);
    } catch {
      report('S4-cycle-failed', { cycle, stage: 'subscribe-and-submit', captured: audit.captured, foreignDropped });
      throw new Error('subscribe-and-submit');
    } finally { pre.close(); await pre.completed; }
    await until(async () => (await client.message.list({ sessionID: a.id, type: 'assistant' }, callOptions()))
      .data.some((message) => message.type === 'assistant' && message.time.completed && !seenReplies.has(message.id)) || undefined);
    const started = performance.now();
    const deadline = AbortSignal.timeout(5000);
    const replay = subscribe(deadline);
    try {
      await replay.ready;
      const options = { signal: deadline };
      const [session, history, inbox, permissions, replies] = await Promise.all([
        client.session.get({ sessionID: a.id }, options), client.message.list({ sessionID: a.id, type: 'user' }, options),
        client.session.inbox.list({ sessionID: a.id }, options), client.permission.list({ sessionID: a.id }, options),
        client.message.list({ sessionID: a.id, type: 'assistant' }, options),
      ]);
      deadline.throwIfAborted();
      for (const message of replies.data) seenReplies.add(message.id);
      if (session.outcome !== 'succeeded' || inbox.length !== 0 || history.data.length !== cycle || permissions.length !== 0) {
        report('S4-cycle-failed', { cycle, stage: 'reconciliation', outcome: session.outcome, inbox: inbox.length, messages: history.data.length });
        throw new Error('reconciliation');
      }
      for (const row of history.data) projected.add(row.id);
      elapsed.push(Math.round(performance.now() - started));
    } finally { replay.close(); await replay.completed; }
  }
  const observed = audit.verify(plan.flatMap((cycle) => [cycle.a, cycle.b]), elapsed);
  check('S4', { filtered: foreignDropped >= 3, delivered: audit.captured >= 3, durable: projected.size === 3 });
  report('S4-disconnect', { elapsed, captured: audit.captured, foreignDropped, durableUniqueSubmissions: projected.size, ...observed });
}

async function security(server: Server) {
  const get = (url: string, headers?: HeadersInit) => server.fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  const api = `${server.url}/api/session`;
  const noAuth = await get(api);
  const allowed = await get(api, { authorization: server.auth, origin: 'http://localhost:9911' });
  const cors = allowed.headers.get('access-control-allow-origin');
  await Promise.all([noAuth.body?.cancel(), allowed.body?.cancel()]);
  const webSession = randomBytes(16).toString('hex');
  const csrf = randomBytes(16).toString('hex');
  const proxy = await listen(async (request, response) => {
    if (request.headers.host !== new URL(proxy.url).host || request.headers.origin !== proxy.url) return send(response, 403);
    if (request.headers.cookie !== `oep=${webSession}`) return send(response, 401);
    if (request.method === 'POST' && request.headers['x-csrf-token'] !== csrf) return send(response, 403);
    if (request.method !== 'POST' || request.url !== '/status') return send(response, 404);
    const upstream = await get(api, { authorization: server.auth });
    await upstream.body?.cancel();
    send(response, upstream.ok ? 200 : 502, { ready: upstream.ok });
  });
  try {
    const headers = { origin: proxy.url, cookie: `oep=${webSession}`, 'x-csrf-token': csrf };
    const post = (override: Record<string, string>) => fetch(`${proxy.url}/status`, { method: 'POST', headers: { ...headers, ...override }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    const badHostStatus = new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${proxy.url}/status`, { method: 'POST', headers: { ...headers, host: 'foreign.invalid' }, timeout: 5000 }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('timeout', () => request.destroy());
      request.on('error', reject).end();
    });
    const [good, badHost, badOrigin, missingCsrf, noSession] = await Promise.all([
      post({}), badHostStatus, post({ origin: 'http://localhost:9911' }), post({ 'x-csrf-token': '' }), post({ cookie: '' }),
    ]);
    const browserView = (await good.text()) + JSON.stringify([...good.headers]);
    await Promise.all([badOrigin.body?.cancel(), missingCsrf.body?.cancel(), noSession.body?.cancel()]);
    const listeners = server.listeners();
    const evidence = { bind: server.ownsListener(), ipv4Listeners: listeners.filter((row) => row.family === 4).length, ipv6Listeners: listeners.filter((row) => row.family === 6).length, noAuth: noAuth.status, authenticated: allowed.status, upstreamLocalhostCors: cors === 'http://localhost:9911', proxy: good.status, badHost, badOrigin: badOrigin.status, missingCsrf: missingCsrf.status, noSession: noSession.status, passwordVisible: browserView.includes(server.auth) || browserView.includes(Buffer.from(server.auth.slice(6), 'base64').toString().slice(9)) };
    report('S5-loopback', evidence);
    verifySecurity(evidence);
  } finally { proxy.close(); }
}

function validCalls(traces: Probe['traces'], slots: string[]) {
  const index = traces.findIndex((trace) => trace.calls.length > 0);
  const first = traces[index];
  if (index < 0 || !first || first.status !== 200 || !first.streaming || !first.done || first.calls.length !== slots.length) return false;
  if (traces.reduce((count, trace) => count + trace.calls.length, 0) !== slots.length) return false;
  const returned = new Set(traces.slice(index + 1).flatMap((trace) => trace.returned));
  try {
    const observed = first.calls.map((call) => (JSON.parse(call.args) as { slot?: string }).slot).sort();
    const ids = new Set(first.calls.map((call) => call.id));
    return JSON.stringify(observed) === JSON.stringify([...slots].sort()) && ids.size === slots.length && [...ids].every((id) => id && returned.has(id));
  } catch { return false; }
}

async function gateway(server: Server, probe: Probe, listed: Set<string>, capabilitiesOnly: boolean, fixtureOnly = false) {
  const scopedTurn = async (model: string, mode: 'forced' | 'none' | 'default', prompt: string, files?: SessionPromptInput['files']) => {
    const scope = probe.openTurn(model, mode, 35_000);
    const variant = mode === 'forced' ? `${model}-forced` : mode === 'none' ? `${model}-none` : model;
    try {
      return { result: await turn(server, variant, `${prompt}\n${scope.nonce}`, files), steps: scope.steps };
    } finally { scope.close(); }
  };
  const healthy: string[] = capabilitiesOnly ? [...workingAliases] : [];
  if (!capabilitiesOnly) for (const model of [...workingAliases, ...candidateAliases].filter((name) => listed.has(name) || workingAliases.includes(name))) {
    const before = probe.traces.length;
    const { result } = await scopedTurn(model, 'default', 'Reply only with READY-P0. Do not call tools.');
    const traces = probe.traces.slice(before);
    const ok = result.outcome === 'succeeded' && result.finalText.trim() === 'READY-P0' && traces.length === 1 && traces[0].status === 200;
    if (ok && workingAliases.includes(model)) healthy.push(model);
    report('S2-health', { alias: model, ok, status: traces.at(-1)?.status ?? null, modelMissing: traces.at(-1)?.modelMissing ?? false, outcome: result.outcome });
  }
  if (!capabilitiesOnly) report('S2-absent-candidates', { count: candidateAliases.filter((alias) => !listed.has(alias)).length });

  let streak = 0;
  let maxStreak = 0;
  let fragmented = 0;
  let parallel = 0;
  const runs = new Map(workingAliases.map((alias) => [alias, [] as boolean[]]));
  if (!capabilitiesOnly) for (let run = 0; run < 20; run++) {
    const model = workingAliases[run % workingAliases.length];
    if (!healthy.includes(model)) continue;
    const slots = run % 4 < 2 ? ['north', 'south'] : ['south'];
    const start = probe.traces.length;
    const startTools = probe.toolRuns.length;
    const { result } = await scopedTurn(model, 'default', `Call the fixture lookup tool for ${slots.join(' and ')} in the same tool step. After results, reply only with the returned tokens separated by spaces.`);
    const traces = probe.traces.slice(start);
    const executed = probe.toolRuns.slice(startTools);
    const ok = result.outcome === 'succeeded' && validCalls(traces, slots) &&
      verifyToolAnswer(traces, result.finalText, slots.map((slot) => tokenFor.get(slot)!)) &&
      executed.every((call) => call.valid) && executed.map((call) => call.slot).sort().join(',') === slots.join(',');
    runs.get(model)!.push(ok);
    fragmented += Number(ok && traces.some((trace) => trace.calls.some((call) => call.fragments > 1)));
    parallel += Number(ok && slots.length > 1);
    streak = ok ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
    report('S2-tool-turn', { run: run + 1, alias: model, ok, outcome: result.outcome, status: traces.at(-1)?.status ?? null, calls: traces[0]?.calls.length ?? 0, fixtureCalls: probe.toolRuns.length - startTools });
  }
  if (!capabilitiesOnly) {
    report('S2-tool-summary', { maxStreak, fragmented, parallel, runs: Object.fromEntries([...runs].map(([alias, results]) => [alias, results.filter(Boolean).length])) });
    verifyAliasRuns(workingAliases, new Set(healthy), runs);
    check('S2', { consecutive: maxStreak === 20, fragmented: fragmented > 0, parallel: parallel === 10 });
    return;
  }

  for (const model of healthy) {
    for (const test of ['forced', 'none', 'schema', 'tool-failure', 'image', 'pdf'] as const) {
      if (fixtureOnly && test !== 'forced') continue;
      const from = probe.traces.length;
      const toolFrom = probe.toolRuns.length;
      let result: Awaited<ReturnType<typeof turn>>;
      let ok: boolean;
      if (test === 'forced') {
        const deadlineMs = 35_000;
        const started = performance.now();
        const { result: completed, steps } = await scopedTurn(model, 'forced',
          'Call the fixture lookup tool once for the north slot. After receiving its result, reply with only the returned token.');
        const elapsedMs = Math.ceil(performance.now() - started);
        const traces = probe.traces.slice(from);
        const fixtureCalls = probe.toolRuns.slice(toolFrom);
        const firstForced = !!steps.first?.parallel && steps.first.finish === 'tool_calls';
        const toolResultReturned = steps.followUp?.choice === 'none' && steps.followUp.status === 200 &&
          steps.followUp.streaming && steps.followUp.done && steps.followUp.finish === 'stop';
        const finalTextMatched = completed.finalText.trim() === tokenFor.get('north');
        ok = firstForced && toolResultReturned && finalTextMatched && completed.outcome === 'succeeded' &&
          elapsedMs <= deadlineMs && steps.rejected === 0 && validCalls(traces, ['north']) &&
          fixtureCalls.length === 1 && fixtureCalls[0].slot === 'north' && fixtureCalls[0].valid;
        report('S2-forced-turn', { alias: model, ok, outcome: completed.outcome, elapsedMs, deadlineMs,
          firstForced, toolResultReturned, finalTextMatched, fixtureCalls: fixtureCalls.length,
          modelCalls: traces.reduce((count, trace) => count + trace.calls.length, 0), rejected: steps.rejected });
        if (!ok) process.exitCode = 1;
        continue;
      } else if (test === 'none') {
        ({ result } = await scopedTurn(model, 'none', 'Do not call tools. Reply exactly READY-P0.'));
        ok = probe.traces.at(from)?.choice === 'none' && result.finalText.trim() === 'READY-P0' && probe.toolRuns.length === toolFrom;
      } else if (test === 'schema') {
        const scope = probe.openTurn(model, 'none', 35_000);
        try { result = await turn(server, `${model}-schema`, `Emit JSON with the sole key code and value VIOLET-92.\n${scope.nonce}`); }
        finally { scope.close(); }
        let schemaValid = false;
        try {
          const decoded: unknown = JSON.parse(result.finalText);
          schemaValid = typeof decoded === 'object' && decoded !== null && Object.keys(decoded).length === 1 &&
            'code' in decoded && decoded.code === 'VIOLET-92';
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        ok = probe.traces.at(from)?.format === 'json_schema' && schemaValid;
      } else if (test === 'tool-failure') {
        ({ result } = await scopedTurn(model, 'default', 'Call the fixture lookup tool for slot missing exactly once, then report the failure marker verbatim.'));
        const runs = probe.toolRuns.slice(toolFrom);
        ok = runs.length === 1 && runs[0].slot === 'missing' && !runs[0].valid && result.finalText.trim() === 'SYNTHETIC_TOOL_FAILURE';
      } else {
        const name = test === 'image' ? 'marker.png' : 'marker.pdf';
        const mime = test === 'image' ? 'image/png' : 'application/pdf';
        const expected = test === 'image' ? 'ORBIT-7349' : 'PRINT-2746';
        const bytes = readFileSync(`/work/tests/fixtures/attachments/${name}`);
        ({ result } = await scopedTurn(model, 'default', 'Return only the exact visible code in this synthetic attachment.', [{ uri: `data:${mime};base64,${bytes.toString('base64')}`, name }]));
        ok = result.finalText.trim() === expected;
      }
      report('S2-capability', { alias: model, capability: test, ok: ok && result.outcome === 'succeeded', outcome: result.outcome, status: probe.traces.at(from)?.status ?? null });
      if (!ok || result.outcome !== 'succeeded' || probe.traces.at(from)?.status !== 200) process.exitCode = 1;
    }
  }
}

async function failures(server: Server, probe: Probe) {
  for (const model of mockAliases.filter((alias) => alias !== 'probe-model' && alias !== 'slow-model')) {
    const from = probe.traces.length;
    const { outcome } = await turn(server, model, 'Reply with the synthetic marker.', undefined, 8000);
    const traces = probe.traces.slice(from);
    const statuses = [...new Set(traces.map((trace) => trace.status))];
    const fallback = traces.some((trace) => trace.model !== model);
    report('S2-injected-status', { fault: model, outcome, statuses, attempts: traces.length, fallback });
    const status = Number(model.slice(-3));
    const retryable = status === 429 || status === 503;
    check('S2-injected-status', { statuses: statuses.length === 1 && statuses[0] === status, fallback: !fallback,
      attempts: retryable ? traces.length >= 2 : traces.length === 1, outcome: outcome === (retryable ? 'deadline' : 'failed') });
  }
  const from = probe.traces.length;
  const { outcome } = await turn(server, 'slow-model', 'Wait for the local synthetic delay.', undefined, 300);
  const requested = probe.traces.slice(from).some((trace) => trace.model === 'slow-model');
  report('S2-injected-deadline', { outcome, requested, deadlineMs: 300 });
  check('S2-injected-deadline', { requested, outcome: outcome === 'deadline' });
}

async function main() {
  const mode = process.argv[2];
  if (process.platform !== 'linux' || !['contract', 'contract-relay', 'gateway', 'gateway-capabilities'].includes(mode)) throw new Error('isolated runner required');
  const gatewayMode = mode === 'gateway' || mode === 'gateway-capabilities';
  const fixtureRelay = mode === 'contract-relay';
  const stdin = readFileSync(0, 'utf8');
  const root = mkdtempSync('/tmp/oep-p0-');
  const version = execFileSync(binary, ['--version'], { cwd: root, encoding: 'utf8', env: { HOME: root, OPENCODE_TEST_HOME: root, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  report('S1-cli', { version: version === 'opencode v2.3.2' ? '2.3.2' : 'unexpected', platform: process.platform });
  if (version !== 'opencode v2.3.2') throw new Error('pinned version');
  let step = 'setup';
  const redact = redactFields([syntheticMarker]);
  const probe = await startModelProbe(gatewayMode ? JSON.parse(stdin) : undefined, fixtureRelay ? { request: fixtureGateway, redact } : undefined);
  let server: Server | undefined;
  try {
    step = 'readiness';
    server = await startOpenCode(probe, root, false, gatewayMode || fixtureRelay ? [...workingAliases, ...candidateAliases, ...mockAliases] : mockAliases);
    report('S1-api', { version: server.version === '2.3.2' ? '2.3.2' : 'unexpected' });
    if (server.version !== '2.3.2') throw new Error('pinned version');
    if (gatewayMode) {
      step = 'gateway-status';
      const { status, listed } = await probe.gatewayDiagnostics();
      report('S2-diagnostics', status);
      if (status.liveness !== 200 || status.modelsValid !== 200 ||
          ![401, 403].includes(Number(status.modelsNone)) || ![401, 403].includes(Number(status.modelsWrong))) process.exitCode = 1;
      step = 'gateway-model';
      await gateway(server, probe, listed, mode === 'gateway-capabilities');
    } else if (fixtureRelay) {
      step = 'synthetic-relay';
      await gateway(server, probe, new Set(), false, true);
      await gateway(server, probe, new Set(), true, true);
      const model = workingAliases[0];
      const scope = probe.openTurn(model, 'default', 10_000);
      try {
        const result = await turn(server, model, `Read the redaction fixture.\n${scope.nonce}`, undefined, 10_000);
        const masked = result.transcript === '[redacted]' && result.finalText === '[redacted]';
        report('S2-redacted-transcript', { masked, outcome: result.outcome });
        check('S2-redaction', { masked, succeeded: result.outcome === 'succeeded' });
      } finally { scope.close(); }
    } else {
      const checks = [['client', () => contract(server!, probe)], ['failures', () => failures(server!, probe)],
        ['sse', () => reconnection(server!)], ['security', () => security(server!)], ['automation', () => automation(server!, probe, root)]] as const;
      for (const [name, run] of checks) {
        try { await run(); }
        catch { report('probe-failed', { step: name }); process.exitCode = 1; }
      }
    }
  } catch {
    report('probe-failed', { step });
    process.exitCode = 1;
  } finally {
    if (server) await server.stop();
    probe.close();
  }
}

main().catch((error: unknown) => {
  report('probe-failed', { step: 'setup', ...(error instanceof Error && error.message === 'gateway requires HTTPS' ? { reason: 'gateway requires HTTPS' } : {}) });
  process.exitCode = 1;
});
