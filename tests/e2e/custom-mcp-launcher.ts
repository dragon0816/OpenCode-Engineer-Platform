import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dataDirectory } from './test-data.ts';
import { gatewayAliases } from '../../apps/adapter/src/opencode/gateway.ts';
import { jsonInput, listen, send, until, waitForExit } from '../../scripts/phase0/probe-http.ts';
import { completion } from './synthetic-completion.ts';
import type { WireRequest } from './synthetic-completion.ts';
import { webAPI } from './web-api.ts';

const root = dataDirectory();
const tools = new Map<string, string[]>();
const gateway = await listen(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    send(response, 200, { object: 'list', data: gatewayAliases.map((id) => ({ object: 'model', id })) });
    return;
  }
  const { model, messages, tools: catalog, stream } = await jsonInput<WireRequest & { stream?: boolean }>(request, 256 * 1024);
  if (!stream) {
    send(response, 200, { choices: [{ message: { role: 'assistant', content: 'OEP-READY' } }] });
    return;
  }
  const text = JSON.stringify(messages);
  for (const prompt of ['Before custom MCP restart', 'After custom MCP restart', 'After launcher relaunch']) {
    if (text.includes(prompt)) tools.set(prompt, catalog?.flatMap((tool) => tool.function?.name ?? []) ?? []);
  }
  const body = await completion(model, [{ role: 'assistant', content: 'Synthetic reply' }], 'stop').text();
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(body);
});

function launch() {
  const preload = pathToFileURL(resolve('tests/e2e/launch-bridge.ts')).href;
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', '--import', preload, 'apps/launcher/src/web.ts'], {
    env: {
      ...process.env, NODE_TEST_CONTEXT: 'synthetic-mcp-launcher', OEP_DATA_DIR: root,
      OEP_LITELLM_BASE_URL: gateway.url, OEP_LITELLM_API_KEY: randomUUID(), OEP_MODEL_ALIAS: 'gpt-5.4-mini',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const handoffs: string[] = [];
  child.on('message', (value: unknown) => { if (typeof value === 'string') handoffs.push(value); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return {
    async connect(index: number) {
      const url = await until(async () => {
        if (child.exitCode !== null) throw new Error('The launcher stopped before browser handoff');
        return handoffs[index];
      }, 90_000);
      return webAPI(url);
    },
    async stop(api?: Awaited<ReturnType<typeof webAPI>>) {
      try {
        if (api && child.connected) {
          assert.equal((await api.post('/api/stop', {})).status, 202);
          assert.equal(await waitForExit(exited, 20_000), 0);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await waitForExit(exited, 15_000);
      }
    },
  };
}

async function turn(api: Awaited<ReturnType<typeof webAPI>>, prompt: string, enabled: boolean) {
  const path = '/api/projects/default/sessions';
  const created = await api.post(path, { agent: 'inspector' });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await api.post(path + '/' + id + '/turns', {
    id: randomUUID(), text: prompt, attachments: [], workbook: false,
  })).status, 202);
  await until(async () => {
    const { runs } = await (await api.get(path + '/' + id + '/state')).json();
    return runs.at(-1)?.state === 'verified' || undefined;
  }, 30_000);
  assert.equal(tools.get(prompt)?.some((tool) => tool.endsWith('_synthetic_catalog')), enabled);
}

let instance: ReturnType<typeof launch> | undefined;
let api: Awaited<ReturnType<typeof webAPI>> | undefined;
try {
  instance = launch();
  api = await instance.connect(0);
  const created = await api.post('/api/settings/mcp/custom', {
    action: 'create', name: '合成啟動器目錄', transport: 'stdio', enabled: true,
    command: [process.execPath, resolve('tests/fixtures/mcp/stdio.mjs')], cwd: root, environment: [],
    timeouts: { startup: 15000, catalog: 15000, execution: 15000 }, appliesToProjects: ['default'], dataScope: '合成資料',
  });
  assert.equal(created.status, 200);
  const saved = await created.json();
  assert.equal(saved.restartRequired, true);
  await turn(api, 'Before custom MCP restart', false);
  assert.equal((await api.post('/api/settings/mcp/restart', {})).status, 202);
  api = await instance.connect(1);
  assert.equal((await (await api.get('/api/settings/mcp/custom')).json()).restartRequired, false);
  await turn(api, 'After custom MCP restart', true);
  await instance.stop(api);
  instance = undefined;
  api = undefined;
  instance = launch();
  api = await instance.connect(0);
  const reopened = await (await api.get('/api/settings/mcp/custom')).json();
  assert.equal(reopened.restartRequired, false);
  assert.equal(reopened.servers[0].id, saved.changedId);
  await turn(api, 'After launcher relaunch', true);
} finally {
  try { await instance?.stop(api); }
  finally { await gateway.close(); }
}
const web = join(root, 'web');
const launches = readdirSync(web).filter((name) => name.startsWith('launch-'));
assert.equal(launches.length, 3);
for (const launch of launches) {
  const folder = join(web, launch);
  const server = readdirSync(folder).find((name) => name.startsWith('server-'));
  assert.ok(server);
  const { orphans } = JSON.parse(readFileSync(join(folder, server, 'stopped.json'), 'utf8'));
  assert.equal(orphans, 0);
}
console.log('Windows launcher applied MCP on restart, persisted definitions across relaunch, and cleaned up all Jobs.');
