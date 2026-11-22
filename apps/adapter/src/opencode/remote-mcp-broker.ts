import { Ajv } from 'ajv';
import { sendRemoteMcp } from '../../../../scripts/windows/custom-mcp-remote.mjs';
import { assistantMcpPaused, customMcpName, customMcpTool, validateCustomRemoteMcp } from '../runs/custom-mcp.ts';
import type { CustomMcp, CustomRemoteMcp } from '../runs/custom-mcp.ts';
import { readCustomMcpCredentials } from '../runs/custom-mcp-credentials.ts';
import { projects } from '../runs/web-store.ts';
import type { ProjectID } from '../runs/web-store.ts';
import { containsTransport, objectRecord, stripTransport, transportField } from './tool-transport.ts';
import type { ToolValidator } from './tool-tickets.ts';

export type RemoteMcpTransport = typeof sendRemoteMcp;
type RemoteStatus = 'connected' | 'failed' | 'needs_auth';
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; validate: ToolValidator };
type Connected = {
  definition: CustomRemoteMcp; tools: Tool[];
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
};

const prohibited = /^(?:meta|role|agent(id)?|workspace(id|root)?|context(id)?|session(id)?|origin|run(id)?|model|root|credential(s)?|api(key|token)|access(token|key)|authorization|password|cookie|secret|token|proto|constructor|prototype)$/i;
const localPath = /(?:\b[a-z]:[\\/]|\\\\[^\\\s]|\bfile:\/)/i;

function safeValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (typeof value === 'string') return !localPath.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => safeValue(item, depth + 1));
  return Object.entries(objectRecord(value) ?? {}).every(([key, item]) =>
    !prohibited.test(key.replace(/[-_]/g, '')) && safeValue(key, depth + 1) && safeValue(item, depth + 1));
}

function safeSchema(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (Array.isArray(value)) return value.every((item) => safeSchema(item, depth + 1));
  return Object.entries(objectRecord(value) ?? {}).every(([key, item]) =>
    // Bound the work performed on model-supplied data. In particular, avoid server-supplied regex engines or recursion.
    !['pattern', 'patternProperties', '$ref', '$dynamicRef', '$recursiveRef', 'uniqueItems', '__proto__'].includes(key) &&
    safeSchema(item, depth + 1));
}

function redact(value: unknown, secrets: readonly string[], gatewayRedact: (value: string) => string): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[已隱藏]'), gatewayRedact(value));
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, gatewayRedact));
  const record = objectRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) =>
    [redact(key, secrets, gatewayRedact), redact(item, secrets, gatewayRedact)]));
}

export async function discoverRemoteMcp(definitions: readonly CustomMcp[], gatewayRedact: (value: string) => string,
  transport: RemoteMcpTransport = sendRemoteMcp) {
  const validator = new Ajv({ strict: true, ownProperties: true, addUsedSchema: false });
  const status = new Map<string, RemoteStatus>();
  const servers: Connected[] = [];
  const invocations = new Map<string, Connected>();
  const tools: Tool[] = [];

  await Promise.all(definitions.map(async (server) => {
    if (!server.enabled || !server.appliesToProjects.length || server.transport !== 'remote' || assistantMcpPaused(server)) return;
    try {
      const names = server.environment.map(({ name }) => name);
      const definition = validateCustomRemoteMcp(server.id, { ...server, headers: names }, projects.map(({ id }) => id));
      const missing = definition.environment.filter(({ reference }) => !process.env[reference]).map(({ reference }) => reference);
      const user = readCustomMcpCredentials(missing);
      const headers = Object.fromEntries(definition.environment.map(({ name, reference }) =>
        [name, process.env[reference] || user[reference]]));
      if (Object.values(headers).some((value) => !value)) {
        status.set(server.id, 'needs_auth');
        return;
      }
      const secrets = Object.values(headers);
      const scrub = (value: unknown) => stripTransport(redact(value, secrets, gatewayRedact));
      const session = {};
      const send = async (method: string, phase: keyof CustomRemoteMcp['timeouts'], id?: number, params?: unknown, stop?: AbortSignal) => {
        const timeout = AbortSignal.timeout(Math.min(definition.timeouts[phase], phase === 'execution' ? 120_000 : 8_000));
        const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
        signal.throwIfAborted();
        const reply = await transport(definition, { jsonrpc: '2.0', id, method, params }, session, headers, signal);
        if (id !== undefined && (!reply || reply.error !== undefined)) throw new Error('Remote tool unavailable');
        return reply?.result;
      };
      const protocol = objectRecord(await send('initialize', 'startup', 1, { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'OEP assistant broker', version: '1' } }))?.protocolVersion;
      if (!['2025-11-25', '2025-06-18', '2025-03-26'].some((version) => version === protocol)) throw new Error('Unsupported MCP protocol');
      await send('notifications/initialized', 'startup');
      const catalog = objectRecord(await send('tools/list', 'catalog', 2, {}));
      if (!Array.isArray(catalog?.tools)) throw new Error('Remote catalog unavailable');
      const verified: Tool[] = [];
      const namesSeen = new Set<string>();
      for (const entry of catalog.tools.slice(0, 50)) {
        const tool = objectRecord(entry);
        const name = tool?.name;
        if (typeof name !== 'string' || !customMcpTool.test(name)) continue;
        if (namesSeen.has(name)) throw new Error('Ambiguous remote tool catalog');
        namesSeen.add(name);
        const inputSchema = objectRecord(tool?.inputSchema);
        if (inputSchema?.type !== 'object' || containsTransport(inputSchema) || !safeSchema(inputSchema)) continue;
        const serialized = JSON.stringify(inputSchema);
        if (serialized.length > 8192 || JSON.stringify(scrub(inputSchema)) !== serialized) continue;
        try {
          const check = validator.compile(inputSchema);
          const validate = (args: Record<string, unknown>) => {
            const payload = JSON.stringify(args);
            return Buffer.byteLength(payload) <= 64 * 1024 && safeValue(args) &&
              JSON.stringify(scrub(args)) === payload && check(args);
          };
          const description = typeof tool?.description === 'string' ? String(scrub(tool.description)).slice(0, 300) : 'Run the approved remote tool.';
          verified.push({ name, description, inputSchema, validate });
        } catch { /* Invalid or unsupported schemas are excluded individually. */ }
      }
      if (!verified.length) throw new Error('No verified remote tools');
      let nextID = 3;
      const connected: Connected = { definition, tools: verified, async call(name, args, signal) {
        return scrub(await send('tools/call', 'execution', nextID++, { name, arguments: args }, signal));
      } };
      status.set(server.id, 'connected');
      servers.push(connected);
    } catch { status.set(server.id, 'failed'); }
  }));
  for (const server of servers.sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
    for (const tool of server.tools) {
      const name = `${customMcpName(server.definition.id)}_${tool.name}`;
      invocations.set(name, server);
      tools.push({ ...tool, name });
    }
  }

  return {
    status, tools,
    timeout: Math.max(80_000, ...servers.map(({ definition }) => definition.timeouts.execution)),
    names(grants: readonly CustomMcp[], project: ProjectID) {
      return servers.flatMap(({ definition, tools: discovered }) => {
        const grant = grants.find(({ id }) => id === definition.id);
        if (!grant?.enabled || grant.transport !== 'remote' || assistantMcpPaused(grant) || grant.url !== definition.url ||
          JSON.stringify(grant.environment) !== JSON.stringify(definition.environment) ||
          !grant.appliesToProjects.includes(project) || !definition.appliesToProjects.includes(project)) return [];
        return discovered.filter(({ name }) => !definition.deniedTools.includes(name) && !grant.deniedTools.includes(name))
          .map(({ name }) => `${customMcpName(definition.id)}_${name}`);
      });
    },
    async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      const server = invocations.get(name);
      return server?.call(name.slice(customMcpName(server.definition.id).length + 1), args, signal);
    },
  };
}

export type RemoteMcpBroker = Awaited<ReturnType<typeof discoverRemoteMcp>>;

export function withMcpTicket(inputSchema: Record<string, unknown>) {
  return { ...inputSchema,
    properties: { ...objectRecord(inputSchema.properties), [transportField]: { type: 'string' } },
    required: [...(Array.isArray(inputSchema.required) ? inputSchema.required : []), transportField],
  };
}
