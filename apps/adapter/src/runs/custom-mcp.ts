import { WebMessageError } from '../http/errors.ts';
import { pinIpv4 } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { ProjectID } from './web-store.ts';

const localPath = /^[a-z]:[\\/]/i;
const unsafePath = /[\u0000-\u001f<>"|?*&^%!]/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const blockedEnvironment = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PSMODULEPATH|PYTHON.*|NODE_.*|BUN_.*|DENO_.*|LD_.*|DYLD_.*|OPENCODE_.*|OEP_.*)$/i;

export const customMcpTool = /^[a-z0-9_]{1,120}$/;
export const customMcpName = (id: string) => `oep_custom_${id}`;

export type CustomStdioMcp = ReturnType<typeof validateCustomStdioMcp>;
export type CustomRemoteMcp = ReturnType<typeof validateCustomRemoteMcp>;
export type CustomMcp = CustomStdioMcp | CustomRemoteMcp;

function validateCommon(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new WebMessageError('mcp-invalid-server-id');
  const { name, enabled, timeouts, dataScope, appliesToProjects, deniedTools = [] } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    throw new WebMessageError('mcp-invalid-name');
  }
  if (typeof enabled !== 'boolean') throw new WebMessageError('mcp-invalid-enabled');
  if (!timeouts || typeof timeouts !== 'object') throw new WebMessageError('mcp-timeouts-required');
  const milliseconds = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 120_000) {
      throw new WebMessageError('mcp-invalid-timeouts');
    }
    return value;
  };
  const timing = timeouts as Record<string, unknown>;
  if (typeof dataScope !== 'string' || dataScope.length > 2000) throw new WebMessageError('mcp-data-scope-limit');
  if (!Array.isArray(appliesToProjects) || !appliesToProjects.every((project): project is ProjectID =>
    projects.includes(project)) || new Set(appliesToProjects).size !== appliesToProjects.length) {
    throw new WebMessageError('mcp-invalid-project');
  }
  if (!Array.isArray(deniedTools) || deniedTools.length > 50 ||
      !deniedTools.every((tool): tool is string => typeof tool === 'string' && customMcpTool.test(tool)) ||
      new Set(deniedTools).size !== deniedTools.length) {
    throw new WebMessageError('mcp-invalid-tool');
  }
  return { id, name: name.trim(), enabled, timeouts: {
    startup: milliseconds(timing.startup), catalog: milliseconds(timing.catalog),
    execution: milliseconds(timing.execution),
  }, dataScope, appliesToProjects, deniedTools };
}

export function validateCustomStdioMcp(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  const common = validateCommon(id, input, projects);
  const { transport, command, cwd, environment } = input;
  if (transport !== 'stdio') throw new WebMessageError('mcp-invalid-transport');
  if (!Array.isArray(command) || command.length < 1 || command.length > 51 ||
      !command.every((argument): argument is string => typeof argument === 'string' && argument.length <= 2048 && !argument.includes('\0'))) {
    throw new WebMessageError('mcp-invalid-arguments');
  }
  const [executable, ...args] = command;
  if (!localPath.test(executable) || unsafePath.test(executable.slice(2)) || executable.slice(2).includes(':') ||
      win32.extname(executable).toLowerCase() !== '.exe') {
    throw new WebMessageError('mcp-executable-path');
  }
  if (typeof cwd !== 'string' || cwd.length > 2048 || !localPath.test(cwd) ||
      /[\u0000-\u001f<>:"|?*]/.test(cwd.slice(2)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new WebMessageError('mcp-working-folder');
  }
  if (!Array.isArray(environment) || environment.length > 30) throw new WebMessageError('mcp-environment-limit');
  const names = new Set<string>();
  const references = environment.map((entry: unknown) => {
    const variable = typeof entry === 'string' ? entry.toUpperCase() : '';
    if (typeof entry !== 'string' || !environmentName.test(entry) || blockedEnvironment.test(variable) || names.has(variable)) {
      throw new WebMessageError('mcp-environment-invalid');
    }
    names.add(variable);
    return { name: entry, reference: `OEP_MCP_${id.toUpperCase()}_${variable}` };
  });
  return { ...common, transport: transport as 'stdio', command: [executable, ...args], cwd, environment: references };
}

const headerName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const managedHeader = /^(?:host|connection|transfer-encoding|content-length|content-type|accept|accept-encoding|upgrade|te|trailer|expect|proxy-.+|mcp-.+)$/i;

export function validateCustomRemoteMcp(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  const common = validateCommon(id, input, projects);
  const { transport, url: rawUrl, headers, localService } = input;
  const url = typeof rawUrl === 'string' && rawUrl.length <= 2048 && !/[\\\s]/.test(rawUrl) ? URL.parse(rawUrl) : null;
  if (transport !== 'remote' || !url || url.protocol !== 'https:' || url.username || url.password ||
      url.hash || url.search || url.hostname.startsWith('[') || typeof localService !== 'boolean') {
    throw new WebMessageError('mcp-url-invalid');
  }
  if (!Array.isArray(headers) || headers.length > 30) throw new WebMessageError('mcp-header-limit');
  const names = new Set<string>();
  const environment = headers.map((name: unknown) => {
    const suffix = typeof name === 'string' ? name.toUpperCase().replaceAll('-', '_') : '';
    if (typeof name !== 'string' || !headerName.test(name) || managedHeader.test(name) || names.has(suffix)) {
      throw new WebMessageError('mcp-header-invalid');
    }
    names.add(suffix);
    return { name, reference: `OEP_MCP_${id.toUpperCase()}_${suffix}` };
  });
  return { ...common, transport: transport as 'remote', url: url.href, localService, environment };
}

export async function pinCustomRemoteMcp(server: CustomRemoteMcp, signal: AbortSignal) {
  try {
    return await pinIpv4(new URL(server.url).hostname, server.localService, signal);
  } catch {
    throw new WebMessageError('mcp-network-address');
  }
}
