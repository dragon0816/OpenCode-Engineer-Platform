import assert from 'node:assert/strict';
import test from 'node:test';
import { forcedChoice, requireGatewayURL, startModelProbe, workingAliases } from './model-probe.ts';
import { redactFields } from './probe-redaction.ts';
import { sse } from './probe-http.ts';

const model = workingAliases[0];
const tools = [{ function: { name: 'fixture_lookup' } }];
const textResult = { role: 'tool', tool_call_id: 'call_fixture', content: 'AMBER-812' };
const frame = (delta: object, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const completion = (...frames: object[]) => new Response(`${frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`);

test('live relay requires HTTPS and rejects unsafe URL syntax without exposing its value', () => {
  for (const url of ['http://fixture.invalid/v1', 'http://127.0.0.1/v1', 'not a URL', 'https://fixture.invalid/v1?x=y']) {
    assert.throws(() => requireGatewayURL(url), (error: Error) => !error.message.includes(url));
  }
  assert.equal(requireGatewayURL('https://fixture.invalid:8443/v1').protocol, 'https:');
});

test('relay binds the caller and both forced requests to a live operation and tool result', async () => {
  const seen: unknown[] = [];
  const probe = await startModelProbe(undefined, { redact: (value) => value, request: async (body) => {
    seen.push(body.tool_choice);
    return !body.messages?.some((message) => message.role === 'tool')
      ? completion(frame({ tool_calls: [{ index: 0, id: 'call_fixture', function: { name: 'fixture_lookup', arguments: '{"slot":"north"}' } }] }, 'tool_calls'))
      : completion(frame({ content: 'AMBER-812' }, 'stop'));
  } });
  try {
    const scope = probe.openTurn(model, 'forced', 10_000);
    const send = (options: { nonce?: string; auth?: string; choice?: unknown; alias?: string; result?: unknown } = {}) => fetch(`${probe.endpoint.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: options.auth ?? `Bearer ${probe.apiKey}` },
      body: JSON.stringify({ model: options.alias ?? model, stream: true, tools, tool_choice: options.choice ?? forcedChoice,
        messages: [{ role: 'user', content: `fixture ${options.nonce ?? scope.nonce}` }, ...options.result ? [options.result] : []] }),
    });
    assert.equal((await send({ auth: 'wrong' })).status, 401);
    assert.equal((await send({ alias: workingAliases[1] })).status, 409);
    assert.equal((await send({ choice: 'required' })).status, 400);
    assert.equal((await send({ choice: 'auto' })).status, 409);
    assert.equal((await send({ nonce: 'missing' })).status, 409);
    assert.equal((await send()).status, 200);
    assert.equal((await send({ result: textResult })).status, 200);
    assert.equal((await send({ result: textResult })).status, 409);
    scope.close();
    assert.equal((await send()).status, 409);
    const expired = probe.openTurn(model, 'forced', 0);
    assert.equal((await send({ nonce: expired.nonce })).status, 409);
    assert.deepEqual(seen, [forcedChoice, 'none']);

    const mismatched = probe.openTurn(model, 'forced', 1000);
    assert.equal((await send({ nonce: mismatched.nonce })).status, 200);
    assert.equal((await send({ nonce: mismatched.nonce, result: { ...textResult, tool_call_id: 'other' } })).status, 409);
  } finally { probe.close(); }
});

test('redact reassembled transcript and tool trace, and separate upstream 200 from malformed relay 502', async () => {
  const marker = 'SYNTHETIC+MARKER';
  const host = 'synthetic-gateway.invalid';
  const redact = redactFields([marker, host, `${host}:8443`]);
  const probe = await startModelProbe(undefined, { redact, request: async (body) => body.stream ? completion(
    frame({ content: 'SYNTHETIC%', tool_calls: [{ index: 0, id: 'synthetic-call', function: { name: 'fixture_lookup', arguments: '{"slot":"SYNTH' } }] }),
    frame({ content: '2BMARKER', tool_calls: [{ index: 0, function: { arguments: 'ETIC\\u002bMARKER"}' } }] }),
    frame({ reasoning_content: 'synthetic-gate' }), frame({ reasoning_content: 'way.invalid' }, 'tool_calls'),
  ) : new Response(`invalid json ${marker} ${host}`, { status: 200 }) });
  try {
    const send = async (stream: boolean) => {
      const scope = probe.openTurn(model, 'default', 1000);
      return fetch(`${probe.endpoint.url}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${probe.apiKey}` },
        body: JSON.stringify({ stream, model, messages: [{ role: 'user', content: scope.nonce }] }),
      });
    };
    const reply = await send(true);
    assert.equal(reply.status, 200);
    const transcript: string[] = [];
    for await (const value of sse(reply.body!)) {
      if (value === '[DONE]') break;
      assert.doesNotMatch(value, /SYNTHETIC|synthetic-gate|2BMARKER|002bMARKER/);
      transcript.push(JSON.parse(value).choices[0].delta.content ?? '');
    }
    assert.equal(transcript.join(''), '[redacted]');
    assert.deepEqual(JSON.parse(probe.traces[0].calls[0].args), { slot: '[redacted]' });
    const malformed = await send(false);
    assert.equal(malformed.status, 502);
    assert.doesNotMatch(await malformed.text(), /SYNTHETIC|synthetic-gate/);
    assert.deepEqual(probe.traces.map(({ upstreamStatus, status }) => [upstreamStatus, status]), [[200, 200], [200, 502]]);
  } finally { probe.close(); }
});
