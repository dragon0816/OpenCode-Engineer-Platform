import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DelegationError } from './delegation-ledger.ts';
import type { CliVersion } from './external-cli.ts';
import type { CliReceipt, ExternalIsolation, VerifiedCli } from './external-executor.ts';
import type { Provider } from './external-ledger.ts';

type Pin = VerifiedCli['pin'];
type Inspection =
  | { isolation: 'unavailable'; installation: 'unknown' }
  | { isolation: 'verified'; installation: 'missing' | 'unsupported' }
  | { isolation: 'verified'; pin: Pin; copyRoot: string };
type Invocation = {
  provider: Provider; operation: 'version' | 'status' | 'key' | 'cli' | 'logout' | 'run';
  pin: Pin; arguments: string[]; input?: string; runId?: string;
};
export interface WindowsHelperOs {
  inspect(provider: Provider, signal: AbortSignal): Promise<Inspection>;
  invoke(request: Invocation, signal: AbortSignal, release?: () => void): Promise<CliReceipt>;
}

const unavailable = { isolation: 'unavailable', installation: 'unknown' } as const;
const invalid = () => new DelegationError('external-isolation-unavailable');
const supervisor = fileURLToPath(new URL('../../../../scripts/windows/external-helper-job.ps1', import.meta.url));
const maximumOutput = 200_000;

export function windowsHelperOs(dataRoot: string): WindowsHelperOs {
  const windows = process.env.SystemRoot;
  async function request(data: Record<string, unknown>, signal: AbortSignal, release?: () => void): Promise<unknown> {
    signal.throwIfAborted();
    if (process.platform !== 'win32' || !windows) throw invalid();
    const powershell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', supervisor], {
      cwd: dirname(supervisor), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { SystemRoot: windows, WINDIR: windows, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    const payload = JSON.stringify({ ...data, dataRoot, owner: process.pid }) + '\n';
    return new Promise((done, reject) => {
      let buffer = '';
      let released = false;
      let failure: unknown;
      let killAfter: NodeJS.Timeout | undefined;
      const cancel = () => {
        child.stdin.end();
        killAfter ??= setTimeout(() => child.kill(), 6_000);
      };
      const deadline = setTimeout(cancel, data.operation === 'run' ? 605_000 : data.operation === 'cli' ? 174_000 : 14_000);
      signal.addEventListener('abort', cancel, { once: true });
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= invalid(); });
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (failure) return;
        buffer += chunk;
        if (buffer.length > maximumOutput) { failure = invalid(); cancel(); return; }
        if (!release || released || !buffer.includes('\n')) return;
        const separator = buffer.indexOf('\n');
        if (buffer.slice(0, separator).trim() !== 'ready') return;
        buffer = buffer.slice(separator + 1);
        try {
          signal.throwIfAborted();
          release();
          released = true;
          child.stdin.write('run\n');
        } catch (error) { failure = error; cancel(); }
      });
      child.once('close', (exit) => {
        clearTimeout(deadline);
        clearTimeout(killAfter);
        signal.removeEventListener('abort', cancel);
        if (failure) { reject(failure); return; }
        if (exit !== 0) { reject(invalid()); return; }
        try { done(JSON.parse(buffer)); }
        catch { reject(invalid()); }
      });
      if (signal.aborted) cancel();
      else child.stdin.write(payload);
    });
  }
  return {
    async inspect(provider, signal) {
      const result = await request({ provider, operation: 'inspect' }, signal) as Partial<Inspection> | null;
      if (!result || result.isolation !== 'verified') return unavailable;
      if ('installation' in result && (result.installation === 'missing' || result.installation === 'unsupported')) {
        return { isolation: 'verified', installation: result.installation };
      }
      if (!('pin' in result) || typeof result.pin?.version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(result.pin.version) ||
          typeof result.pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.pin.sha256) || typeof result.copyRoot !== 'string') throw invalid();
      return { isolation: 'verified', pin: { version: result.pin.version as CliVersion, sha256: result.pin.sha256 }, copyRoot: result.copyRoot };
    },
    async invoke(data, signal, release) {
      const result = await request(data, signal, release) as Partial<CliReceipt> | null;
      if (!result || result.exit !== null && !Number.isSafeInteger(result.exit) || !Number.isSafeInteger(result.members) ||
          !Number.isSafeInteger(result.orphans) || typeof result.stdout !== 'string' ||
          result.reason != null && result.reason !== 'external-cli-output-limit') throw invalid();
      return { exit: result.exit!, members: result.members!, orphans: result.orphans!, reason: result.reason ?? undefined,
        stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.stdout, 'base64')) };
    },
  };
}

export function windowsExternalIsolation(dataRoot: string, os = windowsHelperOs(dataRoot)): ExternalIsolation {
  return {
    async connect(provider, signal) {
      let result: Inspection;
      try { result = await os.inspect(provider, signal); }
      catch { signal.throwIfAborted(); return unavailable; }
      if (!('pin' in result)) return result;
      const { pin, copyRoot } = result;
      const invoke = (operation: Invocation['operation'], args: string[], stop: AbortSignal, input?: string,
        runId?: string, release?: () => void) => os.invoke({ provider, operation, pin, arguments: args, input, runId }, stop, release);
      return {
        pin, sha256: pin.sha256, copyRoot,
        probe: (args, stop) => invoke(args[0] === '--version' ? 'version' : 'status', args, stop),
        authenticate: async (args, action, stop) => {
          const receipt = await invoke(action.action, args, stop, action.action === 'key' ? action.key + '\n' : undefined);
          if (receipt.exit !== 0 || receipt.reason || receipt.orphans !== 0) throw new DelegationError('external-auth-failed');
        },
        run: (args, copy, stop, release) => {
          const run = dirname(copy.work.root);
          if (dirname(run) !== resolve(copyRoot) || copy.scratch.root !== join(run, 'scratch') ||
              copy.inputs.root !== join(run, 'work', 'oep-inputs') || copy.work.root !== join(run, 'work')) throw invalid();
          return invoke('run', args, stop, copy.prompt, basename(run), release);
        },
      };
    },
  };
}
