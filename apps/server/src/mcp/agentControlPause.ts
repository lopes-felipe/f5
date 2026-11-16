import { Layer, ServiceMap } from "effect";
/** Shared per-thread latch; resume must be an explicit user operation. */
export class AgentControlPause {
  private readonly threads = new Set<string>();
  private readonly listeners = new Set<(threadId: string, paused: boolean) => void>();
  list(): ReadonlyArray<string> {
    return [...this.threads];
  }
  has(threadId: string): boolean {
    return this.threads.has(threadId);
  }
  set(threadId: string, paused: boolean): void {
    if (this.has(threadId) === paused) return;
    if (paused) this.threads.add(threadId);
    else this.threads.delete(threadId);
    for (const listener of this.listeners) listener(threadId, paused);
  }
  subscribe(listener: (threadId: string, paused: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
export class AgentControlPauseService extends ServiceMap.Service<
  AgentControlPauseService,
  AgentControlPause
>()("t3/mcp/agentControlPause/AgentControlPauseService") {}
export const AgentControlPauseLive = Layer.sync(
  AgentControlPauseService,
  () => new AgentControlPause(),
);
