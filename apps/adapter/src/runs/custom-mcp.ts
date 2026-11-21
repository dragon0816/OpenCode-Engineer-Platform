import { pinIpv4 } from '../../../../packages/knowledge/src/bi/link-intake.ts';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { ProjectID } from './web-store.ts';

const localPath = /^[a-z]:[\\/]/i;
const unsafePath = /[\u0000-\u001f<>"|?*&^%!]/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const blockedEnvironment = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PSMODULEPATH|PYTHON.*|NODE_.*|BUN_.*|DENO_.*|LD_.*|DYLD_.*|OPENCODE_.*|OEP_.*)$/i;

export type CustomStdioMcp = ReturnType<typeof validateCustomStdioMcp>;
export type CustomRemoteMcp = ReturnType<typeof validateCustomRemoteMcp>;
export type CustomMcp = CustomStdioMcp | CustomRemoteMcp;

function validateCommon(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('伺服器識別碼無效。');
  const { name, enabled, timeouts, dataScope, appliesToProjects } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    throw new Error('請輸入 1 到 80 字的名稱。');
  }
  if (typeof enabled !== 'boolean') throw new Error('請檢查啟用設定。');
  if (!timeouts || typeof timeouts !== 'object') throw new Error('請設定逾時時間。');
  const milliseconds = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 120_000) {
      throw new Error('逾時時間須介於 100 到 120000 毫秒。');
    }
    return value;
  };
  const timing = timeouts as Record<string, unknown>;
  if (typeof dataScope !== 'string' || dataScope.length > 2000) throw new Error('資料範圍說明最多 2000 字。');
  if (!Array.isArray(appliesToProjects) || !appliesToProjects.every((project): project is ProjectID =>
    projects.includes(project)) || new Set(appliesToProjects).size !== appliesToProjects.length) {
    throw new Error('請選擇有效的專案。');
  }
  return { id, name: name.trim(), enabled, timeouts: {
    startup: milliseconds(timing.startup), catalog: milliseconds(timing.catalog),
    execution: milliseconds(timing.execution),
  }, dataScope, appliesToProjects };
}

export function validateCustomStdioMcp(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  const common = validateCommon(id, input, projects);
  const { transport, command, cwd, environment } = input;
  if (transport !== 'stdio') throw new Error('請檢查連線方式。');
  if (!Array.isArray(command) || command.length < 1 || command.length > 51 ||
      !command.every((argument): argument is string => typeof argument === 'string' && argument.length <= 2048 && !argument.includes('\0'))) {
    throw new Error('請逐行輸入執行檔和參數。');
  }
  const [executable, ...args] = command;
  if (!localPath.test(executable) || unsafePath.test(executable.slice(2)) || executable.slice(2).includes(':') ||
      win32.extname(executable).toLowerCase() !== '.exe') {
    throw new Error('請輸入本機執行檔的完整路徑。');
  }
  if (typeof cwd !== 'string' || cwd.length > 2048 || !localPath.test(cwd) ||
      /[\u0000-\u001f<>:"|?*]/.test(cwd.slice(2)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('請選擇現有的本機工作資料夾。');
  }
  if (!Array.isArray(environment) || environment.length > 30) throw new Error('最多可設定 30 個環境變數。');
  const names = new Set<string>();
  const references = environment.map((entry: unknown) => {
    const variable = typeof entry === 'string' ? entry.toUpperCase() : '';
    if (typeof entry !== 'string' || !environmentName.test(entry) || blockedEnvironment.test(variable) || names.has(variable)) {
      throw new Error('環境變數名稱無效、重複或由系統管理。');
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
    throw new Error('請輸入 HTTPS 網址，並移除網址中的憑證、查詢參數及片段。');
  }
  if (!Array.isArray(headers) || headers.length > 30) throw new Error('最多可設定 30 個 HTTP 標頭。');
  const names = new Set<string>();
  const environment = headers.map((name: unknown) => {
    const suffix = typeof name === 'string' ? name.toUpperCase().replaceAll('-', '_') : '';
    if (typeof name !== 'string' || !headerName.test(name) || managedHeader.test(name) || names.has(suffix)) {
      throw new Error('HTTP 標頭名稱無效、重複或由系統管理。');
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
    throw new Error('網址無法解析，或指向未確認的本機或私人位址。');
  }
}
