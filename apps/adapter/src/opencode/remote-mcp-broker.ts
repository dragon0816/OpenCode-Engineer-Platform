import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { sendRemoteMcp } from '../../../../scripts/windows/custom-mcp-remote.mjs';
import { assistantMcpPaused, customMcpName, customMcpTool, oauthBinding, oauthMcpTool, validateCustomRemoteMcp } from '../runs/custom-mcp.ts';
import type { CustomMcp, CustomRemoteMcp } from '../runs/custom-mcp.ts';
import { readCustomMcpCredentials } from '../runs/custom-mcp-credentials.ts';
import { projects } from '../runs/web-store.ts';
import type { ProjectID } from '../runs/web-store.ts';
import { containsTransport, objectRecord, stripTransport, transportField } from './tool-transport.ts';
import type { ToolValidator } from './tool-tickets.ts';
import type { McpOAuth } from './mcp-oauth.ts';
import { WebMessageError } from '../http/errors.ts';

export type RemoteMcpTransport = typeof sendRemoteMcp;
type RemoteStatus = 'connected' | 'failed' | 'needs_auth';
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; validate: ToolValidator };
type Connected = {
  definition: CustomRemoteMcp; tools: (Tool & { upstreamName: string })[];
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

type Send = (method: string, phase: keyof CustomRemoteMcp['timeouts'], id?: number, params?: unknown,
  stop?: AbortSignal, secrets?: Set<string>) => Promise<unknown>;

function remoteSender(definition: CustomRemoteMcp, headers: Record<string, string>, transport: RemoteMcpTransport, oauth?: McpOAuth): Send {
  const session = {};
  return async (method, phase, id, params, stop, secrets = new Set()) => {
    const timeout = AbortSignal.timeout(Math.min(definition.timeouts[phase], phase === 'execution' ? 120_000 : 8_000));
    const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
    signal.throwIfAborted();
    const message = { jsonrpc: '2.0' as const, id, method, params };
    if (definition.oauth && !oauth) throw new WebMessageError('mcp-oauth-login-required');
    const reply = definition.oauth ? await oauth!.send(definition, message, session, signal, secrets, transport)
      : await transport(definition, message, session, headers, signal);
    if (id !== undefined && (!reply || reply.error !== undefined)) throw new Error('Remote tool unavailable');
    return reply?.result;
  };
}

async function remoteCatalog(send: Send, secrets: Set<string>) {
  const protocol = objectRecord(await send('initialize', 'startup', 1, { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'OEP assistant broker', version: '1' } }, undefined, secrets))?.protocolVersion;
  if (!['2025-11-25', '2025-06-18', '2025-03-26'].some((version) => version === protocol)) throw new Error('Unsupported MCP protocol');
  await send('notifications/initialized', 'startup', undefined, undefined, undefined, secrets);
  const catalog = objectRecord(await send('tools/list', 'catalog', 2, {}, undefined, secrets));
  if (!Array.isArray(catalog?.tools)) throw new Error('Remote catalog unavailable');
  return catalog.tools.slice(0, 50);
}

export async function probeOAuthMcp(definition: CustomRemoteMcp, oauth: McpOAuth, gatewayRedact: (value: string) => string) {
  const secrets = new Set<string>();
  const catalog = await remoteCatalog(remoteSender(definition, {}, sendRemoteMcp, oauth), secrets);
  const hidden = [...secrets];
  return catalog.flatMap((tool) => {
    const entry = objectRecord(tool);
    if (typeof entry?.name !== 'string' || redact(entry.name, hidden, gatewayRedact) !== entry.name) return [];
    return [{ name: entry.name.slice(0, 200), description: typeof entry.description === 'string'
      ? String(redact(entry.description, hidden, gatewayRedact)).slice(0, 500) : '' }];
  });
}

export async function discoverRemoteMcp(definitions: readonly CustomMcp[], gatewayRedact: (value: string) => string,
  transport: RemoteMcpTransport = sendRemoteMcp, oauth?: McpOAuth) {
  const validator = new Ajv({ strict: true, ownProperties: true, addUsedSchema: false });
  const status = new Map<string, RemoteStatus>();
  const servers: Connected[] = [];
  const invocations = new Map<string, { server: Connected; upstreamName: string }>();
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
      const secrets = new Set(Object.values(headers));
      const send = remoteSender(definition, headers, transport, oauth);
      const catalog = await remoteCatalog(send, secrets);
      const scrub = (value: unknown, values = secrets) => stripTransport(redact(value, [...values], gatewayRedact));
      const verified: Connected['tools'] = [];
      const namesSeen = new Set<string>();
      const aliases = new Set<string>();
      for (const entry of catalog) {
        const tool = objectRecord(entry);
        const name = tool?.name;
        if (typeof name !== 'string' || !(definition.oauth ? oauthMcpTool : customMcpTool).test(name) || scrub(name) !== name) continue;
        if (namesSeen.has(name)) throw new Error('Ambiguous remote tool catalog');
        namesSeen.add(name);
        const inputSchema = objectRecord(tool?.inputSchema);
        if (inputSchema?.type !== 'object' || containsTransport(inputSchema) || !safeSchema(inputSchema)) continue;
        const serialized = JSON.stringify(inputSchema);
        if (serialized.length > 8192 || JSON.stringify(scrub(inputSchema)) !== serialized) continue;
        const alias = definition.oauth && (name.length > 20 || !customMcpTool.test(name))
          ? `x_${createHash('sha256').update(name).digest('hex').slice(0, 18)}` : name;
        if (aliases.has(alias)) throw new Error('Ambiguous remote tool alias');
        try {
          const check = validator.compile(inputSchema);
          const validate = (args: Record<string, unknown>) => {
            const payload = JSON.stringify(args);
            return Buffer.byteLength(payload) <= 64 * 1024 && safeValue(args) &&
              JSON.stringify(scrub(args)) === payload && check(args);
          };
          const description = typeof tool?.description === 'string' ? String(scrub(tool.description)).slice(0, 300) : 'Run the approved remote tool.';
          aliases.add(alias);
          verified.push({ name: `${customMcpName(definition.id)}_${alias}`, upstreamName: name,
            description: alias === name ? description : `${name}. ${description}`, inputSchema, validate });
        } catch { /* Invalid or unsupported schemas are excluded individually. */ }
      }
      if (!verified.length) throw new Error('No verified remote tools');
      let nextID = 3;
      const connected: Connected = { definition, tools: verified, async call(name, args, signal) {
        const values = new Set(secrets);
        try { return scrub(await send('tools/call', 'execution', nextID++, { name, arguments: args }, signal, values), values); }
        catch (error) {
          if (!definition.oauth || !(error instanceof WebMessageError) || signal.aborted) throw error;
          const message = error.detail.code === 'mcp-oauth-scope' ? 'This remote tool needs additional permissions. Update the OAuth scopes in External tools and sign in again.'
            : error.detail.code === 'mcp-oauth-token' ? 'The remote service could not refresh its OAuth session. Try again later.'
              : 'Sign in to this remote service in OEP External tools, then try again.';
          return { isError: true, message };
        }
      } };
      status.set(server.id, 'connected');
      servers.push(connected);
    } catch (error) {
      status.set(server.id, server.oauth && error instanceof WebMessageError && error.detail.code === 'mcp-oauth-login-required'
        ? 'needs_auth' : 'failed');
    }
  }));
  for (const server of servers.sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
    for (const { upstreamName, ...tool } of server.tools) {
      invocations.set(tool.name, { server, upstreamName });
      tools.push(tool);
    }
  }

  return {
    status, tools,
    timeout: Math.max(80_000, ...servers.map(({ definition }) => definition.timeouts.execution)),
    names(grants: readonly CustomMcp[], project: ProjectID) {
      return servers.flatMap(({ definition, tools: discovered }) => {
        const grant = grants.find(({ id }) => id === definition.id);
        if (!grant?.enabled || grant.transport !== 'remote' || assistantMcpPaused(grant) || grant.url !== definition.url ||
          oauthBinding(grant) !== oauthBinding(definition) ||
          JSON.stringify(grant.environment) !== JSON.stringify(definition.environment) ||
          !grant.appliesToProjects.includes(project) || !definition.appliesToProjects.includes(project)) return [];
        return discovered.filter(({ upstreamName }) => !definition.deniedTools.includes(upstreamName) && !grant.deniedTools.includes(upstreamName))
          .map(({ name }) => name);
      });
    },
    async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      const invocation = invocations.get(name);
      return invocation?.server.call(invocation.upstreamName, args, signal);
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
