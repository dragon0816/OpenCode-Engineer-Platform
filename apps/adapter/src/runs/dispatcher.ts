import type { ResolvedOutcome, WorkItem, WorkItems, WorkLease, WorkOutcome, WorkRequest } from './work-items.ts';

type Result = { state: WorkOutcome; reason?: string };
type Recovery = Result | 'never-started';
type Handler = {
  available?: (item: WorkItem) => boolean;
  execute: (item: WorkLease, start: () => void, signal: AbortSignal) => Promise<Result>;
  retryBeforeStart?: (item: WorkLease, now: number) => number | undefined;
  recoverBeforeStart?: boolean;
  recover?: (item: WorkLease) => Promise<Recovery | undefined>;
  canResolve?: (item: WorkLease, outcome: ResolvedOutcome) => Promise<boolean>;
  resolved?: (item: WorkLease, outcome: ResolvedOutcome) => void;
  expired?: (item: WorkItem) => void;
  expireInTransaction?: (item: WorkItem) => void;
  finish?: (item: WorkLease, result: Result) => boolean;
  resolve?: (item: WorkLease, outcome: ResolvedOutcome) => boolean;
};
const pending = (item: WorkItem) => item.state === 'queued' || item.state === 'running';

export class Dispatcher {
  readonly items: WorkItems;
  private readonly clock: () => number;
  private readonly handlers = new Map<string, Handler>();
  private readonly running = new Set<Promise<void>>();
  private readonly listeners = new Map<string, Set<(item: WorkItem) => void>>();
  private readonly stop = new AbortController();
  private timer?: NodeJS.Timeout;
  private recovery?: Promise<void>;
  private scheduled = false;
  private ready = false;

  constructor(items: WorkItems, clock = Date.now) {
    this.items = items;
    this.clock = clock;
  }

  register(kind: string, handler: Handler) {
    if (this.handlers.has(kind)) throw new Error('Work handler is already registered');
    this.handlers.set(kind, handler);
  }

  start() {
    if (this.recovery) return this.recovery;
    this.recovery = this.recover().then(() => {
      if (this.stop.signal.aborted) return;
      this.ready = true;
      this.timer = setInterval(() => this.kick(), 1000);
      this.timer.unref();
      this.kick();
    });
    return this.recovery;
  }

  enqueue(request: WorkRequest) {
    const { item } = this.items.enqueue(request, this.clock());
    this.kick();
    return item;
  }

  wait(id: string, signal?: AbortSignal): Promise<WorkItem> {
    const item = this.items.get(id);
    if (!item) return Promise.reject(new Error('Unknown work item'));
    if (!pending(item)) return Promise.resolve(item);
    const stop = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal;
    return new Promise((resolve, reject) => {
      stop.throwIfAborted();
      const listeners = this.listeners.get(id) ?? new Set();
      this.listeners.set(id, listeners);
      const clean = () => {
        stop.removeEventListener('abort', abort);
        listeners.delete(done);
        if (!listeners.size) this.listeners.delete(id);
      };
      const done = (finished: WorkItem) => { clean(); resolve(finished); };
      const abort = () => { clean(); reject(stop.reason); };
      listeners.add(done);
      stop.addEventListener('abort', abort, { once: true });
    });
  }

  private notify(id: string) {
    if (!this.listeners.has(id)) return;
    const item = this.items.get(id);
    if (item && !pending(item)) {
      for (const listener of this.listeners.get(id) ?? []) listener(item);
    }
  }

  cancel(id: string) {
    const cancelled = this.items.cancel(id);
    if (cancelled) this.notify(id);
    return cancelled;
  }

  async resolve(id: string, leaseId: string, outcome: ResolvedOutcome) {
    const item = this.items.get(id);
    if (item?.state !== 'indeterminate' || item.leaseId !== leaseId) return false;
    const handler = this.handlers.get(item.payload.kind);
    if (handler?.canResolve && !await handler.canResolve({ ...item, leaseId }, outcome)) return false;
    if (!(handler?.resolve?.({ ...item, leaseId }, outcome) ?? this.items.resolve(id, leaseId, outcome))) return false;
    handler?.resolved?.({ ...item, leaseId }, outcome);
    this.notify(id);
    this.kick();
    return true;
  }

  kick() {
    if (!this.ready || this.scheduled || this.stop.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.stop.signal.aborted) return;
      try { this.drain(); }
      catch { console.error('OEP could not claim persistent agent work'); }
    });
  }

  private drain() {
    const now = this.clock();
    for (const item of this.items.expire(now, (item) => this.handlers.get(item.payload.kind)?.expireInTransaction?.(item))) {
      this.handlers.get(item.payload.kind)?.expired?.(item);
      this.notify(item.id);
    }
    while (true) {
      const lease = this.items.claim((item) => {
        const handler = this.handlers.get(item.payload.kind);
        return Boolean(handler && (handler.available?.(item) ?? true));
      }, now);
      if (!lease) return;
      const handler = this.handlers.get(lease.payload.kind)!;
      const task = this.run(handler, lease).catch(() => {
        console.error('OEP could not record the outcome of persistent agent work');
      }).finally(() => {
        this.running.delete(task);
        this.kick();
      });
      this.running.add(task);
    }
  }

  private async run(handler: Handler, item: WorkLease) {
    let started = false;
    const start = () => {
      this.stop.signal.throwIfAborted();
      if (!this.items.markStarted(item)) throw new Error('Work lease changed before execution');
      started = true;
    };
    let result: Result;
    try {
      result = await handler.execute(item, start, this.stop.signal);
    } catch {
      if (!started) {
        const retryAt = this.stop.signal.aborted ? this.clock() : handler.retryBeforeStart?.(item, this.clock());
        if (retryAt !== undefined) {
          this.items.requeue(item, retryAt);
          return;
        }
      }
      result = started ? { state: 'indeterminate', reason: 'outcome-unknown' } : { state: 'failed', reason: 'dispatch-failed' };
    }
    if (this.finish(item, result)) this.notify(item.id);
  }

  private finish(item: WorkLease, result: Result) {
    const handler = this.handlers.get(item.payload.kind);
    return handler?.finish?.(item, result) ?? this.items.finish(item, result.state, result.reason);
  }

  private async recover() {
    for (const item of this.items.withLease()) {
      const handler = this.handlers.get(item.payload.kind);
      if (item.state === 'running' && item.reasonCode === null && !handler?.recoverBeforeStart) {
        this.items.requeue(item);
        continue;
      }
      let result: Recovery | undefined;
      try { result = await handler?.recover?.(item); }
      catch { /* Inaccessible state cannot prove that the work is safe to replay. */ }
      if (item.state === 'indeterminate') {
        if (result && result !== 'never-started' && (result.state === 'succeeded' || result.state === 'failed' || result.state === 'cancelled')) {
          if (handler?.resolve?.(item, result.state)) handler.resolved?.(item, result.state);
        }
        continue;
      }
      if (result === 'never-started') this.items.requeue(item);
      else this.finish(item, result ?? { state: 'indeterminate', reason: 'restart-reconciliation' });
    }
  }

  busy() { return Boolean(this.running.size); }

  async close() {
    clearInterval(this.timer);
    this.stop.abort();
    await this.recovery;
    await Promise.all(this.running);
  }
}
