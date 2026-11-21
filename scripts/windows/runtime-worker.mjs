import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  OEP_JOB_EXE: executable, OEP_JOB_PORT: port, OEP_JOB_CONTROL: control,
  OEP_JOB_NODE: _node, OEP_JOB_OWNER: _owner, OEP_JOB_TEST_SCOPE: _testScope, ...env
} = process.env;
const stop = join(control, 'stop');
const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', port], {
  env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
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
