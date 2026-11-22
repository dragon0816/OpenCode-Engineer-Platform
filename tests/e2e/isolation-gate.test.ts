import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { call } from '../../apps/adapter/src/opencode/client.ts';
import { startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import { knowledgeMcpName, knowledgeToolName } from '../../apps/adapter/src/opencode/knowledge-mcp.ts';
import { waitForOutcome } from '../../apps/adapter/src/opencode/reconcile.ts';
import { createSession, promptID, submitOnce } from '../../apps/adapter/src/opencode/sessions.ts';
import { turnMarker } from '../../apps/adapter/src/opencode/turn-limits.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { supervise } from '../../apps/launcher/src/supervisor.ts';
import { jsonInput, send } from '../../scripts/phase0/probe-http.ts';
import { bufferedCompletion } from '../../scripts/phase0/probe-redaction.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { dataDirectory } from './test-data.ts';

const alias = 'synthetic-isolation-gate';
const tool = `${knowledgeMcpName}_${knowledgeToolName}`;
const hidden = `${knowledgeMcpName}_hidden`;
const transport = '_oep_transport_token';
const deny = { action: '*', resource: '*', effect: 'deny' } as const;
const allow = { action: tool, resource: '*', effect: 'allow' } as const;
const transportValue = 'synthetic-relay-field';
const originalArgs = { sample: 'fixture' };
const codecCases = ['sse', 'denied'] as const;
type CodecCase = typeof codecCases[number];
type ToolFunction = { name?: string; arguments?: string; parameters?: {
  properties: Record<string, unknown>; required: string[];
} };
type ModelBody = Omit<WireRequest, 'tools'> & { stream: boolean; tools?: { function?: ToolFunction }[] };
type CompletionCall = { id?: string; index?: number; function: ToolFunction };
type Frame = { choices: { delta?: { tool_calls?: CompletionCall[] } }[] };

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const errors: string[] = [];
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      errors.push(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Invalid probe request');
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` as const, errors,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

function modelView(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\n\[OEP policy_nonce: [a-f0-9]{64}\]$/g, '')
      .replace(/,?"_oep_transport_token":"synthetic-relay-field"/g, '');
  }
  if (Array.isArray(value)) return value.map(modelView);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== transport).map(([key, item]) => [key, modelView(item)]));
  }
  return value;
}

function addTransport(calls: CompletionCall[]) {
  const head = calls[0].function;
  if (head.name !== tool) return false;
  assert.ok(calls[0].id, 'Missing native tool call ID');
  assert.ok(calls.every((part) => part.index === calls[0].index), 'Tool delta index changed');
  const args = JSON.parse(calls.map((part) => part.function.arguments ?? '').join(''));
  assert.deepEqual(args, originalArgs, 'Unexpected synthetic model arguments');
  head.arguments = JSON.stringify({ ...args, [transport]: transportValue });
  for (const call of calls.slice(1)) call.function.arguments = '';
  return true;
}

test('pinned OpenCode transports relay-owned MCP arguments in SSE', { timeout: 120_000 }, async (context) => {
  const root = dataDirectory();
  const mcpKey = randomBytes(32).toString('hex');
  const relayKey = randomBytes(32).toString('hex');
  const inputs: { name?: string; arguments?: unknown }[] = [];
  const observed = { streams: [] as boolean[], replayContext: 0, denied: 0 };
  let current: { codec: CodecCase; nonce: string } | undefined;
  const mcp = await listen(async (request, response) => {
    assert.ok(request.headers.authorization === `Bearer ${mcpKey}`, 'MCP fixture authentication failed');
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
    const input = await jsonInput<{ id?: unknown; method: string; params: { name?: string; arguments?: unknown } }>(request);
    if (input.id === undefined) { response.writeHead(202).end(); return; }
    const reply = (result: unknown) => send(response, 200, { jsonrpc: '2.0', id: input.id, result });
    if (input.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'synthetic-isolation', version: '1' } });
    if (input.method === 'tools/list') return reply({ tools: [knowledgeToolName, 'hidden'].map((name) => ({
      name, description: 'Return a synthetic receipt.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['sample', transport],
        properties: { sample: { type: 'string' }, [transport]: { type: 'string' } } },
    })) });
    assert.ok(input.method === 'tools/call', 'Unexpected MCP method');
    inputs.push(input.params);
    reply({ content: [{ type: 'text', text: 'synthetic receipt' }] });
  });
  context.after(mcp.close);
  const relay = await listen(async (request, response) => {
    assert.ok(request.headers.authorization === `Bearer ${relayKey}`, 'Relay fixture authentication failed');
    const body = await jsonInput<ModelBody>(request);
    if (!current || !JSON.stringify(body.messages.filter(({ role }) => role === 'user')).includes(current.nonce)) {
      response.writeHead(409).end();
      return;
    }
    const { codec } = current;
    const advertised = body.tools?.find((entry) => entry.function?.name === tool)?.function?.parameters;
    assert.ok(advertised?.properties[transport] && advertised.required.includes(transport), 'Native MCP schema lost the transport field');
    assert.ok(!body.tools?.some((entry) => entry.function?.name === hidden), 'Native permissions advertised the denied MCP tool');
    const model = modelView(body) as ModelBody;
    model.tools = model.tools?.filter((entry) => entry.function?.name === tool);
    const parameters = model.tools?.[0].function?.parameters;
    assert.ok(parameters, 'Model allowlist lost the permitted tool');
    parameters.required = parameters.required.filter((name) => name !== transport);
    assert.ok(!JSON.stringify(model).includes(current.nonce), 'Nonce reached the synthetic model');
    assert.ok(!JSON.stringify(model).includes(transport), 'Transport field reached the synthetic model');
    assert.deepEqual(model.tools?.map((entry) => entry.function?.name), [tool], 'Hidden tool reached the synthetic model');
    if (model.messages.some(({ role }) => role === 'tool')) {
      observed.replayContext++;
      const done = completion(alias, [{ role: 'assistant', content: 'synthetic done' }], 'stop');
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(await done.text());
      return;
    }
    observed.streams.push(body.stream);
    const callID = 'call_synthetic_' + codec;
    const fixture = completion(alias, toolCall(0, callID, codec === 'denied' ? hidden : tool, originalArgs), 'tool_calls');
    const frames = await bufferedCompletion(fixture, (value) => value);
    const calls = (frames as unknown as Frame[]).flatMap((frame) => frame.choices.flatMap(({ delta }) => delta?.tool_calls ?? []));
    if (!addTransport(calls)) {
      observed.denied++;
      response.writeHead(422).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  context.after(relay.close);
  const runtime = await supervise(root, { baseURL: relay.url + '/v1', key: relayKey }, [alias], undefined,
    { type: 'remote', url: `${mcp.url}/mcp`, headers: { Authorization: `Bearer ${mcpKey}` },
      oauth: false, codemode: false, timeout: { execution: 80_000 } }, true);
  context.after(async () => {
    const stop = await runtime.stop();
    assert.deepEqual({ version: runtime.version, supervisorExit: stop.supervisorExit,
      childExit: stop.childExit, orphans: stop.orphans }, { version: '2.3.2', supervisorExit: 0, childExit: 0, orphans: 0 });
    context.diagnostic(`OpenCode ${runtime.version}, supervisorExit=${stop.supervisorExit}, childExit=${stop.childExit}, orphans=${stop.orphans}`);
    assert.deepEqual([...relay.errors, ...mcp.errors], []);
  });
  const { client } = runtime.endpoint;

  for (const codec of codecCases) {
    await context.test(codec, async () => {
      const workspace = mkdtempSync(join(root, 'gate-'));
      const sessionID = await createSession(client, workspace, 'inspector', alias);
      const permission = async (action: string) => (await client.permission.create({ sessionID, action, resources: ['fixture'] }, call())).effect;
      await client.session.update({ sessionID, permissions: [allow, deny] }, call());
      assert.equal(await permission(tool), 'deny', 'Last matching permission did not win');
      await client.session.update({ sessionID, permissions: [deny, allow] }, call());
      assert.equal(await permission(tool), 'allow', 'Permission replacement did not restore the explicit tool');
      await client.session.update({ sessionID, permissions: [deny] }, call());
      assert.equal(await permission(tool), 'deny', 'A replaced permission set retained the previous allow');
      await client.session.update({ sessionID, permissions: [deny, allow] }, call());
      assert.equal(await permission(hidden), 'deny', 'Hidden tool became allowed');
      for (const action of ['bash', 'webfetch', 'task', 'read', 'edit', 'external_directory']) {
        assert.equal(await permission(action), 'deny', `Native permission exposed ${action}`);
      }
      const runID = randomUUID();
      const submissionID = promptID();
      const nonce = randomBytes(32).toString('hex');
      const previousCalls = inputs.length;
      current = { codec, nonce };
      try {
        const admitted = await submitOnce(client, { sessionID, id: submissionID,
          text: `Synthetic ${codec} probe` + turnMarker(runID) + `Gate instructions\n[OEP policy_nonce: ${nonce}]` });
        assert.equal(admitted, 'accepted');
        const outcome = await waitForOutcome(client, sessionID, undefined, 15_000, undefined, submissionID);
        const calls = inputs.slice(previousCalls);
        if (codec === 'denied') {
          assert.equal(observed.denied, 1);
          assert.deepEqual(calls, [], 'Denied model tool reached the MCP listener');
          assert.notEqual(outcome, 'succeeded');
          return;
        }

        assert.equal(observed.streams.at(-1), true, 'Pinned OpenCode did not request SSE');
        assert.deepEqual(calls.map(({ name, arguments: args }) => [name, args]),
          [[knowledgeToolName, { ...originalArgs, [transport]: transportValue }]]);
        assert.equal(outcome, 'succeeded');
        assert.ok(observed.replayContext > 0, 'Native model context did not replay a tool result');

        const store = new WebStore(join(workspace, 'web.sqlite'));
        try {
          const session = { id: randomUUID(), upstreamID: sessionID, agent: 'inspector', alias,
            project: 'default', createdAt: Date.now() } as const;
          const chat = new ChatService(store, { client, alias, aliases: [alias], gatewayCursor: () => 0,
            gatewaySince: () => [], setTurnBoundary: () => {}, redact: (text) => text }, workspace, join(workspace, 'audit'), () => {});
          store.createSession(session);
          store.saveTurn(session.id, { id: runID, state: 'accepted', mode: 'web-chat', workspace, alias,
            sessionID, submissionID, createdAt: Date.now(), retries: 0, errors: [] }, 'synthetic');
          const state = await chat.state(session);
          assert.ok(state.messages?.some(({ text }) => text === `Synthetic ${codec} probe`), 'Projected user message was unavailable');
          assert.ok(state.messages?.some(({ tools }) => tools?.some(({ status }) => status === 'done')), 'Projected MCP result was unavailable');
          const projection = JSON.stringify(state);
          assert.ok(!projection.includes(nonce) && !projection.includes('policy_nonce'), 'Nonce reached Web state');
          assert.ok(!projection.includes(transportValue) && !projection.includes(transport), 'Transport field reached Web state');
        } finally { store.close(); }
      } finally { current = undefined; }
    });
  }
});

test('the production OpenCode relay serves SSE and fails closed on non-streaming tool requests', async (context) => {
  let json = false;
  let requests = 0;
  const relay = await startGateway({ alias, url: 'http://example.invalid', key: randomUUID(), managed: true,
    trace: () => {}, fetch: async () => {
      requests++;
      return json ? Response.json({ choices: [{ message: { content: 'synthetic' }, finish_reason: 'stop' }] }) :
        completion(alias, [{ role: 'assistant', content: 'synthetic' }], 'stop');
    } });
  context.after(relay.close);
  const request = (fields: object) => fetch(`${relay.baseURL}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${relay.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Synthetic' }], ...fields }),
  });
  const sse = await request({ stream: true });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');
  assert.match(await sse.text(), /data: \[DONE\]/);
  json = true;
  const wrongFormat = await request({ stream: true });
  assert.equal(wrongFormat.status, 502);
  assert.ok(!(await wrongFormat.text()).includes('choices'));
  for (const stream of [false, undefined, 'true', 1, null]) {
    const rejected = await request({ stream, tools: [{ type: 'function', function: { name: tool } }] });
    assert.equal(rejected.status, 400);
    await rejected.body?.cancel();
  }
  assert.equal(requests, 2, 'Rejected tool requests reached the upstream gateway');
});
