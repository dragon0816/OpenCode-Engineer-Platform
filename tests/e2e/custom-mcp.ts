import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { customMcpName, validateCustomRemoteMcp, validateCustomStdioMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';
import { completion, toolCall } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const audit = join(root, 'launch');
const profile = join(root, 'profile');
mkdirSync(audit);
mkdirSync(profile);
const local = [true, false].map((enabled, index) => validateCustomStdioMcp(String(index).repeat(32), {
  name: 'Synthetic catalog', transport: 'stdio', enabled,
  command: [process.execPath, resolve('tests/fixtures/mcp/stdio.mjs'), '--extra-tool'], cwd: root,
  environment: [], timeouts: { startup: 5000, catalog: 5000, execution: 5000 },
  dataScope: 'Synthetic', deniedTools: ['synthetic_restricted'], appliesToProjects: ['default'],
}, ['default', 'secondary']));
const remote = [false, true].map((localService, index) => validateCustomRemoteMcp(String(index + 2).repeat(32), {
  name: 'Synthetic remote catalog', transport: 'remote', enabled: true, localService,
  url: localService ? 'https://127.0.0.1/mcp' : 'https://example.invalid/mcp', headers: [],
  timeouts: { startup: 5000, catalog: 5000, execution: 5000 },
  dataScope: 'Synthetic', deniedTools: ['synthetic_restricted'], appliesToProjects: ['default'],
}, ['default', 'secondary']));
const definitions = [...local, ...remote];
const store = new WebStore(join(root, 'web.sqlite'));
try { for (const definition of definitions) store.saveCustomMcp(definition); }
finally { store.close(); }
const requests: { text: string; tools: string[] }[] = [];
const used = new Set<string>();
let resultReturned = false;
const brokeredName = `${customMcpName(remote[0].id)}_synthetic_catalog`;
const runtime = await startRuntime(audit, {
  url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-mcp', isolatedJob: true,
  remoteMcpTransport: async (definition, message, _session, _headers, signal) => {
    signal.throwIfAborted();
    used.add(definition.id);
    assert.equal(definition.id, remote[0].id);
    switch (message.method) {
      case 'initialize': return { result: { protocolVersion: '2025-06-18' } };
      case 'notifications/initialized': return;
      case 'tools/list': return { result: { tools: [
        { name: 'synthetic_catalog', inputSchema: { type: 'object', properties: { value: { type: 'number' } },
          required: ['value'], additionalProperties: false } },
        { name: 'synthetic_restricted', inputSchema: { type: 'object' } },
        { name: '../unsafe', inputSchema: { type: 'object' } },
        { name: 'invalid_schema', inputSchema: { type: 'object', properties: { value: { type: 'unknown' } } } },
      ] } };
      case 'tools/call':
        assert.deepEqual(message.params, { name: 'synthetic_catalog', arguments: { value: 9 } });
        return { result: { content: [{ type: 'text', text: 'Synthetic broker reply' }] } };
      default: assert.fail('Unexpected remote MCP method');
    }
  },
  fetch: async (_url, init) => {
    const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
    requests.push({ text: JSON.stringify(messages), tools: tools?.map((tool) => tool.function?.name ?? '') ?? [] });
    const result = messages.find(({ role }) => role === 'tool');
    if (result) {
      assert.match(JSON.stringify(result), /Synthetic broker reply/);
      assert.doesNotMatch(JSON.stringify(messages), /_oep_transport_token|oep-ticket-/);
      resultReturned = true;
    } else if (tools?.some(({ function: fn }) => fn?.name === brokeredName)) {
      return completion(model, toolCall(0, 'call_remote', brokeredName, { value: 9 }), 'tool_calls');
    }
    return completion(model, [{ role: 'assistant', content: 'Synthetic reply' }], 'stop');
  },
}, profile, definitions);
try {
  const adapter = await startAdapter(root, runtime, () => undefined);
  try {
    const launch = new URL(adapter.pairURL());
    const origin = launch.origin;
    const ticket = new URLSearchParams(launch.hash.slice(1)).get('pair');
    const paired = await fetch(origin + '/api/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    const { csrf } = await paired.json();
    const post = (path: string, data: object) => fetch(origin + path, { method: 'POST',
      headers: { cookie, origin, 'x-oep-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    using grants = new DatabaseSync(join(root, 'web.sqlite'));
    for (const [project, policy, allowed] of [
      ['default', 'allowed', true], ['secondary', 'wrong-project', false],
      ['default', 'workspace-revoked', false], ['default', 'agent-revoked', false],
    ] as const) {
      if (policy === 'workspace-revoked') grants.prepare('DELETE FROM workspace_mcp_grants WHERE server_id=?').run(remote[0].id);
      if (policy === 'agent-revoked') {
        grants.prepare("INSERT INTO workspace_mcp_grants VALUES ('legacy-default',?)").run(remote[0].id);
        grants.prepare("UPDATE agent_capabilities SET enabled=0 WHERE agent_id='main' AND capability_id=?").run(remote[0].id);
      }
      const path = '/api/projects/' + project + '/sessions';
      const created = await post(path, { agent: 'inspector' });
      assert.equal(created.status, 201);
      const { id } = await created.json();
      const text = 'synthetic-policy-' + policy;
      assert.equal((await post(path + '/' + id + '/turns', {
        id: randomUUID(), text, attachments: [], workbook: false,
      })).status, 202);
      const signal = AbortSignal.timeout(30_000);
      while (!requests.some((request) => request.text.includes(text))) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const names = requests.find((request) => request.text.includes(text))!.tools;
      console.log(JSON.stringify({ project, policy, tools: names }));
      for (const paused of [...local, remote[1]]) assert.equal(names.some((name) => name.includes(paused.id)), false);
      assert.equal(names.includes(brokeredName), allowed);
      assert.equal(names.some((name) => name.endsWith('_synthetic_restricted')), false);
      assert.equal(names.some((name) => name.endsWith('_invalid_schema') || name.includes('unsafe')), false);
      const state = await fetch(origin + path + '/' + id + '/state', { headers: { cookie } });
      assert.equal(state.status, 200);
    }
    assert.deepEqual([...used], [remote[0].id]);
    assert.equal(resultReturned, true);
    const snapshot = await fetch(origin + '/api/settings/mcp/custom', { headers: { cookie } }).then((response) => response.json());
    for (const paused of [...local, remote[1]]) assert.equal(snapshot.servers.find(({ id }: { id: string }) => id === paused.id).status, 'paused');
    assert.equal(snapshot.servers.find(({ id }: { id: string }) => id === remote[0].id).status, 'connected');
  } finally { await adapter.close(); }
} finally {
  const cleanup = await runtime.stop();
  assert.equal(cleanup.orphans, 0);
}
