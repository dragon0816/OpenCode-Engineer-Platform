import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atRepo } from '../../../launcher/src/paths.ts';
import type { CustomStdioMcp } from './custom-mcp.ts';

export type McpFingerprint = { sha256: string; signer: string | null; thumbprint: string | null; signatureStatus: string };
export type McpTrust = McpFingerprint & { changed?: true };
export type ReadMcpFingerprint = (path: string) => McpFingerprint;

export function mcpExecutableIdentity(path: string) {
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.nlink !== 1n || realpathSync.native(path).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new Error('Unsafe MCP executable');
  }
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
}

export const readMcpFingerprint: ReadMcpFingerprint = (path) => {
  const identity = mcpExecutableIdentity(path);
  const powershell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', atRepo('scripts/windows/Get-OEPMcpFingerprint.ps1'), path],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PSModulePath: join(powershell, '..', 'Modules') } });
  const fingerprint = JSON.parse(output) as McpFingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint.sha256) || typeof fingerprint.signatureStatus !== 'string' ||
    (fingerprint.signer === null ? fingerprint.thumbprint !== null : typeof fingerprint.signer !== 'string' ||
      !/^[a-f0-9]{40}$/.test(fingerprint.thumbprint ?? '')) || mcpExecutableIdentity(path) !== identity) {
    throw new Error('Invalid or changed MCP executable');
  }
  return fingerprint;
};

export function sameMcpFingerprint(left: McpFingerprint, right: McpFingerprint) {
  return left.sha256 === right.sha256 && left.signer === right.signer && left.thumbprint === right.thumbprint &&
    left.signatureStatus === right.signatureStatus;
}

export function sameStdioCommand(left: CustomStdioMcp, right: CustomStdioMcp) {
  return left.cwd === right.cwd && JSON.stringify(left.command) === JSON.stringify(right.command) &&
    JSON.stringify(left.environment) === JSON.stringify(right.environment);
}

export function monitorMcpTrust(read: ReadMcpFingerprint = readMcpFingerprint) {
  const checked = new Map<string, { identity: string; fingerprint: McpFingerprint }>();
  return (server: CustomStdioMcp) => {
    const trust = server.trust;
    if (!trust || trust.changed) return false;
    try {
      const path = server.command[0];
      const identity = mcpExecutableIdentity(path);
      const cached = checked.get(server.id);
      const fingerprint = cached?.identity === identity ? cached.fingerprint : read(path);
      checked.set(server.id, { identity, fingerprint });
      return sameMcpFingerprint(trust, fingerprint);
    } catch { return false; }
  };
}
