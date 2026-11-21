import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinCustomRemoteMcp, validateCustomRemoteMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';
import { WebStore } from '../../apps/adapter/src/runs/web-store.ts';

test('validates and persists local MCP definitions with credential names only', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oep-custom-mcp-'));
  const file = join(root, 'web.sqlite');
  const id = 'a'.repeat(32);
  const valid = { name: '合成 MCP', transport: 'stdio', enabled: true, command: [process.execPath, 'fixture.mjs'],
    cwd: root, environment: ['SYNTHETIC_TOKEN'], timeouts: { startup: 1000, catalog: 1000, execution: 1000 },
    dataScope: '合成資料', appliesToProjects: ['default'] };
  const store = new WebStore(file);
  try {
    for (const command of ['node fixture.mjs', ['relative.exe'], ['\\\\server\\share\\fixture.exe'], ['C:\\fixture&other.exe']]) {
      assert.throws(() => store.saveCustomStdioMcp(id, { ...valid, command }));
    }
    for (const environment of [['Path'], ['PATHEXT'], ['COMSPEC'], ['NODE_OPTIONS'], ['9INVALID'], ['TOKEN', 'token']]) {
      assert.throws(() => store.saveCustomStdioMcp(id, { ...valid, environment }));
    }
    assert.throws(() => store.saveCustomStdioMcp(id, { ...valid, cwd: join(root, 'missing') }));
    assert.throws(() => store.saveCustomStdioMcp(id, { ...valid, appliesToProjects: ['unknown'] }));
    assert.throws(() => store.saveCustomStdioMcp(id, { ...valid, timeouts: { ...valid.timeouts, execution: 120001 } }));
    const marker = 'synthetic-mcp-value-check';
    const saved = store.saveCustomStdioMcp(id, { ...valid, ignoredValue: marker });
    assert.deepEqual(saved.environment, [{ name: 'SYNTHETIC_TOKEN', reference: `OEP_MCP_${id.toUpperCase()}_SYNTHETIC_TOKEN` }]);
    assert.equal(JSON.stringify(saved).includes(marker), false);
    const reopened = new WebStore(file);
    try {
      assert.deepEqual(reopened.customMcpServers(), [saved]);
    } finally {
      reopened.close();
    }
    for (let index = 0; index < 19; index++) store.saveCustomStdioMcp(index.toString(16).padStart(32, '0'), valid);
    assert.throws(() => store.saveCustomStdioMcp('b'.repeat(32), valid));
    assert.equal(store.saveCustomStdioMcp(id, { ...valid, enabled: false }).createdAt, saved.createdAt);
    assert.equal(store.removeCustomMcp(id), true);
    assert.equal(store.removeCustomMcp(id), false);
    assert.equal(readFileSync(file).includes(marker), false);
    assert.equal(readFileSync(file + '-wal').includes(marker), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote MCP accepts HTTPS and secret references and requires confirmation for private addresses', async () => {
  const id = 'b'.repeat(32);
  const definition = { name: '合成遠端 MCP', transport: 'remote', enabled: true, url: 'https://127.0.0.1:8443/mcp',
    localService: false, headers: ['X-Synthetic-Token'], timeouts: { startup: 1000, catalog: 1000, execution: 1000 },
    appliesToProjects: ['default'], dataScope: '合成資料' };
  const validate = (input: Record<string, unknown>) => validateCustomRemoteMcp(id, input, ['default']);
  const withCredentials = new URL(definition.url);
  withCredentials.username = 'synthetic';
  withCredentials.password = 'fixture';
  for (const url of ['http://127.0.0.1', withCredentials.href, 'https://127.0.0.1/?token=value']) {
    assert.throws(() => validate({ ...definition, url }));
  }
  for (const headers of [['Host'], ['Invalid: Name'], ['X-Synthetic-Token', 'x_synthetic_token'], [{ name: 'Authorization', value: 'synthetic' }]]) {
    assert.throws(() => validate({ ...definition, headers }));
  }
  const server = validate(definition);
  assert.deepEqual(server.environment, [{ name: 'X-Synthetic-Token', reference: `OEP_MCP_${id.toUpperCase()}_X_SYNTHETIC_TOKEN` }]);
  await assert.rejects(pinCustomRemoteMcp(server, AbortSignal.timeout(1000)), /未確認/);
  assert.equal(await pinCustomRemoteMcp({ ...server, localService: true }, AbortSignal.timeout(1000)), '127.0.0.1');
});

