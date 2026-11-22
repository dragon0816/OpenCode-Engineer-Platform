import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { call } from '../../apps/adapter/src/opencode/client.ts';
import { assistantMessages, createSession, promptID, submitOnce } from '../../apps/adapter/src/opencode/sessions.ts';
import { sessionEvents, submissionCount, waitForOutcome } from '../../apps/adapter/src/opencode/reconcile.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const report = (value: object) => console.log(JSON.stringify(value));
report({ event: 'native-contract', root });
const work = [
  { agent: 'workbook', directory: mkdtempSync(join(root, 'writer-')), marker: 'NORTH-73279', tag: 'OEP-CONTRACT-A' },
  { agent: 'inspector', directory: mkdtempSync(join(root, 'inspector-')), marker: 'SOUTH-94837', tag: 'OEP-CONTRACT-B' },
] as const;
for (const item of work) writeFileSync(join(item.directory, 'marker.txt'), item.marker);

let concurrent = 0;
let maxConcurrent = 0;
const seen = new Map<string, Map<string, string>>();
const defects: string[] = [];

function resultText(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content) && content.length > 0 && content.every((part) =>
    part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')) {
    return content.map((part) => part.text).join('\n');
  }
  throw new Error('Unexpected tool result content shape');
}

const fixture: typeof fetch = async (_input, init) => {
  try {
    const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
    const user = JSON.stringify(messages.find((message) => message.role === 'user')?.content);
    const nonce = user?.match(/READY-[A-F0-9]{8}/)?.[0];
    if (nonce) return completion(model, [{ role: 'assistant', content: nonce }], 'stop');
    const item = work.find((candidate) => user?.includes(candidate.tag));
    assert.ok(item, 'Unknown synthetic session');
    const other = work.find((candidate) => candidate !== item)!;
    const results = messages.filter((message) => message.role === 'tool');
    const ids = { own: `call_${item.tag}_own`, foreign: `call_${item.tag}_foreign`, write: `call_${item.tag}_write` };
    if (!results.length) {
      assert.ok(tools?.some((tool) => tool.function?.name === 'read'), 'OpenCode did not expose read');
      concurrent++;
      maxConcurrent = Math.max(concurrent, maxConcurrent);
      try { await delay(1_500, undefined, { signal: init?.signal ?? undefined }); }
      finally { concurrent--; }
      return completion(model, [
        ...toolCall(0, ids.own, 'read', { path: 'marker.txt' }),
        ...toolCall(1, ids.foreign, 'read', { path: join(other.directory, 'marker.txt') }),
        ...toolCall(2, ids.write, 'write', { path: 'program.js', content: '/* synthetic writer only */' }),
      ], 'tool_calls');
    }
    assert.equal(results.length, 3, 'Wrong number of tool results');
    const outcomes = new Map(results.map((result) => [result.tool_call_id ?? '', resultText(result.content)]));
    assert.equal(outcomes.size, 3, 'Duplicate tool call IDs');
    assert.match(outcomes.get(ids.own) ?? '', new RegExp(item.marker), 'Own marker missing from tool result');
    assert.ok(outcomes.has(ids.foreign) && !outcomes.get(ids.foreign)!.includes(other.marker), 'Foreign marker surfaced');
    assert.match(outcomes.get(ids.foreign) ?? '', /permission|denied|blocked|external/i, 'Foreign path was not denied');
    assert.ok(outcomes.has(ids.write), 'Write result missing');
    if (item.agent === 'inspector') assert.match(outcomes.get(ids.write) ?? '', /permission|denied|blocked|not found|unknown|available/i);
    seen.set(item.tag, outcomes);
    return completion(model, [{ role: 'assistant', content: `DONE-${item.tag}` }], 'stop');
  } catch (error) {
    defects.push(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Malformed tool result');
    return new Response(null, { status: 400 });
  }
};

async function main() {
  const alias = 'synthetic-native';
  const runtime = await startRuntime(root, {
    url: 'http://example.invalid/v1', key: randomBytes(24).toString('hex'), alias, fetch: fixture,
  });
  try {
    const { client, endpoint } = runtime;
    assert.equal(runtime.unauthenticated, 401);
    assert.equal(runtime.ipv4, 1);
    const [a, b] = await Promise.all(work.map((item) => createSession(client, item.directory, item.agent, alias)));
    assert.notEqual(a, b);
    const denied = await client.permission.create({ sessionID: b, action: 'edit', resources: ['program.js'] }, call());
    assert.equal(denied.effect, 'deny');
    const allowed = await client.permission.create({ sessionID: a, action: 'edit', resources: ['program.js'] }, call());
    assert.equal(allowed.effect, 'allow');
    const wrong = await client.permission.create({ sessionID: a, action: 'external_directory', resources: ['foreign'] }, call());
    assert.equal(wrong.effect, 'deny');
    const signal = AbortSignal.timeout(20_000);
    const before = sessionEvents(endpoint, a, signal);
    try {
      assert.deepEqual(await before.next(), { value: 'server.connected', done: false });
      const submissions = [promptID(), promptID()];
      const sessions = [a, b];
      const [admissions, first] = await Promise.all([
        Promise.all(sessions.map((sessionID, index) =>
          submitOnce(client, { sessionID, id: submissions[index], text: `Read the synthetic marker for ${work[index].tag}.` }))),
        (async () => {
          for await (const event of before) if (event === 'session.execution.started') return event;
        })(),
      ]);
      assert.deepEqual(admissions, ['accepted', 'accepted']);
      assert.equal(first, 'session.execution.started');
      const outcomes = await Promise.all(sessions.map((id) => waitForOutcome(client, id)));
      assert.deepEqual(defects, []);
      assert.deepEqual(outcomes, ['succeeded', 'succeeded']);
      const reconnected = sessionEvents(endpoint, a, AbortSignal.timeout(5_000));
      const reconciledAt = Date.now();
      try {
        assert.deepEqual(await reconnected.next(), { value: 'server.connected', done: false });
        const counts = await Promise.all(sessions.map((id, index) => submissionCount(client, id, submissions[index])));
        assert.deepEqual(counts, [{ inbox: 0, messages: 1 }, { inbox: 0, messages: 1 }]);
        assert.deepEqual(await submissionCount(client, b, submissions[0]), { inbox: 0, messages: 0 });
      } finally { await reconnected.return(undefined); }
      const texts = await Promise.all(sessions.map((id) => assistantMessages(client, id)));
      texts.forEach((messages, index) => {
        const final = messages.at(-1)?.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        assert.equal(final, `DONE-${work[index].tag}`);
      });
      assert.equal(maxConcurrent, 2);
      assert.equal(seen.size, 2);
      assert.equal(readFileSync(join(work[0].directory, 'program.js'), 'utf8'), '/* synthetic writer only */');
      assert.equal(existsSync(join(work[1].directory, 'program.js')), false);
      report({ native: runtime.version, auth: runtime.unauthenticated, maxConcurrent, sessionCount: sessions.length,
        externalReadDenied: 2, inspectorWriteDenied: true, distinctAgents: true, matchedToolResults: 6,
        reconnected: true, reconcileMs: Date.now() - reconciledAt, duplicateSubmissions: 0 });
    } finally { await before.return(undefined); }
  } finally {
    const result = await runtime.stop();
    report({ event: 'stop', ...result });
    assert.equal(result.supervisorExit, 0);
    assert.equal(result.childExit, 0);
    assert.equal(result.orphans, 0);
  }
}

try { await main(); }
catch (error) {
  report({ defects });
  if (error instanceof assert.AssertionError) console.error(error.message);
  else console.error('Native contract failed. See the local runtime audit directory.');
  process.exitCode = 1;
}
