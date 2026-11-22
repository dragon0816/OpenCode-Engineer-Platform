import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChatService } from '../../apps/adapter/src/http/chat.ts';
import { discoverGatewayModels, gatewayAliases, maxDiscoveredModels, maxSelectedModels } from '../../apps/adapter/src/opencode/gateway.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { waitForExit } from '../../scripts/phase0/probe-http.ts';

const list = (ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ object: 'model', id, owned_by: 'ignored' })) });

test('discovery normalizes the endpoint, keeps only safe verbatim IDs, and caps the list', async () => {
  const url = 'https://synthetic-discovery.invalid/provider/v1/';
  const key = randomUUID();
  const expected = ['synthetic-model-a', 'team/synthetic-model-b:latest', 'Synthetic/Model@2',
    ...Array.from({ length: maxDiscoveredModels }, (_, i) => `synthetic-extra-${i}`)].slice(0, maxDiscoveredModels);
  const payload = list([url, key, `prefix-${key}`, 'synthetic-discovery.invalid', expected[0], ...expected, 'synthetic-over-cap']);
  let observed: { url: string; method?: string; redirect?: RequestRedirect; authorization: string | null; signal: boolean } | undefined;
  const before = Date.now();
  const result = await discoverGatewayModels({ url, key, fetch: async (input, init) => {
    observed = { url: String(input), method: init?.method, redirect: init?.redirect,
      authorization: new Headers(init?.headers).get('authorization'), signal: init?.signal instanceof AbortSignal };
    return Response.json(payload);
  } });
  assert.deepEqual(observed, { url: 'https://synthetic-discovery.invalid/provider/v1/models', method: 'GET', redirect: 'manual',
    authorization: `Bearer ${key}`, signal: true });
  assert.deepEqual(result?.ids, expected);
  assert.ok(result && result.discoveredAt >= before && result.discoveredAt <= Date.now());
  assert.deepEqual(Object.keys(result).sort(), ['discoveredAt', 'ids']);
});

test('failed discovery omits credentials, status details and response bodies', async (t) => {
  const key = randomUUID();
  const url = 'https://synthetic-discovery.invalid';
  const logs = ['log', 'warn', 'error'].map((name) => t.mock.method(console, name as 'log', () => undefined));
  for (const response of [Response.json(list([])), Response.json({ data: [{ id: 'synthetic-model-a' }] }),
    Response.json({ object: 'list', data: [{ id: 'synthetic-model-a' }, null] }),
    Response.json({ object: 'list', data: [{ id: 42 }] }), new Response('[' + url + key),
    new Response(url + key, { status: 401 }), new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    Response.json(list(['https://unexpected.invalid/', 'x'.repeat(161), 'has whitespace']))]) {
    assert.equal(await discoverGatewayModels({ url, key, fetch: async () => response }), undefined);
  }
  let requestedInvalidURL = false;
  assert.equal(await discoverGatewayModels({ url: `${url}?credential=${key}`, key, fetch: async () => {
    requestedInvalidURL = true;
    return Response.json(list(['synthetic-model-a']));
  } }), undefined);
  assert.equal(requestedInvalidURL, false);
  assert.equal(await discoverGatewayModels({ url, key, fetch: async () => { throw new Error(url + key); } }), undefined);
  assert.deepEqual(logs.map(({ mock }) => mock.callCount()), [0, 0, 0]);
});

test('discovery refuses an actual redirect and aborts a slow response', async () => {
  let destinationRequests = 0;
  const slowBody = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    if (request.url === '/redirect/v1/models') response.writeHead(302, { location: '/destination' }).end();
    else if (request.url === '/slow/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"object":"list","data":[');
      slowBody.resolve();
    } else { destinationRequests++; response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const key = randomUUID();
    assert.equal(await discoverGatewayModels({ url: url + '/redirect', key }), undefined);
    assert.equal(destinationRequests, 0);
    const controller = new AbortController();
    const pending = discoverGatewayModels({ url: url + '/slow', key }, controller.signal);
    await slowBody.promise;
    const timeout = AbortSignal.timeout(20);
    timeout.addEventListener('abort', () => controller.abort(timeout.reason), { once: true });
    assert.equal(await pending, undefined);
    assert.equal(controller.signal.reason.name, 'TimeoutError');
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

test('model storage preserves legacy defaults and the last good catalog, and validates saved choices', async () => {
  const root = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'oep-model-store-'));
  const path = join(root, 'web.sqlite');
  let store = new WebStore(path);
  try {
    const [a, b] = ['synthetic-model-a', 'synthetic-model-b'];
    assert.equal(store.modelCatalog(), undefined);
    assert.deepEqual(store.modelChoices(gatewayAliases), gatewayAliases);
    assert.deepEqual(store.modelSelection(gatewayAliases), { ids: gatewayAliases, defaultAlias: gatewayAliases[0] });
    store.saveDefaultAlias(gatewayAliases[1]);
    assert.deepEqual(store.modelSelection(gatewayAliases), { ids: gatewayAliases, defaultAlias: gatewayAliases[1] });
    const catalog = { ids: [a, b, ...Array.from({ length: maxSelectedModels }, (_, i) => `synthetic-extra-${i}`)], discoveredAt: 100 };
    store.saveModelCatalog(catalog, gatewayAliases);
    assert.deepEqual(store.modelSelection(gatewayAliases).ids, gatewayAliases);
    for (const [selected, alias] of [[[], a], [[a, a], a], [[a, b], 'unknown'], [[a, 'unknown'], a], [catalog.ids, a]]) {
      assert.equal(store.saveModelSelection(selected, alias, gatewayAliases), false);
    }
    assert.equal(store.saveModelSelection([a, b], b, gatewayAliases), true);
    const failed = await discoverGatewayModels({ url: 'https://example.invalid', key: randomUUID(), fetch: async () => new Response(null, { status: 503 }) });
    if (failed) store.saveModelCatalog(failed, gatewayAliases);
    store.close();
    store = new WebStore(path);
    assert.deepEqual(store.modelCatalog(), catalog);
    assert.deepEqual(store.modelSelection(gatewayAliases), { ids: [a, b], defaultAlias: b });
    store.saveModelCatalog({ ids: [a], discoveredAt: 200 }, gatewayAliases);
    assert.deepEqual(store.modelSelection(gatewayAliases), { ids: [a], defaultAlias: a });
    store.saveModelCatalog({ ids: [b], discoveredAt: 300 }, gatewayAliases);
    assert.deepEqual(store.modelSelection(gatewayAliases), { ids: [gatewayAliases[0]], defaultAlias: gatewayAliases[0] });
    assert.deepEqual(store.modelChoices(gatewayAliases), [b, ...gatewayAliases]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a session with a removed model switches once before admitting its next turn', async () => {
  const root = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'oep-model-session-'));
  for (const folder of ['sessions', 'model-work']) mkdirSync(join(root, folder));
  const store = new WebStore(join(root, 'web.sqlite'));
  const previous = 'synthetic-model-a';
  const fallback = 'synthetic-model-b';
  const calls: string[] = [];
  let alias = previous;
  let failSwitch = true;
  let message: { id: string; type: 'user'; text: string } | undefined;
  const runtime = {
    alias: previous, aliases: [previous], setTurnBoundary: () => undefined,
    gatewayCursor: () => 0, gatewaySince: () => [{ status: 200, output: 'text' }], redact: (text: string) => text,
    client: {
      session: {
        create: async (input: object) => ({ ...input, id: 'synthetic-session' }),
        switchModel: async (input: { sessionID: string; model: { providerID: string; id: string } }) => {
          assert.equal(input.sessionID, 'synthetic-session');
          assert.deepEqual(input.model, { providerID: 'oep-relay', id: fallback });
          if (failSwitch) throw new Error('Synthetic switch failure');
          calls.push('switch');
          alias = input.model.id;
        },
        prompt: async (input: { id: string; text: string; sessionID: string }) => {
          assert.equal(alias, fallback);
          calls.push('prompt');
          message = { id: input.id, text: input.text, type: 'user' };
          return { id: input.id, sessionID: input.sessionID };
        },
        get: async () => ({ outcome: 'succeeded' }), active: async () => ({}), inbox: { list: async () => [] },
      },
      permission: { list: async () => [] },
      message: { list: async ({ type }: { type?: string }) => ({ data: !message ? [] : type === 'user' ? [message] :
        [{ id: 'synthetic-reply', type: 'assistant', content: [{ type: 'text', text: 'Synthetic reply' }] }, message] }) },
    },
  };
  const verified = Promise.withResolvers<void>();
  const chat = new ChatService(store, runtime as unknown as Runtime, root, join(root, 'audit.jsonl'), (id) => {
    if (store.turns(id).at(-1)?.state === 'verified') verified.resolve();
  });
  try {
    const session = await chat.create('inspector');
    runtime.aliases = [fallback];
    runtime.alias = fallback;
    await assert.rejects(chat.switchModel(session, previous), { status: 400 });
    const input = { id: randomUUID(), text: 'Synthetic question', attachments: [], workbook: false };
    await assert.rejects(chat.submit(session, input), /Synthetic switch failure/);
    assert.equal(store.sessions()[0].alias, previous);
    assert.deepEqual(store.turns(session.id), []);
    failSwitch = false;
    const run = await chat.submit(session, input);
    assert.ok('modelFallback' in run);
    assert.equal(run.modelFallback, fallback);
    assert.equal(store.sessions()[0].alias, fallback);
    assert.equal(store.get(input.id).alias, fallback);
    assert.equal(await waitForExit(verified.promise.then(() => true), 5_000), true);
    await chat.submit(session, input);
    assert.deepEqual(calls, ['switch', 'prompt']);
  } finally { await chat.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
