import { DelegationError } from './delegation-ledger.ts';
import { checkCliResult, cliArgs, cliAuthArgs, cliLogin, cliVersion, helperReady, unavailableHelper, type CliVersion, type HelperAuthAction,
  type HelperStatus } from './external-cli.ts';
import { createExternalCopy } from './external-copy.ts';
import type { Provider, Snapshot } from './external-ledger.ts';

type Copy = ReturnType<ReturnType<typeof createExternalCopy>['stage']>;
export type CliReceipt = {
  exit: number | null; stdout: string; members: number; orphans: number;
  reason?: 'external-cli-output-limit' | 'external-cli-start-failed';
};
export type VerifiedCli = {
  // The boundary must pin the executable object for probes and the job, not only its pathname.
  pin: { version: CliVersion; sha256: string };
  sha256: string;
  probe(args: string[], signal: AbortSignal): Promise<CliReceipt>;
  // Interactive output belongs to the provider's window. Keys enter through stdin or the helper account's credential store.
  authenticate?(args: string[], action: HelperAuthAction, signal: AbortSignal): Promise<void>;
  run(args: string[], copy: Pick<Copy, 'work' | 'inputs' | 'scratch' | 'prompt'>, signal: AbortSignal,
    release: () => void): Promise<CliReceipt>;
};
export interface ExternalIsolation {
  // Connect only after verifying the dedicated OS identity, effective ACLs and binary.
  // A stopped receipt requires the live Job member count to be checked.
  connect(provider: Provider, signal: AbortSignal): Promise<
    { isolation: HelperStatus['isolation']; installation: 'unknown' | 'missing' | 'unsupported' } | VerifiedCli>;
}

export class ExternalExecutionUnknown extends Error {
  constructor() { super('External execution boundary has no verified stop receipt'); }
}

function stopped(receipt: CliReceipt) {
  if (!Number.isSafeInteger(receipt.members) || receipt.members < 0 || receipt.orphans !== 0) throw new ExternalExecutionUnknown();
}

export class ExternalExecutor {
  readonly #root: string;
  readonly #isolation?: ExternalIsolation;
  readonly #status = new Map<Provider, HelperStatus>();
  readonly #authenticating = new Set<Provider>();

  constructor(root: string, isolation?: ExternalIsolation) { this.#root = root; this.#isolation = isolation; }

  status(provider: Provider) { return this.#status.get(provider) ?? unavailableHelper; }

  async refresh(provider: Provider, signal: AbortSignal) {
    if (this.#authenticating.has(provider)) return this.status(provider);
    try { await this.#probe(provider, signal); }
    catch { this.#status.set(provider, unavailableHelper); }
    return this.status(provider);
  }

  async authenticate(provider: Provider, action: HelperAuthAction, signal: AbortSignal) {
    if (this.#authenticating.has(provider)) throw new DelegationError('external-auth-busy');
    this.#authenticating.add(provider);
    try {
      const candidate = await this.#probe(provider, signal, false);
      if (this.status(provider).isolation !== 'verified') throw new DelegationError('external-isolation-unavailable');
      if (!candidate?.authenticate) throw new DelegationError('external-auth-unavailable');
      await candidate.authenticate(cliAuthArgs(provider, action.action), action, signal);
      await this.#probe(provider, signal);
      return this.status(provider);
    } catch (error) {
      if (error instanceof DelegationError) throw error;
      this.#status.set(provider, { ...this.status(provider), login: 'probeFailed' });
      throw new DelegationError('external-auth-failed');
    } finally { this.#authenticating.delete(provider); }
  }

  async #probe(provider: Provider, signal: AbortSignal, checkLogin = true) {
    const candidate = await this.#isolation?.connect(provider, signal);
    signal.throwIfAborted();
    if (!candidate || !('pin' in candidate)) {
      this.#status.set(provider, candidate ? { ...candidate, login: 'unknown' } : unavailableHelper);
      return;
    }
    const base: HelperStatus = { installation: 'unsupported', isolation: 'verified', login: 'unknown', pinnedVersion: candidate.pin.version };
    this.#status.set(provider, base);
    if (!/^[a-f\d]{64}$/.test(candidate.pin.sha256) || candidate.sha256 !== candidate.pin.sha256) return;
    const versionReceipt = await candidate.probe(cliArgs(provider, 'version'), signal);
    stopped(versionReceipt);
    signal.throwIfAborted();
    if (versionReceipt.reason || versionReceipt.exit !== 0) return;
    const version = cliVersion(provider, versionReceipt.stdout);
    this.#status.set(provider, { ...base, version });
    if (version !== candidate.pin.version) return;
    this.#status.set(provider, { ...base, installation: 'detected', version, login: 'probeFailed' });
    if (!checkLogin) return candidate;
    const auth = await candidate.probe(cliArgs(provider, 'login'), signal);
    stopped(auth);
    signal.throwIfAborted();
    if (auth.reason || auth.exit === null) return;
    const login = cliLogin(provider, auth.exit, auth.stdout);
    this.#status.set(provider, { ...base, installation: 'detected', version, login });
    if (login === 'signedIn') return candidate;
  }

  async execute(snapshot: Snapshot, runId: string, turns: number, signal: AbortSignal, check: () => void,
    start: (version: CliVersion) => void, audit: (reason: string, members?: number) => void, validate: () => void) {
    const provider = snapshot.provider;
    if (this.#authenticating.has(provider)) throw new DelegationError('external-auth-busy');
    const candidate = await this.#probe(provider, signal);
    check();
    if (!candidate) {
      const status = this.status(provider);
      throw new DelegationError(status.isolation !== 'verified' ? 'external-isolation-unavailable' :
        status.installation !== 'detected' ? 'external-cli-unsupported' : 'external-cli-login-unavailable');
    }
    const args = cliArgs(provider, 'run', turns);
    const copy = createExternalCopy(this.#root, runId, provider);
    let released = false;
    let zero = false;
    try {
      const { work, inputs, scratch, prompt, ...baseline } = copy.stage(snapshot, check);
      const receipt = await candidate.run(args, { work, inputs, scratch, prompt }, signal, () => {
        if (released || this.#authenticating.has(provider) || !helperReady(this.status(provider))) {
          throw new DelegationError('external-isolation-unavailable');
        }
        check();
        start(candidate.pin.version);
        released = true;
      });
      stopped(receipt);
      zero = true;
      audit('external-job-stopped', receipt.members);
      check();
      if (receipt.reason) throw new DelegationError(receipt.reason);
      if (!released || receipt.exit !== 0) throw new DelegationError('external-cli-failed');
      checkCliResult(provider, receipt.stdout);
      copy.clearScratch(scratch, check);
      const changes = (() => {
        try { return copy.collect({ work, inputs, scratch, prompt, ...baseline }, check); }
        catch (error) {
          check();
          throw error instanceof DelegationError ? error : new DelegationError('external-copy-unsafe');
        }
      })();
      validate();
      check();
      return { summary: `${changes.count} ${changes.count === 1 ? 'file changed' : 'files changed'}.`, changes };
    } catch (error) {
      if (released && !zero) throw new ExternalExecutionUnknown();
      try {
        copy.discard(() => {});
        audit('external-copy-discarded');
      } catch { throw new ExternalExecutionUnknown(); }
      throw error;
    }
  }
}
