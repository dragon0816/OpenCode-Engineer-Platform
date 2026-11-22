export class ModelSeat {
  private tail = Promise.resolve();
  private readonly holds = new Set<string>();
  private released?: PromiseWithResolvers<void>;

  run<T>(work: () => Promise<T>, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const waiting = signal && Promise.withResolvers<never>();
    const abort = () => waiting?.reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const result = this.tail.then(async () => {
      while (this.released) await this.wait(this.released.promise, signal);
      signal?.throwIfAborted();
      signal?.removeEventListener('abort', abort);
      return work();
    });
    this.tail = result.then(() => {}, () => {});
    return waiting ? Promise.race([result, waiting.promise]).finally(() => signal?.removeEventListener('abort', abort)) : result;
  }

  hold(id: string) {
    this.holds.add(id);
    this.released ??= Promise.withResolvers<void>();
  }

  release(id: string) {
    this.holds.delete(id);
    if (!this.holds.size) {
      this.released?.resolve();
      this.released = undefined;
    }
  }

  private async wait(released: Promise<void>, signal?: AbortSignal) {
    if (!signal) return released;
    signal.throwIfAborted();
    const stop = Promise.withResolvers<never>();
    const abort = () => stop.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try { await Promise.race([released, stop.promise]); }
    finally { signal.removeEventListener('abort', abort); }
  }
}
