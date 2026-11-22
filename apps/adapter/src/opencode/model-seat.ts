export class ModelSeat {
  private tail = Promise.resolve();

  run<T>(work: () => Promise<T>, signal?: AbortSignal) {
    const result = this.tail.then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
