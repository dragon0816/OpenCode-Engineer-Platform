import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sendRemoteMcp } from './custom-mcp-remote.mjs';

const [definition] = process.argv.slice(2);
const server = JSON.parse(readFileSync(definition, 'utf8'));
const { command, environment } = server;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(?:SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATH|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(name)));
const headers = {};
const values = [];
for (const { name, reference } of environment) {
  const value = process.env[reference];
  if (!value) process.exit(1);
  if (server.transport === 'remote') headers[name] = value;
  else env[name] = value;
  values.push(value);
}
const sensitive = values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
async function write(line) {
  let normalized;
  try { normalized = JSON.stringify(JSON.parse(line)); } catch { return; }
  for (const value of sensitive) normalized = normalized.replaceAll(value, '[已隱藏]');
  if (sensitive.some((value) => normalized.includes(value))) return;
  try { JSON.parse(normalized); } catch { return; }
  if (!process.stdout.write(normalized + '\n')) await new Promise((resolve) => process.stdout.once('drain', resolve));
}

if (server.transport === 'remote') {
  const session = {};
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line);
    const phase = message.method === 'initialize' ? 'startup' :
      message.method?.endsWith('/list') ? 'catalog' : 'execution';
    try {
      const reply = await sendRemoteMcp(server, message, session, headers, AbortSignal.timeout(server.timeouts[phase]));
      if (reply) await write(JSON.stringify(reply));
    } catch (error) {
      if (message.id !== undefined) {
        await write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } }));
      }
    }
  }
} else {
  const child = spawn(command[0], command.slice(1), { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.once('error', () => process.exit(1));
  child.once('exit', (code) => { process.exitCode = code === 0 ? 0 : 1; process.stdin.destroy(); });
  child.stdin.on('error', () => child.kill());
  process.stdin.pipe(child.stdin);
  let pending = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > 1024 * 1024) { child.kill(); break; }
      await write(pending.subarray(0, newline).toString('utf8'));
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > 1024 * 1024) { child.kill(); break; }
  }
}
