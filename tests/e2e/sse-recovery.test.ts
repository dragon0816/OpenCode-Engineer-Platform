import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { sse, until } from '../../scripts/phase0/probe-http.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { webAPI } from './web-api.ts';

const root = dataDirectory();
const profile = join(root, 'profile');
mkdirSync(profile);
const markers: string[] = [];
const synthetic: typeof fetch = async (_target, init) => {
  const { model, messages } = JSON.parse(String(init?.body)) as WireRequest;
  const content = JSON.stringify(messages.findLast((item) => item.role === 'user')?.content);
  const marker = content.match(/SSE-[AB]-[123]/)?.[0];
  assert.ok(marker);
  markers.push(marker);
  await delay(700, undefined, { signal: init?.signal ?? undefined });
  return completion(model, [{ role: 'assistant', content: marker }], 'stop');
};
const runtime = await startRuntime(root, {
  url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-reconnect', fetch: synthetic,
}, profile);
try {
  const adapter = await startAdapter(root, runtime, () => undefined);
  try {
    const api = await webAPI(adapter.pairURL());
    const paths: string[] = [];
    for (const agent of ['workbook', 'inspector']) {
      const created = await api.post('/api/sessions', { agent });
      assert.equal(created.status, 201);
      paths.push(`/api/sessions/${(await created.json()).id}`);
    }
    async function stream(path: string) {
      const stop = new AbortController();
      const response = await api.get(path + '/events', stop.signal);
      assert.equal(response.status, 200);
      const iterator = sse(response.body!, stop.signal);
      assert.deepEqual(JSON.parse((await iterator.next()).value!), { kind: 'refresh' });
      const kinds: string[] = [];
      const done = (async () => {
        try { for await (const frame of iterator) kinds.push(JSON.parse(frame).kind); }
        catch (error) { if (!stop.signal.aborted) throw error; }
      })();
      void done.catch(() => undefined);
      return { kinds, close: async () => { stop.abort(); await done; } };
    }
    const connections = await Promise.all(paths.map(stream));
    try {
      for (const [index, current] of [0, 1, 0].entries()) {
        const other = 1 - current;
        const path = paths[current];
        const marker = `SSE-${current === 0 ? 'A' : 'B'}-${index + 1}`;
        const input = { id: randomUUID(), text: marker, workbook: false, attachments: [] };
        const remoteEvents = connections[other].kinds.length;
        const currentEvents = connections[current].kinds.length;
        if (index === 0) await connections[current].close();
        assert.equal((await api.post(path + '/turns', input)).status, 202);
        if (index !== 0) {
          await until(async () => connections[current].kinds.slice(currentEvents).includes('working') || undefined, 5_000);
          await connections[current].close();
        }
        const read = async () => (await api.get(path + '/state')).json();
        await until(async () => (await read()).runs.at(-1)?.state === 'verified' || undefined, 7_000);
        const started = performance.now();
        connections[current] = await stream(path);
        const state = await read();
        const elapsedMs = Math.round(performance.now() - started);
        assert.equal(state.runs.at(-1).state, 'verified');
        assert.equal(state.messages.filter((item: { text: string; role: string }) => item.text === marker && item.role === 'user').length, 1);
        assert.equal(state.messages.at(-1).text, marker);
        assert.ok(elapsedMs < 5_000);
        assert.equal((await api.post(path + '/turns', input)).status, 202);
        assert.equal((await api.post(path + '/turns', { ...input, text: 'different text' })).status, 409);
        const { messages } = await (await api.get(paths[other] + '/state')).json();
        assert.ok(!messages.some((message: { text: string }) => message.text === marker));
        assert.ok(!connections[other].kinds.slice(remoteEvents).includes('working'));
        console.log(JSON.stringify({ fault: index + 1, session: current === 0 ? 'A' : 'B', elapsedMs, duplicate: 0, crossed: 0 }));
      }
      assert.deepEqual(markers, ['SSE-A-1', 'SSE-B-2', 'SSE-A-3']);
    } finally { await Promise.all(connections.map((item) => item.close())); }
  } finally { await adapter.close(); }
} finally {
  assert.equal((await runtime.stop()).orphans, 0);
}
