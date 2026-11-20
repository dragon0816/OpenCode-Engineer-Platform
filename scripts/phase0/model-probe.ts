import type { ServerResponse } from 'node:http';
import { listen, jsonInput, pause, send, sse } from './probe-http.ts';

export const workingAliases = ['gpt-5.4-mini', 'claude-haiku-4-5-20251001'];
export const candidateAliases = ['qwen-36-27b', 'gemma-4-31b', 'gpt-5.5', 'gpt-5.6', 'claude-sonnet-5', 'claude-opus-5'];
export const tokenFor = new Map([['north', 'AMBER-812'], ['south', 'INDIGO-416']]);
export const forcedChoice = { type: 'function', function: { name: 'fixture_lookup' } };
const faults = new Map([['auth401', 401], ['forbidden403', 403], ['limited429', 429], ['server503', 503], ['long400', 400]]);
export const mockAliases = ['probe-model', 'slow-model', ...faults.keys()];

type GatewayInput = { OEP_LITELLM_BASE_URL?: string; OEP_LITELLM_API_KEY?: string };
type Request = {
  model: string;
  stream?: boolean;
  messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: { type?: string };
};
type ToolDelta = { index: number; id?: string; function?: { name?: string; arguments?: string } };
type Call = { id: string; name: string; args: string; fragments: number };
export type Trace = {
  model: string; status: number; streaming: boolean; calls: Call[]; returned: string[]; done: boolean;
  choice: unknown; parallel: boolean; format?: string; toolCount: number; modelMissing?: boolean; finish?: string;
};
type ForcedSteps = { model: string; first?: Trace; followUp?: Trace; rejected: number };

function isFixtureChoice(choice: unknown): boolean {
  const option = choice as { type?: string; function?: { name?: string } } | null | undefined;
  return option?.type === forcedChoice.type && option.function?.name === forcedChoice.function.name;
}

function applyForcedStep(body: Request, trace: Trace, steps: ForcedSteps): boolean {
  if (body.model !== steps.model || !body.tools?.some((tool) => tool.function?.name === forcedChoice.function.name)) return false;
  if (!steps.first && trace.returned.length === 0) {
    steps.first = trace;
    return true;
  }
  const first = steps.first;
  const call = first?.calls[0];
  const results = body.messages?.filter((message) => message.role === 'tool');
  const expected = tokenFor.get('north')!;
  if (steps.followUp || !first?.done || first.calls.length !== 1 || !call?.id || call.name !== forcedChoice.function.name ||
      results?.length !== 1 || results[0].tool_call_id !== call.id || !JSON.stringify(results[0].content)?.includes(expected)) return false;

  // The isolated OpenCode model sets the choice on every request; release it only after the matching fixture result.
  body.tool_choice = trace.choice = 'none';
  steps.followUp = trace;
  return true;
}

function failure(response: ServerResponse, status: number) {
  send(response, status, { error: { message: `Synthetic probe transport status ${status}`, type: 'probe_status' } });
}

function mockCompletion(response: ServerResponse, body: Request, answer = 'READY-P0') {
  const base = { id: 'chatcmpl-synthetic', created: 1, model: body.model };
  if (!body.stream) {
    send(response, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] });
    return;
  }
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`${chunk({ role: 'assistant', content: answer }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
}

function gatewayConfig(input: GatewayInput) {
  if (!input.OEP_LITELLM_BASE_URL || !input.OEP_LITELLM_API_KEY) throw new Error('missing gateway input');
  const url = new URL(input.OEP_LITELLM_BASE_URL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid gateway input');
  }
  const root = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '');
  const key = input.OEP_LITELLM_API_KEY;
  const privateValues = [...new Set([key, input.OEP_LITELLM_BASE_URL, url.origin, url.host])]
    .sort((a, b) => b.length - a.length);
  const redact = (value: string) => privateValues.reduce((text, secret) =>
    text.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]'), value);
  const request = async (path: '/v1/models' | '/health/liveliness' | '/v1/chat/completions', keyMode: 'valid' | 'wrong' | 'none', body?: Request) => {
    const target = new URL(url);
    target.pathname = `${root}${path}`;
    const headers: Record<string, string> = {};
    if (keyMode !== 'none') headers.authorization = `Bearer ${keyMode === 'valid' ? key : 'phase0-deliberately-invalid'}`;
    if (body) headers['content-type'] = 'application/json';
    return fetch(target, { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(body ? 24_000 : 8_000) });
  };
  return { request, redact };
}

async function forwardStream(upstream: Response, response: ServerResponse, trace: Trace, redact: (text: string) => string) {
  if (!upstream.body) throw new Error('empty stream');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const calls = new Map<number, Call>();
  for await (const frame of sse(upstream.body)) {
    const data = redact(frame);
    if (data === '[DONE]') {
      trace.calls = [...calls.values()];
      trace.done = true;
    } else {
      const event = JSON.parse(data) as { error?: unknown; choices?: Array<{ delta?: { tool_calls?: ToolDelta[] }; finish_reason?: string | null }> };
      if (event.error) throw new Error('upstream stream error');
      const choice = event.choices?.[0];
      if (choice?.finish_reason) trace.finish = choice.finish_reason;
      for (const part of choice?.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', args: '', fragments: 0 };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) {
          call.args += part.function.arguments;
          call.fragments++;
        }
        calls.set(part.index, call);
      }
    }
    response.write(`data: ${data}\n\n`);
  }
  trace.calls = [...calls.values()];
  response.end();
}

export async function startModelProbe(gateway?: GatewayInput) {
  const gatewayConnection = gateway && gatewayConfig(gateway);
  const traces: Trace[] = [];
  const toolRuns: Array<{ slot: string; valid: boolean }> = [];
  let requests = 0;
  let forcedSteps: ForcedSteps | undefined;
  const allowedModels = new Set([...workingAliases, ...candidateAliases]);
  const endpoint = await listen(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return send(response, 404);
    const body = await jsonInput<Request>(request);
    const { model } = body;
    if (typeof model !== 'string') return failure(response, 400);
    const trace: Trace = {
      model, status: 0, streaming: body.stream === true, calls: [], done: false,
      returned: (body.messages ?? []).filter((item) => item.role === 'tool').map((item) => item.tool_call_id ?? ''),
      choice: body.tool_choice, parallel: body.parallel_tool_calls === true, format: body.response_format?.type,
      toolCount: body.tools?.length ?? 0,
    };
    traces.push(trace);
    if (!gatewayConnection || faults.has(model) || model === 'slow-model') {
      if (model === 'slow-model') {
        await pause(650);
        if (!response.destroyed) mockCompletion(response, body);
      } else if (faults.has(model)) {
        trace.status = faults.get(model)!;
        failure(response, trace.status);
      } else {
        trace.status = 200;
        mockCompletion(response, body);
      }
      return;
    }
    if (typeof body.tool_choice === 'object' && body.tool_choice !== null &&
        (!forcedSteps || !isFixtureChoice(body.tool_choice) || !applyForcedStep(body, trace, forcedSteps))) {
      if (forcedSteps) forcedSteps.rejected++;
      trace.status = 409;
      return failure(response, 409);
    }
    if (!allowedModels.has(model) || ++requests > 60) {
      trace.status = 403;
      return failure(response, 403);
    }
    try {
      const upstream = await gatewayConnection.request('/v1/chat/completions', 'valid', body);
      trace.status = upstream.status;
      if (!upstream.ok) {
        trace.modelMissing = upstream.status === 400 && /model not found/i.test(await upstream.text());
        return failure(response, upstream.status);
      }
      if (body.stream) await forwardStream(upstream, response, trace, gatewayConnection.redact);
      else send(response, upstream.status, JSON.parse(gatewayConnection.redact(JSON.stringify(await upstream.json()))));
    } catch {
      trace.status ||= 504;
      if (response.headersSent) response.destroy();
      else failure(response, trace.status);
    }
  });

  const mcp = await listen(async (request, response) => {
    if (request.method === 'GET') return send(response, 405);
    if (request.method !== 'POST' || request.url !== '/mcp') return send(response, 404);
    const body = await jsonInput<{ id?: unknown; method?: string; params?: { protocolVersion?: string; arguments?: { slot?: string } } }>(request, 8192);
    if (body.id === undefined) return send(response, 202);
    let result: unknown;
    if (body.method === 'initialize') {
      result = { protocolVersion: body.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'phase0-fixture', version: '1.0.0' } };
    } else if (body.method === 'tools/list') {
      result = { tools: [{ name: 'lookup', description: 'Read the synthetic token for a compass slot.', inputSchema: { type: 'object', properties: { slot: { type: 'string', enum: ['north', 'south', 'missing'] } }, required: ['slot'], additionalProperties: false } }] };
    } else if (body.method === 'tools/call') {
      const slot = body.params?.arguments?.slot ?? '';
      const token = tokenFor.get(slot);
      toolRuns.push({ slot, valid: !!token });
      result = { content: [{ type: 'text', text: token ?? 'SYNTHETIC_TOOL_FAILURE' }], isError: !token };
    } else {
      return send(response, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown fixture method' } });
    }
    send(response, 200, { jsonrpc: '2.0', id: body.id, result });
  });

  return {
    endpoint, mcp, traces, toolRuns,
    async forcedTurn<T>(model: string, run: () => Promise<T>) {
      if (forcedSteps || !workingAliases.includes(model)) throw new Error('invalid forced probe scope');
      const steps: ForcedSteps = { model, rejected: 0 };
      forcedSteps = steps;
      try {
        return { result: await run(), steps };
      } finally {
        forcedSteps = undefined;
      }
    },
    async gatewayDiagnostics() {
      if (!gatewayConnection) throw new Error('gateway mode required');
      const cases = [
        ['liveness', '/health/liveliness', 'none'], ['modelsValid', '/v1/models', 'valid'],
        ['modelsNone', '/v1/models', 'none'], ['modelsWrong', '/v1/models', 'wrong'],
      ] as const;
      const status: Record<string, number | 'transport'> = {};
      const listed = new Set<string>();
      for (const [label, path, keyMode] of cases) {
        try {
          const response = await gatewayConnection.request(path, keyMode);
          status[label] = response.status;
          if (label === 'modelsValid' && response.ok) {
            const payload = await response.json() as { data?: Array<{ id?: string }> };
            for (const { id } of payload.data ?? []) if (id && allowedModels.has(id)) listed.add(id);
          } else await response.body?.cancel();
        } catch {
          status[label] = 'transport';
        }
      }
      return { status, listed };
    },
    close() { endpoint.close(); mcp.close(); },
  };
}
