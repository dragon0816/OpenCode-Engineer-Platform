import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBrokerMcp } from '../../apps/adapter/src/opencode/broker-mcp.ts';
import { discoverRemoteMcp } from '../../apps/adapter/src/opencode/remote-mcp-broker.ts';
import { ToolTickets } from '../../apps/adapter/src/opencode/tool-tickets.ts';
import { ModelSeat } from '../../apps/adapter/src/opencode/model-seat.ts';
import { allowedToolDefinitions } from '../../apps/adapter/src/opencode/scoped-completion.ts';
import { brokerMcpName, sessionPermissions, statusTool } from '../../apps/adapter/src/opencode/permissions.ts';
import { TelegramInbox } from '../../apps/adapter/src/telegram/inbox.ts';
import { openWorkspaceFile } from '../../apps/adapter/src/runs/workspace.ts';
import { createWorkspaceOutput, writeWorkspaceFile } from '../../apps/adapter/src/runs/workspace-write.ts';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { startRuntime } from '../../apps/launcher/src/runtime.ts';
import { requireTestDataDir } from '../../tests/test-data-guard.ts';

requireTestDataDir();
const root = dataDirectory();
const profile = join(root, 'profile');
mkdirSync(profile);
const samples = process.argv.includes('--smoke') ? 4 : 40;
const alias = 'synthetic-isolation-benchmark';
const ms = (started: number) => Number((performance.now() - started).toFixed(2));
const launch = () => startRuntime(mkdtempSync(join(root, 'launch-')), {
  url: 'http://example.invalid/v1', key: randomUUID(), alias, isolatedJob: true,
  fetch: async () => Response.json({ object: 'list', data: [{ id: alias }] }),
}, profile);

function memory(runtime: Awaited<ReturnType<typeof launch>>) {
  const control = readdirSync(runtime.root).find((name) => name.startsWith('server-'));
  assert.ok(control);
  const { pid } = JSON.parse(readFileSync(join(runtime.root, control, 'job.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return { harnessRssBytes: process.memoryUsage.rss(), openCodeRssBytes: Number(output.trim()), jobMembers: runtime.jobMembers };
}

async function stop(runtime: Awaited<ReturnType<typeof launch>>) {
  const result = await runtime.stop();
  assert.deepEqual([result.supervisorExit, result.childExit, result.orphans], [0, 0, 0]);
}

const cold = performance.now();
let runtime = await launch();
const coldMs = ms(cold);
let idleRestartMs: number;
let resident: ReturnType<typeof memory>;
const enumeration = [];
try {
  const restart = performance.now();
  await stop(runtime);
  runtime = await launch();
  idleRestartMs = ms(restart);
  resident = memory(runtime);
} finally { await stop(runtime); }

const tickets = new ToolTickets();
const broker = await startBrokerMcp(tickets, await discoverRemoteMcp([], (value) => value));
try {
  const mcpStart = performance.now();
  const response = await fetch(broker.config.url, {
    method: 'POST', headers: { ...broker.config.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const { result } = await response.json() as { result: { tools: { name: string; inputSchema: object }[] } };
  assert.equal(response.status, 200);
  const mcpListMs = ms(mcpStart);
  const definitions = result.tools.map(({ name, inputSchema }) => ({
    type: 'function', function: { name: `${brokerMcpName}_${name}`, parameters: inputSchema },
  }));
  for (const agents of [1, 2, 5, 10]) {
    const started = performance.now();
    for (let iteration = 0; iteration < samples; iteration++) {
      for (let agent = 0; agent < agents; agent++) {
        const permissions = sessionPermissions({ origin: 'web', agentID: agent ? `synthetic-${agent}` : 'main', status: true, files: true });
        const advertised = allowedToolDefinitions(definitions, { nonce: '', model: alias, permissions, live: () => true,
          brokered: tickets.brokered, issue: () => '' });
        assert.equal(advertised.names.size, 3);
        assert.ok(advertised.names.has(statusTool));
      }
    }
    enumeration.push({ agents, samples, builderAndToolEnumerationMs: ms(started), mcpListMs });
  }
} finally { tickets.close(); await broker.close(); }

const seat = new ModelSeat();
const arrival = performance.now();
const lanes = ['web', 'telegram-main', 'bi'] as const;
const arrivals = await Promise.all(lanes.map((lane) => seat.run(async () => {
  const waitMs = ms(arrival);
  await delay(5);
  return { lane, waitMs, firstReplyMs: ms(arrival) };
})));
const folder = createWorkspaceOutput(root, 'output');
const files = [1024, 256 * 1024].map((bytes) => {
  const sample = Buffer.alloc(bytes, 42);
  const name = `file-${bytes}.bin`;
  const startWrite = performance.now();
  const identity = writeWorkspaceFile(folder, name, sample, bytes);
  const writeMs = ms(startWrite);
  const startRead = performance.now();
  assert.deepEqual(openWorkspaceFile(folder.root, name, bytes, identity).data, sample);
  return { bytes, writeMs, verifyReadMs: ms(startRead) };
});

const inboxFile = join(root, 'telegram.sqlite');
const inbox = new TelegramInbox(inboxFile);
let claimMs: number;
try {
  inbox.admit('main', '1', [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'Synthetic message' } }]);
  const claim = performance.now();
  const next = inbox.next('main', 'work', Date.now());
  assert.ok(next);
  inbox.attempt(next, Date.now(), Date.now() + 10);
  claimMs = ms(claim);
  inbox.notify('main', 'synthetic-delivery', 0, 'Synthetic reply');
  inbox.db.exec("UPDATE outbox SET state='sending'");
} finally { inbox.db.close(); }
const restart = performance.now();
const recovered = new TelegramInbox(inboxFile);
let reconcileMs: number;
try {
  assert.equal(recovered.db.prepare('SELECT state FROM outbox').get()?.state, 'indeterminate');
  reconcileMs = ms(restart);
} finally { recovered.db.close(); }
console.log(JSON.stringify({ mode: 'isolated-synthetic', coldMs, idleRestartMs, resident, enumeration,
  modelSeat: { policy: 'fifo', arrivals }, files, sqlite: { claimMs, reconcileMs } }));
