import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { cliLogin } from '../../apps/adapter/src/runs/external-cli.ts';
import { ExternalExecutor } from '../../apps/adapter/src/runs/external-executor.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';
import { webAPI } from '../e2e/web-api.ts';
import { fakeHelperAuth } from '../fixtures/external-helpers/auth.ts';

test('assistant source choices persist and signed-out or isolated-off sources cannot fall through to Gateway', async () => {
  const root = mkdtempSync(join(process.env.OEP_DATA_DIR ?? tmpdir(), 'agent-model-sources-'));
  const fixture = fakeHelperAuth();
  let gatewayPrompts = 0;
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-gateway', aliases: ['synthetic-gateway'], builtInAliases: ['synthetic-gateway'],
    endpoint: { request: async () => new Response(null, { status: 503 }) }, redact: (value: string) => value,
    client: { session: { create: async (input: object) => ({ ...input, id: randomUUID() }), prompt: async () => { gatewayPrompts++; } },
      message: { list: async () => ({ data: [] }) } },
  } as unknown as Runtime;
  let server = await startAdapter(root, runtime, () => {}, false, undefined, undefined,
    { executor: new ExternalExecutor(root, fixture.isolation) });
  try {
    const api = await webAPI(server.pairURL());
    const json = async (response: Response, status = 200) => {
      assert.equal(response.status, status);
      return response.json();
    };
    const helpers = '/api/settings/external-helpers';
    const main = '/api/agents/main';
    const agents = '/api/agents';
    const list = await json(await api.get(agents));
    assert.deepEqual(list.agents.map(({ modelSource }: { modelSource: string }) => modelSource), ['gateway', 'gateway']);
    assert.deepEqual(list.externalModels.map(({ enabled }: { enabled: boolean }) => enabled), [false, false]);
    const mainStart = list.agents[0];
    const edit = { action: 'edit', revision: mainStart.revision };
    assert.equal((await json(await api.post(main, { ...edit, modelSource: 'claude_code' }), 409)).errorDetail.code, 'external-disabled');
    assert.equal((await json(await api.post(main, { ...edit, modelSource: 'unrecognized' }), 400)).errorDetail.code, 'agent-settings-invalid');
    const status = await json(await api.post(helpers + '/recheck', { provider: 'codex_cli' }));
    assert.equal(status.login, 'signedOut');
    const settings = { provider: 'codex_cli', confirmEachRun: true, termsConfirmed: false, revision: 1 };
    await json(await api.post(helpers, { ...settings, enabled: true, warningAccepted: true }));
    const statuses = await json(await api.get(helpers));
    assert.deepEqual([statuses[0].enabled, statuses[0].available], [true, false]);
    const selection = await json(await api.post(main, { ...edit, defaultModel: 'synthetic-gateway', modelSource: 'codex_cli' }));
    assert.equal(selection.agent.modelSource, 'codex_cli');
    const session = await json(await api.post('/api/sessions', { agent: 'inspector' }), 201);
    const turn = { id: randomUUID(), text: 'synthetic unclassified text', attachments: [], workbook: false };
    const path = `/api/sessions/${session.id}/turns`;
    assert.equal((await json(await api.post(path, turn), 409)).errorDetail.code, 'external-cli-login-unavailable');
    const auth = helpers + '/auth';
    assert.equal((await json(await api.post(auth, { provider: 'claude_code', action: 'cli' }), 409)).errorDetail.code, 'external-terms-required');
    assert.equal((await json(await api.post(auth, { provider: 'codex_cli', action: 'logout', key: 'synthetic-extra' }), 400)).errorDetail.code,
      'external-invalid-input');
    for (const provider of ['codex_cli', 'claude_code'] as const) {
      if (provider === 'claude_code') await json(await api.post(helpers, { ...settings, provider, enabled: false, termsConfirmed: true }));
      for (const action of ['cli', 'key'] as const) {
        const key = 'synthetic-' + randomUUID();
        const login = await json(await api.post(auth, { provider, action, ...(action === 'key' && { key }) }));
        assert.equal(login.login, 'signedIn');
        assert.equal(JSON.stringify(login).includes(key), false);
        assert.equal(fixture.sessions.get(provider), action);
        assert.equal((await json(await api.post(auth, { provider, action: 'logout' }))).login, 'signedOut');
      }
    }
    await json(await api.post(auth, { provider: 'codex_cli', action: 'cli' }));
    const confirmation = (await json(await api.post(path, turn), 409)).errorDetail;
    assert.equal(confirmation.code, 'external-confirm-turn');
    assert.match(confirmation.params.digest, /^[a-f0-9]{64}$/);
    const current = await json(await api.get(agents));
    const draft = await json(await api.post(agents, { revision: current.revision, name: 'Synthetic helper', modelSource: 'codex_cli' }), 201);
    const store = new WebStore(join(root, 'web.sqlite'));
    try {
      assert.equal(store.agentModelSource(draft.agent.id), 'codex_cli');
      assert.equal(store.agentModelSource('main'), 'codex_cli');
      assert.equal(store.agentModelSource('bi'), 'gateway');
      assert.equal(store.agents().find(({ id }) => id === 'main')?.defaultModel, 'synthetic-gateway');
      assert.equal(store.turn(session.id, turn.id), undefined);
    } finally { store.close(); }
    await server.close();
    server = await startAdapter(root, runtime, () => {});
    const restarted = await webAPI(server.pairURL());
    assert.equal((await json(await restarted.get(main))).agent.modelSource, 'codex_cli');
    assert.equal((await json(await restarted.post(path, turn), 409)).errorDetail.code, 'external-isolation-unavailable');
    const blocked = await json(await restarted.get(helpers));
    assert.deepEqual([blocked[0].enabled, blocked[0].available], [true, false]);
    assert.equal(gatewayPrompts, 0);
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
  assert.equal(cliLogin('claude_code', 0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: '2000-01-01T00:00:00Z' })),
    'reauthRequired');
});
