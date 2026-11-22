import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import type { Runtime } from '../../apps/launcher/src/runtime.ts';

test('paired agent management validates revisions and grants and keeps session owners separate', async () => {
  const parent = process.env.OEP_DATA_DIR ?? join(process.cwd(), '.phase0');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'agent-api-'));
  const remote = '1'.repeat(32);
  const paused = '2'.repeat(32);
  const runtime = {
    root, version: '2.3.2', alias: 'synthetic-main', aliases: ['synthetic-main', 'synthetic-specialist'],
    builtInAliases: ['synthetic-main', 'synthetic-specialist'],
    endpoint: { request: async () => new Response(null, { status: 503 }) }, redact: (value: string) => value,
    client: {
      session: { create: async (input: object) => ({ ...input, id: randomUUID() }) },
      message: { list: async () => ({ data: [] }) },
    },
  } as unknown as Runtime;
  const server = await startAdapter(root, runtime, () => {});
  const store = new WebStore(join(root, 'web.sqlite'));
  try {
    for (const id of [remote, paused]) store.saveCustomMcp({ id, enabled: true, name: 'Synthetic external tool', transport: 'remote',
      url: 'https://example.invalid/mcp', localService: id === paused, timeouts: { startup: 1000, catalog: 1000, execution: 1000 },
      appliesToProjects: ['default'], dataScope: '', environment: [], deniedTools: [] });
    const launch = new URL(server.pairURL());
    const { origin } = launch;
    const json = { origin, 'content-type': 'application/json' };
    const pair = await fetch(origin + '/api/pair', { method: 'POST', headers: json,
      body: JSON.stringify({ ticket: new URLSearchParams(launch.hash.slice(1)).get('pair') }) });
    const cookie = pair.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await pair.json();
    const headers = { ...json, cookie, 'x-oep-csrf': csrf };
    const read = (path: string, auth = headers) => fetch(origin + path, { headers: auth });
    const write = (path: string, data: object, auth = headers) => fetch(origin + path, {
      method: 'POST', headers: auth, body: JSON.stringify(data),
    });
    const expect = async (response: Response, status: number, code: string) => {
      assert.equal(response.status, status);
      assert.equal((await response.json()).errorDetail.code, code);
    };
    const main = '/api/agents/main';
    const mainSessions = main + '/workspaces/legacy-default/sessions';
    for (const path of ['/api/agents', main, mainSessions]) {
      await expect(await read(path, { ...headers, cookie: '' }), 401, 'launch-required');
      await expect(await read(path, { ...headers, 'x-oep-csrf': '' }), 403, 'pairing-expired');
      await expect(await write(path, {}, { ...headers, 'x-oep-csrf': '' }), 403, 'pairing-expired');
    }
    await expect(await read(main, { ...headers, origin: 'https://example.invalid' }), 403, 'unexpected-origin');
    const list = await (await read('/api/agents')).json();
    assert.deepEqual(list.agents.map(({ id }: { id: string }) => id), ['main', 'bi']);
    assert.equal(list.tools.find(({ id }: { id: string }) => id === paused).paused, true);
    for (const agent of list.agents) await expect(await write('/api/agents/' + agent.id, { action: 'archive', revision: agent.revision }),
      409, 'agent-builtin');
    const mainRevision = list.agents[0].revision;
    assert.equal((await write(main, { action: 'edit', revision: mainRevision, name: 'Main test profile' })).status, 200);
    await expect(await write(main, { action: 'edit', revision: mainRevision, name: 'Stale profile' }), 409, 'agent-revision-conflict');
    assert.equal((await (await read('/api/settings')).json()).name, 'Main test profile');
    const draft = { name: 'Synthetic specialist', revision: list.revision };
    await expect(await write('/api/agents', draft), 409, 'agent-revision-conflict');
    draft.revision = (await (await read('/api/agents')).json()).revision;
    await expect(await write('/api/agents', { ...draft, knowledgeReads: ['unpublished'] }), 400, 'agent-knowledge-invalid');
    await expect(await write('/api/agents', { ...draft, mcpGrants: [paused] }), 400, 'agent-mcp-invalid');
    await expect(await write('/api/agents', { ...draft, defaultModel: 'unselected' }), 400, 'unapproved-model');
    await expect(await write('/api/agents', { ...draft, channel: { accountId: 'telegram-main', bindingRevision: 1 } }),
      409, 'channel-binding-stale');
    assert.deepEqual(readdirSync(join(root, 'agents')), ['bi']);
    const response = await write('/api/agents', { ...draft, defaultModel: 'synthetic-specialist', replyLocale: 'en', mcpGrants: [remote] });
    assert.equal(response.status, 201);
    const { agent } = await response.json();
    const scope = `/api/agents/${agent.id}/workspaces/${agent.workspaces[0].id}/sessions`;
    assert.ok(existsSync(join(root, 'agents', agent.id, 'sessions')));
    assert.deepEqual(agent.mcpGrants, [remote]);
    assert.equal(agent.replyLocale, 'en');
    await expect(await read(`/api/agents/${agent.id}/workspaces/legacy-default/sessions`), 404, 'agent-workspace-not-found');
    const specialist = await (await write(scope, {})).json();
    assert.equal(specialist.alias, 'synthetic-specialist');
    const legacy = await (await write('/api/projects/default/sessions', { agent: 'workbook' })).json();
    assert.deepEqual((await (await read(scope)).json()).map(({ id }: { id: string }) => id), [specialist.id]);
    assert.deepEqual(await (await read(mainSessions)).json(), [legacy]);
    await expect(await read(`${scope}/${legacy.id}/state`), 404, 'session-route-not-found');
    await expect(await read(`/api/sessions/${specialist.id}/state`), 404, 'session-route-not-found');
    assert.equal((await read(`${scope}/${specialist.id}/state`)).status, 200);
    using fixture = new DatabaseSync(join(root, 'web.sqlite'));
    fixture.prepare(`UPDATE channel_accounts SET agent_id=?, account_fingerprint=?,state='enabled' WHERE id='telegram-main'`)
      .run(agent.id, '0'.repeat(64));
    const archive = { action: 'archive', revision: agent.revision };
    await expect(await write('/api/agents/' + agent.id, archive), 409, 'agent-channel-bound');
    fixture.exec("UPDATE channel_accounts SET state='disabled' WHERE id='telegram-main'");
    const run = randomUUID();
    const record = { id: run, state: 'accepted', createdAt: Date.now(), workspace: '', mode: 'synthetic', retries: 0, errors: [] };
    fixture.prepare('INSERT INTO runs VALUES (?,?,?)').run(run, record.state, JSON.stringify(record));
    fixture.prepare('INSERT INTO web_turns VALUES (?,?,?)').run(specialist.id, run, 'synthetic');
    await expect(await write('/api/agents/' + agent.id, archive), 409, 'agent-busy');
    fixture.prepare('DELETE FROM web_turns WHERE run_id=?').run(run);
    fixture.prepare('DELETE FROM runs WHERE id=?').run(run);
    const removed = await write('/api/agents/' + agent.id, archive);
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).agent.state, 'archived');
    await expect(await write(scope, {}), 409, 'agent-inactive');
    assert.equal((await read(`${scope}/${specialist.id}/state`)).status, 200);
    await expect(await write('/api/agents/' + agent.id, { action: 'edit', revision: agent.revision + 1, name: 'Archived' }),
      409, 'agent-inactive');
  } finally {
    store.close();
    await server.close();
  }
});
