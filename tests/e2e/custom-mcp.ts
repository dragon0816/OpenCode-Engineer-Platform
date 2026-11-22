import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { dataDirectory } from './test-data.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { startAdapter } from '../../apps/adapter/src/main.ts';
import { validateCustomStdioMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';

const root = dataDirectory();
const audit = join(root, 'launch');
const profile = join(root, 'profile');
mkdirSync(audit);
mkdirSync(profile);
const definitions = [true, false].map((enabled, index) => validateCustomStdioMcp(String(index).repeat(32), {
  name: 'Synthetic catalog', transport: 'stdio', enabled,
  command: [process.execPath, resolve('tests/fixtures/mcp/stdio.mjs'), '--extra-tool'], cwd: root,
  environment: [], timeouts: { startup: 5000, catalog: 5000, execution: 5000 },
  dataScope: 'Synthetic', deniedTools: ['synthetic_restricted'], appliesToProjects: ['default'],
}, ['default', 'secondary']));
const requests: { text: string; tools: string[] }[] = [];
const runtime = await startRuntime(audit, {
  url: 'http://example.invalid/v1', key: randomUUID(), alias: 'synthetic-mcp', isolatedJob: true,
  fetch: async (_url, init) => {
    const { model, messages, tools } = JSON.parse(String(init?.body)) as WireRequest;
    requests.push({ text: JSON.stringify(messages), tools: tools?.map((tool) => tool.function?.name ?? '') ?? [] });
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
    for (const project of ['default', 'secondary']) {
      const path = '/api/projects/' + project + '/sessions';
      const created = await post(path, { agent: 'inspector' });
      assert.equal(created.status, 201);
      const { id } = await created.json();
      const text = 'synthetic-project-' + project;
      assert.equal((await post(path + '/' + id + '/turns', {
        id: randomUUID(), text, attachments: [], workbook: false,
      })).status, 202);
      const signal = AbortSignal.timeout(30_000);
      while (!requests.some((request) => request.text.includes(text))) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const names = requests.find((request) => request.text.includes(text))!.tools;
      console.log(JSON.stringify({ project, tools: names }));
      assert.equal(names.some((name) => name.includes(definitions[0].id)), project === 'default');
      assert.equal(names.some((name) => name.includes(definitions[1].id)), false);
      assert.equal(names.some((name) => name.endsWith('_synthetic_restricted')), false);
    }
  } finally { await adapter.close(); }
} finally {
  const cleanup = await runtime.stop();
  assert.equal(cleanup.orphans, 0);
}
