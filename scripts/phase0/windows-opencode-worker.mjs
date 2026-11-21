import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';

const { OEP_P0_EXE: executable, OEP_P0_PORT: port, OEP_P0_CONTROL: control, ...env } = process.env;
const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', port], {
  env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
});

function record(name, value) {
  writeFileSync(`${control}/${name}.tmp`, JSON.stringify(value));
  renameSync(`${control}/${name}.tmp`, `${control}/${name}.json`);
}

const poll = setInterval(() => {
  if (!existsSync(`${control}/stop`)) return;
  clearInterval(poll);
  child.stdin.end();
}, 50);
child.stdin.on('error', (error) => {
  // The child can close stdin while the requested shutdown is in flight.
  if (existsSync(`${control}/stop`) && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
  process.exitCode = 1;
});
child.once('spawn', () => record('child', { pid: child.pid }));
child.once('error', () => { clearInterval(poll); process.exitCode = 1; });
child.once('exit', (code) => {
  clearInterval(poll);
  const requested = existsSync(`${control}/stop`);
  record('exit', { code, requested });
  if (code !== 0 || !requested) process.exitCode = 1;
});
