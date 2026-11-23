import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEnvironment } from '../../../apps/adapter/src/runs/external-cli.ts';
import type { CliReceipt, ExternalIsolation } from '../../../apps/adapter/src/runs/external-executor.ts';
import type { Provider } from '../../../apps/adapter/src/runs/external-ledger.ts';
import { sha256 } from '../../../packages/knowledge/src/snapshot.ts';

const fixture = dirname(fileURLToPath(import.meta.url));

export function restrictedJobFixture(root: string) {
  const windows = process.env.SystemRoot!;
  const ps = process.env.OEP_PWSH || join(process.env.ProgramFiles!, 'PowerShell', '7', 'pwsh.exe');
  const supervisor = join(root, 'supervisor');
  const runtime = join(root, 'runtime');
  const privateDir = join(root, 'private');
  for (const path of [supervisor, runtime, privateDir]) mkdirSync(path);
  const node = join(runtime, 'node.exe');
  const script = join(runtime, 'fake-cli.mjs');
  copyFileSync(process.execPath, node);
  copyFileSync(join(fixture, 'fake-cli.mjs'), script);
  const canary = join(privateDir, 'canary.txt');
  writeFileSync(canary, 'Synthetic private canary');
  const digest = () => sha256(Buffer.concat([readFileSync(node), readFileSync(script)]));
  const pin = { version: '1.2.3' as const, sha256: digest() };
  const env = { SystemRoot: windows, WINDIR: windows, TMP: supervisor, TEMP: supervisor };
  const baseArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(fixture, 'windows-probe.ps1')];
  const runOptions = { env, windowsHide: true, encoding: 'utf8' as const, timeout: 15_000 };
  const integrity = (path: string, level: 'L' | 'M') => {
    assert.ok(relative(root, path) && !relative(root, path).startsWith('..'));
    execFileSync(join(windows, 'System32', 'icacls.exe'), [path, '/setintegritylevel', `(OI)(CI)${level}`, '/T'], runOptions);
  };
  execFileSync(ps, [...baseArgs, '-Canary', canary], runOptions);
  const profiles = new Map<Provider, string>();
  for (const provider of ['codex_cli', 'claude_code'] as const) {
    const rootPath = join(root, provider);
    mkdirSync(rootPath);
    for (const part of ['local', 'roaming', 'home']) mkdirSync(join(rootPath, part));
    profiles.set(provider, rootPath);
  }
  let mode = 'normal';
  let launches = 0;
  let activeRun: ReturnType<typeof spawn> | undefined;
  const receipts: (CliReceipt & { observed: number[]; diagnosis: string })[] = [];
  const failures: string[] = [];
  const invoke = (provider: Provider, flags: string[], cwd: string, scratch: string, signal: AbortSignal, prompt = '', release?: () => void) => {
    signal.throwIfAborted();
    const profile = profiles.get(provider)!;
    const environment = cliEnvironment(provider, { windows, runtime, profile, localAppData: join(profile, 'local'),
      roaming: join(profile, 'roaming'), home: join(profile, 'home'), scratch });
    const request = JSON.stringify({ file: node, arguments: [script, provider, mode, ...flags], cwd,
      input: Buffer.from(prompt).toString('base64'), owner: process.pid, environment }) + '\n';
    release?.();
    if (release) launches++;
    return new Promise<CliReceipt>((resolve, reject) => {
      const child = spawn(ps, baseArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (release) activeRun = child;
      let stdout = '';
      let stderr = '';
      let overflow = false;
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8').on('data', (part: string) => {
        if (stdout.length + part.length <= 200_000) stdout += part;
        else overflow = true;
      });
      child.stderr.setEncoding('utf8').on('data', (part: string) => { if (stderr.length < 4096) stderr += part; });
      const cancel = () => child.stdin.end();
      signal.addEventListener('abort', cancel, { once: true });
      child.stdin.write(request);
      if (signal.aborted) cancel();
      const timeout = setTimeout(() => child.kill(), 45_000);
      child.once('error', reject);
      child.once('close', (code) => {
        if (activeRun === child) activeRun = undefined;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        if (code !== 0 || overflow) {
          const message = stderr || 'Synthetic supervisor stopped without a receipt';
          failures.push(message);
          reject(new Error(message));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as (typeof receipts)[number];
          const receipt = { ...parsed, stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parsed.stdout, 'base64')) };
          receipts.push(receipt);
          resolve(receipt);
        } catch (error) { reject(error); }
      });
    });
  };
  const isolation: ExternalIsolation = {
    async connect(provider, signal) {
      signal.throwIfAborted();
      if (mode === 'unavailable') return { isolation: 'unavailable', installation: 'unknown' };
      if (mode === 'missing') return { isolation: 'verified', installation: 'missing' };
      return { pin, sha256: digest(), probe: (args, stop) => {
        const empty = mkdtempSync(join(root, 'probe-'));
        integrity(empty, 'L');
        return invoke(provider, args, empty, empty, stop);
      }, run: (args, copy, stop, release) => {
        integrity(copy.work.root, 'L');
        integrity(copy.inputs.root, 'M');
        integrity(copy.scratch.root, 'L');
        return invoke(provider, args, copy.work.root, copy.scratch.root, stop, copy.prompt, release);
      } };
    },
  };
  return { isolation, receipts, failures, canary, script, launches: () => launches,
    stopSupervisor: () => activeRun?.kill(), mode: (value: string) => { mode = value; } };
}
