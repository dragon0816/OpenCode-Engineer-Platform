import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const [control] = process.argv.slice(2);
const definition = join(control, 'definition.json');
const { command, cwd, trust } = JSON.parse(readFileSync(definition, 'utf8'));
const { port, ticket } = JSON.parse(readFileSync(join(control, 'bridge.json'), 'utf8'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(command[0])) hash.update(chunk);
if (hash.digest('hex') !== trust.sha256) process.exit(1);

const child = spawn(process.execPath, [join(import.meta.dirname, 'custom-mcp-stdio.mjs'), definition], {
  cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
});
const socket = connect(port, '127.0.0.1');
const stop = () => { socket.destroy(); child.stdin.destroy(); child.stdout.destroy(); };
child.once('error', stop);
child.once('exit', stop);
socket.once('error', stop);
process.stdin.resume();
process.stdin.once('end', stop);
socket.write(ticket + '\n');
await Promise.allSettled([pipeline(socket, child.stdin), pipeline(child.stdout, socket)]);
stop();
process.stdin.destroy();
