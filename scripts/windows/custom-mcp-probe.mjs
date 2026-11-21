import { spawn } from 'node:child_process';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const [control] = process.argv.slice(2);
const definition = join(control, 'definition.json');
const server = JSON.parse(readFileSync(definition, 'utf8'));
const failureCodes = new Set(['missing', 'exited', 'timeout', 'auth', 'tls', 'url']);

async function catalog() {
  if (server.environment.some(({ reference }) => !process.env[reference])) throw new Error('auth');
  if (server.transport === 'stdio' && !statSync(server.command[0], { throwIfNoEntry: false })?.isFile()) throw new Error('missing');
  const wrapper = fileURLToPath(new URL('./custom-mcp-stdio.mjs', import.meta.url));
  const child = spawn(process.execPath, [wrapper, definition], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = reader[Symbol.asyncIterator]();
  child.stdin.on('error', () => reader.close());
  child.on('error', () => reader.close());
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    reader.close();
    child.kill();
  }, 15_000);
  const write = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const receive = async (id) => {
    while (true) {
      const line = await replies.next();
      if (line.done) throw new Error(expired ? 'timeout' : 'exited');
      let reply;
      try { reply = JSON.parse(line.value); } catch { continue; }
      if (reply.id !== id) continue;
      if (reply.error) throw new Error(server.transport === 'remote' ? reply.error.message : 'exited');
      return reply.result;
    }
  };
  try {
    write({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'OEP connection test', version: '1' } } });
    const handshake = await receive(1);
    if (typeof handshake?.protocolVersion !== 'string') throw new Error('exited');
    write({ method: 'notifications/initialized' });
    write({ id: 2, method: 'tools/list', params: {} });
    const result = await receive(2);
    if (!Array.isArray(result?.tools)) throw new Error('exited');
    return result.tools.slice(0, 50).flatMap((tool) => typeof tool?.name === 'string' ? [{
      name: tool.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120),
      description: typeof tool.description === 'string' ? tool.description.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : '',
    }] : []);
  } finally {
    clearTimeout(timer);
    reader.close();
    child.stdin.end();
    child.stdout.destroy();
    child.unref();
  }
}

process.stdin.resume();
let result;
try { result = { tools: await catalog() }; }
catch (error) { result = { reason: failureCodes.has(error.message) ? error.message : 'exited' }; }
writeFileSync(join(control, 'result.tmp'), JSON.stringify(result), { flag: 'wx' });
renameSync(join(control, 'result.tmp'), join(control, 'result.json'));
