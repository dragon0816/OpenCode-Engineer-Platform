import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { ProjectID } from './web-store.ts';

const localPath = /^[a-z]:[\\/]/i;
const unsafePath = /[\u0000-\u001f<>"|?*&^%!]/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const blockedEnvironment = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|PSMODULEPATH|PYTHON.*|NODE_.*|BUN_.*|DENO_.*|LD_.*|DYLD_.*|OPENCODE_.*|OEP_.*)$/i;

export type CustomStdioMcp = ReturnType<typeof validateCustomStdioMcp>;

export function validateCustomStdioMcp(id: string, input: Record<string, unknown>, projects: readonly ProjectID[]) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('伺服器識別碼無效。');
  const { name, transport, enabled, command, cwd, environment, timeouts, dataScope, appliesToProjects } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    throw new Error('請輸入 1 到 80 字的名稱。');
  }
  if (transport !== 'stdio' || typeof enabled !== 'boolean') throw new Error('請檢查連線方式與啟用設定。');
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
  return { id, name: name.trim(), transport, enabled, command: [executable, ...args], cwd, environment: references,
    timeouts: { startup: milliseconds(timing.startup), catalog: milliseconds(timing.catalog),
      execution: milliseconds(timing.execution) }, dataScope, appliesToProjects };
}
