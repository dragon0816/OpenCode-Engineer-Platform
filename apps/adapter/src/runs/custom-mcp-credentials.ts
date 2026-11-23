import { WebMessageError } from '../http/errors.ts';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const referenceName = /^OEP_MCP_[A-F0-9]{32}_[A-Z_][A-Z0-9_]{0,63}$/;

function run(script: string, input: object) {
  const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 5_000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0) throw new WebMessageError('credential-access');
  return result.stdout;
}

const readInput = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json; ";

export function configuredCustomMcpCredentials(names: string[]): Set<string> {
  if (names.some((name) => !referenceName.test(name))) throw new WebMessageError('credential-name');
  if (!names.length) return new Set();
  const output = run(readInput + "foreach ($name in $inputData.names) { if ([Environment]::GetEnvironmentVariable($name,'User')) { $name } }", { names });
  return new Set(output.split(/\s+/).filter((name) => names.includes(name)));
}

export function saveCustomMcpCredential(name: string, value: unknown) {
  if (!referenceName.test(name) || typeof value !== 'string' || !value || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value) || !value.trim()) throw new WebMessageError('credential-value');
  writeUserCredential(name, value);
}

export function writeUserCredential(name: string, value: string | null) {
  run(readInput + "[Environment]::SetEnvironmentVariable($inputData.name,$inputData.value,'User')", { name, value });
}

export function readCustomMcpCredentials(names: string[]): Record<string, string> {
  if (names.some((name) => !referenceName.test(name))) throw new WebMessageError('credential-name');
  return readUserCredentials(names);
}

export function readUserCredentials(names: string[]): Record<string, string> {
  if (!names.length) return {};
  const script = readInput + "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $values=@{}; foreach ($name in $inputData.names) { $value=[Environment]::GetEnvironmentVariable($name,'User'); if ($value) { $values[$name]=$value } }; $values | ConvertTo-Json -Compress";
  return JSON.parse(run(script, { names }));
}
