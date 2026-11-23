import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCustomMcpCredentials } from '../../apps/adapter/src/runs/custom-mcp-credentials.ts';

const {
  OEP_JOB_MCP_PROBE: probe, OEP_JOB_EXE: executable, OEP_JOB_PORT: port, OEP_JOB_CONTROL: control,
  OEP_JOB_NODE: _node, OEP_JOB_OWNER: _owner, OEP_JOB_TEST_SCOPE: _testScope, ...env
} = process.env;
const stop = join(control, 'stop');
const namesFile = join(control, 'mcp-credential-names.json');
const names = probe && existsSync(namesFile) ? JSON.parse(readFileSync(namesFile, 'utf8')) : [];
const command = probe
  ? [process.execPath, [join(import.meta.dirname, probe === 'bridge' ? 'custom-mcp-bridge.mjs' : 'custom-mcp-probe.mjs'), control]]
  : [executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', port]];
const child = spawn(...command, {
  env: probe ? { ...env, ...readCustomMcpCredentials(names) } : env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
});
function record(name, value) {
  const path = join(control, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, `${path}.json`);
}

const poll = setInterval(() => {
  if (!existsSync(stop)) return;
  clearInterval(poll);
  child.stdin.end();
}, 50);
child.stdin.on('error', (error) => {
  if (!existsSync(stop) || !['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) process.exitCode = 1;
});
child.once('spawn', () => record('child', { pid: child.pid }));
child.once('error', () => { clearInterval(poll); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  clearInterval(poll);
  const requested = existsSync(stop);
  record('exit', { code, signal, requested });
  if (code !== 0 || !requested) process.exitCode = 1;
});
