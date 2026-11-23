import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';

test('paired annotation deletion works with unavailable history and preserves ratings and session scope', async () => {
  const parent = process.env.OEP_DATA_DIR ?? join(process.cwd(), '.phase0');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'annotation-api-'));
  const upstream = randomUUID();
  const messageID = 'synthetic-message';
  let historyAvailable = true;
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-main', aliases: ['synthetic-main'], builtInAliases: ['synthetic-main'],
    endpoint: { request: async () => new Response(null, { status: 503 }) }, redact: (value: string) => value,
    client: {
      session: { create: async (profile: object) => ({ ...profile, id: upstream }) },
      message: { list: async () => {
        if (!historyAvailable) throw new Error('Synthetic history unavailable');
        return { data: [{ id: messageID, type: 'user', text: 'Synthetic message' }] };
      } },
    },
  } as unknown as Runtime;
  const server = await startAdapter(root, runtime, () => {}, true, undefined, {
    readCredentials: () => ({}),
    createApi() { throw new Error('Unexpected Telegram account in annotation test'); },
  });
  try {
    const launch = new URL(server.pairURL());
    const { origin } = launch;
    const json = { origin, 'content-type': 'application/json' };
    const pair = await fetch(origin + '/api/pair', { method: 'POST', headers: json,
      body: JSON.stringify({ ticket: new URLSearchParams(launch.hash.slice(1)).get('pair') }) });
    assert.equal(pair.status, 200);
    const { csrf } = await pair.json();
    const headers = { ...json, cookie: pair.headers.get('set-cookie')!.split(';')[0], 'x-oep-csrf': csrf };
    const write = (path: string, data: object) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(data) });
    const collection = '/api/projects/default/sessions';
    const session = await write(collection, { agent: 'inspector' });
    assert.equal(session.status, 201);
    const path = `${collection}/${(await session.json()).id}`;
    const annotation = (data: object, id = messageID) => write(path + '/annotation', { messageID: id, ...data });
    assert.equal((await annotation({ field: 'note', value: 'Synthetic note' })).status, 200);
    assert.equal((await annotation({ field: 'rating', value: 'up', reason: 'Synthetic reason' })).status, 200);
    assert.equal((await annotation({ field: 'note' })).status, 400);
    assert.equal((await annotation({ field: 'note', value: '' })).status, 400);
    historyAvailable = false;
    assert.equal((await annotation({ field: 'note', value: null }, 'unknown-message')).status, 404);
    const deletion = await annotation({ field: 'note', value: null });
    assert.equal(deletion.status, 200);
    const remaining = [{ messageID, note: null, rating: 'up', reason: 'Synthetic reason' }];
    assert.deepEqual((await deletion.json()).annotations, remaining);
    const state = async () => (await fetch(origin + path + '/state', { headers })).json();
    assert.deepEqual((await state()).annotations, remaining);
    historyAvailable = true;
    assert.equal((await annotation({ field: 'note', value: 'Second synthetic note' })).status, 200);
    assert.equal((await annotation({ field: 'rating', value: null })).status, 200);
    const last = await annotation({ field: 'note', value: null });
    assert.equal(last.status, 200);
    assert.deepEqual((await last.json()).annotations, []);
    assert.deepEqual((await state()).annotations, []);
  } finally { await server.close(); }
});
