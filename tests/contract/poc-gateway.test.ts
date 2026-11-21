import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { startGateway } from '../../apps/adapter/src/opencode/gateway.ts';
import type { GatewayTrace } from '../../apps/adapter/src/opencode/gateway.ts';

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
