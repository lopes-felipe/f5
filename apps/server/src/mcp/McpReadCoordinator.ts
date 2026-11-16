/** No TTL cache. Uncancellable reads retain their slot and identity until settlement.
 * Claude can occupy two slots; two remain available to cancellable Codex reads.
 */
export class McpReadCoordinator {
  private readonly reads = new Map<string, Promise<unknown>>();
  private active = 0;
  private claudeActive = 0;
  private tracked = 0;
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  read<T>(
    key: string,
    start: (signal: AbortSignal, deadline: number) => Promise<T>,
    timeoutMs = 10_000,
    group?: "claude",
  ): Promise<T> {
    if (this.disposed || this.tracked >= 64)
      return Promise.reject(
        new Error("MCP reads are temporarily unavailable. Try Refresh shortly."),
      );
    const existing = this.reads.get(key) as Promise<T> | undefined;
    if (existing) return this.withDeadline(existing, timeoutMs);
    if (
      this.disposed ||
      this.active >= 4 ||
      this.reads.size >= 64 ||
      (group === "claude" && this.claudeActive >= 2)
    )
      return Promise.reject(
        new Error("MCP reads are temporarily unavailable. Try Refresh shortly."),
      );
    const controller = new AbortController();
    this.controllers.add(controller);
    const deadline = Date.now() + 9_900;
    const timer = setTimeout(() => controller.abort(), 10_000);
    this.active++;
    if (group === "claude") this.claudeActive++;
    const pending = Promise.resolve()
      .then(() => {
        if (this.disposed || controller.signal.aborted)
          throw new Error("MCP reader was disposed or cancelled.");
        return start(controller.signal, deadline);
      })
      .then((result) => {
        if (this.disposed) throw new Error("MCP reader was disposed.");
        return result;
      })
      .finally(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        this.active--;
        if (group === "claude") this.claudeActive--;
        this.reads.delete(key);
      });
    this.reads.set(key, pending);
    return this.withDeadline(pending, timeoutMs);
  }

  private withDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    this.tracked++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        this.tracked--;
        clearTimeout(timer);
        complete();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("MCP read timed out. Try Refresh."))),
        timeoutMs,
      );
      pending.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

export const mcpProviderReads = new McpReadCoordinator();
const contextIds = new WeakMap<object, number>();
let nextContextId = 0;
export function mcpContextKey(context: object): string {
  let id = contextIds.get(context);
  if (id === undefined) {
    id = ++nextContextId;
    contextIds.set(context, id);
  }
  return String(id);
}
