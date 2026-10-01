import type { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Ref, ServiceMap } from "effect";

/**
 * In-memory registry of running worktree setups, consulted by the queue gate.
 *
 * The durable half is `next_turn_queue_state.worktree_block_token`, written in
 * the same transaction that queues the first turn. A token with a live entry
 * here means the setup is still preparing the worktree, so the turn waits. A
 * token without a live entry means the server restarted (or the fiber died)
 * mid-setup, so the queue pauses as failed instead of starting the turn in a
 * worktree that was never finished.
 */
export type WorktreeSetupGateState = "none" | "gating" | "orphaned";

export interface WorktreeSetupGateShape {
  readonly register: (threadId: ThreadId, token: string) => Effect.Effect<void>;
  /** Stops gating the turn; the token must match the registered setup. */
  readonly open: (threadId: ThreadId, token: string) => Effect.Effect<void>;
  readonly unregister: (threadId: ThreadId, token: string) => Effect.Effect<void>;
  readonly check: (
    threadId: ThreadId,
    durableToken: string | null,
  ) => Effect.Effect<WorktreeSetupGateState>;
}

export class WorktreeSetupGate extends ServiceMap.Service<
  WorktreeSetupGate,
  WorktreeSetupGateShape
>()("t3/project/Services/WorktreeSetupGate") {}

interface Entry {
  readonly token: string;
  readonly gating: boolean;
}

export const makeWorktreeSetupGate = Effect.gen(function* () {
  const entries = yield* Ref.make(new Map<ThreadId, Entry>());
  const set = (
    threadId: ThreadId,
    token: string,
    update: (entry: Entry | undefined) => Entry | null,
  ) =>
    Ref.update(entries, (current) => {
      const existing = current.get(threadId);
      if (existing && existing.token !== token) return current;
      const next = new Map(current);
      const value = update(existing);
      if (value === null) next.delete(threadId);
      else next.set(threadId, value);
      return next;
    });
  return {
    register: (threadId, token) =>
      Ref.update(entries, (current) => new Map(current).set(threadId, { token, gating: true })),
    open: (threadId, token) =>
      set(threadId, token, (entry) => (entry ? { ...entry, gating: false } : null)),
    unregister: (threadId, token) => set(threadId, token, () => null),
    check: (threadId, durableToken) =>
      Ref.get(entries).pipe(
        Effect.map((current): WorktreeSetupGateState => {
          const entry = current.get(threadId);
          if (entry?.gating) return "gating";
          // An open entry means the setup handed off and is clearing its token.
          if (entry || durableToken === null) return "none";
          return "orphaned";
        }),
      ),
  } satisfies WorktreeSetupGateShape;
});

export const WorktreeSetupGateLive = Layer.effect(WorktreeSetupGate, makeWorktreeSetupGate);
