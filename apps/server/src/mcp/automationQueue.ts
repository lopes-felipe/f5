/** Resource FIFO. Cancellation only removes pending work; running callers own cleanup. */
export class AutomationQueue<E> {
  private readonly queues = new Map<
    string,
    { running: boolean; waiting: Array<{ start: () => void; reject: (error: E) => void }> }
  >();
  constructor(
    private readonly options: {
      capacity: number;
      busy: () => E;
      cancelled: () => E;
      expired: () => E;
    },
  ) {}
  acquire(
    resource: string,
    signal: AbortSignal,
    waitMs: number,
  ): Promise<{ release: () => void; waited: boolean }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(this.options.cancelled());
        return;
      }
      if (waitMs <= 0) {
        reject(this.options.expired());
        return;
      }
      let queue = this.queues.get(resource);
      if (!queue) {
        queue = { running: false, waiting: [] };
        this.queues.set(resource, queue);
      }
      const active = queue;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const next = active.waiting.shift();
        if (next) next.start();
        else {
          active.running = false;
          if (this.queues.get(resource) === active) this.queues.delete(resource);
        }
      };
      if (!active.running) {
        active.running = true;
        resolve({ release, waited: false });
        return;
      }
      if (active.waiting.length >= this.options.capacity) {
        reject(this.options.busy());
        return;
      }
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const entry = {
        start: () => {
          settle();
          resolve({ release, waited: true });
        },
        reject: (error: E) => {
          settle();
          reject(error);
        },
      };
      const leave = (error: E) => {
        const index = active.waiting.indexOf(entry);
        if (index < 0) return;
        active.waiting.splice(index, 1);
        entry.reject(error);
      };
      const onAbort = () => leave(this.options.cancelled());
      const timer = setTimeout(() => leave(this.options.expired()), Math.max(0, waitMs));
      signal.addEventListener("abort", onAbort, { once: true });
      active.waiting.push(entry);
    });
  }
  flush(resource: string, error: E): void {
    for (const entry of this.queues.get(resource)?.waiting.splice(0) ?? []) entry.reject(error);
  }
  flushAll(error: E): void {
    for (const key of this.queues.keys()) this.flush(key, error);
  }
}
