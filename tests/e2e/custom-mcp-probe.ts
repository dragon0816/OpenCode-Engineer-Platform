import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { dataDirectory } from '../../apps/launcher/src/paths.ts';
import { testCustomMcp } from '../../apps/launcher/src/custom-mcp-probe.ts';
import { validateCustomStdioMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';

const root = dataDirectory();
const input = { name: 'Synthetic MCP', enabled: true, transport: 'stdio', cwd: root, environment: [],
  timeouts: { startup: 1000, catalog: 1000, execution: 1000 }, dataScope: '', appliesToProjects: ['default'] };
const test = (command: string[], environment: string[] = []) => testCustomMcp(validateCustomStdioMcp('a'.repeat(32),
  { ...input, command, environment }, ['default']));
assert.deepEqual(await test([process.execPath, resolve('tests/fixtures/mcp/stdio.mjs')]), {
  ok: true, tools: [{ name: 'synthetic_catalog', description: 'Read the synthetic catalog' }],
});
assert.deepEqual(await test([join(root, 'missing.exe')]), { ok: false, reason: '找不到指定的執行檔。' });
assert.deepEqual(await test([process.execPath, '-e', 'process.exit(1)']),
  { ok: false, reason: '伺服器在完成連線前結束，或傳回無效的資料。' });
assert.deepEqual(await test([process.execPath, '-e', 'setInterval(() => {}, 1000)']),
  { ok: false, reason: '伺服器握手或工具清單讀取逾時。' });
assert.deepEqual(await test([process.execPath], ['SYNTHETIC_ABSENT']),
  { ok: false, reason: '需要憑證，請檢查憑證是否已設定且有效。' });
console.log('Isolated MCP probes passed with verified Job cleanup.');
