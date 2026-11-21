import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const { id, method } = message;
  const result = method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } }
    : method === 'tools/list'
      ? { tools: [{ name: 'synthetic_catalog', description: 'Read the synthetic catalog', inputSchema: { type: 'object' } }] }
      : undefined;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(result ? { result } : { error: { code: -32601, message: 'Unavailable' } }) }) + '\n');
}
