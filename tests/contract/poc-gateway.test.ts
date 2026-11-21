import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../apps/adapter/src/opencode/gateway.ts';
import { bufferedCompletion, redactFields } from '../../scripts/phase0/probe-redaction.ts';

test('Relay restricts path, credential, model and redirects, and reports all upstream failures', async () => {
  const traces: GatewayTrace[] = [];
  let calls = 0;
  let nextStatus = 200;
  const key = randomBytes(24).toString('hex');
  const relay = await startGateway({
    url: 'http://example.invalid/v1', key, alias: 'synthetic-model', trace: (trace) => traces.push(trace),
    fetch: async (input, init) => {
      calls++;
      assert.equal(String(input), 'http://example.invalid/v1/chat/completions');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      if (nextStatus === 200) return Response.json({ choices: [{ message: { content: key } }] });
      return new Response(key, { status: nextStatus, headers: { location: 'http://redirect.invalid/' } });
    },
  });
  async function post(model = 'synthetic-model', path = 'chat/completions', token = relay.key) {
    return fetch(`${relay.baseURL}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Synthetic only' }] }),
    });
  }
  try {
    assert.equal((await post('other-model')).status, 400);
    assert.equal((await post(undefined, 'models')).status, 404);
    assert.equal((await post(undefined, undefined, 'denied')).status, 401);
    assert.equal(calls, 0);
    const success = await post();
    assert.equal(success.status, 200);
    assert.match(await success.text(), /\[redacted\]/);
    for (const status of [302, 400, 401, 403, 429, 500, 503]) {
      nextStatus = status;
      const response = await post();
      assert.equal(response.status, status === 302 ? 502 : status);
      assert.ok(!(await response.text()).includes(key));
      assert.equal(traces.at(-1)?.upstreamStatus, status);
    }
    assert.equal(calls, 8);
    assert.equal(traces.length, 11);
  } finally { await relay.close(); }
});

test('An empty upstream completion stays HTTP 200 and records usage without content', async () => {
  const trace = Promise.withResolvers<GatewayTrace>();
  const body = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: 'Internal reasoning' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 } },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  const relay = await startGateway({
    url: 'http://example.invalid/v1', key: randomBytes(24).toString('hex'), alias: 'synthetic-model', trace: trace.resolve,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  try {
    const response = await fetch(`${relay.baseURL}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${relay.key}` },
      body: JSON.stringify({ model: 'synthetic-model', stream: true, messages: [{ role: 'user', content: 'Synthetic only' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\[DONE\]/);
    const result = await trace.promise;
    assert.equal(result.upstreamStatus, 200);
    assert.equal(result.output, 'empty');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.tokens, { prompt: 30, completion: 7, total: 37 });
  } finally { await relay.close(); }
});

test('Buffered redaction protects raw and escaped markers at every SSE frame boundary', async () => {
  const marker = randomBytes(10).toString('hex');
  const redact = redactFields([marker]);
  const escaped = Array.from(marker, (character) => '%25' + character.charCodeAt(0).toString(16)).join('');
  for (const representation of [marker, escaped]) {
    for (let split = 0; split <= representation.length; split++) {
      const parts = ['合成 ' + representation.slice(0, split), representation.slice(split) + ' 文字'];
      const frames = parts.map((content) => ({ choices: [{ index: 0, delta: { content } }] }));
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
      const result = await bufferedCompletion(new Response(body), redact) as typeof frames;
      assert.equal(result.map((frame) => frame.choices[0].delta.content).join(''), '[redacted]');
    }
  }
});
