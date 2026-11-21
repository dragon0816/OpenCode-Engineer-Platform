import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const referenceName = /^OEP_MCP_[A-F0-9]{32}_[A-Z_][A-Z0-9_]{0,63}$/;

function run(script: string, input: object) {
  const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 5_000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0) throw new Error('無法存取 Windows 使用者憑證。');
  return result.stdout;
}

const readInput = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json; ";

export function configuredCustomMcpCredentials(names: string[]): Set<string> {
  if (names.some((name) => !referenceName.test(name))) throw new Error('憑證名稱無效。');
  if (!names.length) return new Set();
  const output = run(readInput + "foreach ($name in $inputData.names) { if ([Environment]::GetEnvironmentVariable($name,'User')) { $name } }", { names });
  return new Set(output.split(/\s+/).filter((name) => names.includes(name)));
}

export function saveCustomMcpCredential(name: string, value: unknown) {
  if (!referenceName.test(name) || typeof value !== 'string' || !value || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value) || !value.trim()) throw new Error('請輸入有效的憑證值。');
  run(readInput + "[Environment]::SetEnvironmentVariable($inputData.name,$inputData.value,'User')", { name, value });
}
