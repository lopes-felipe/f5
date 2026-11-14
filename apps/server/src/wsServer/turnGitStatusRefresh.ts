import { Effect, Scope } from "effect";
import type { GitStatusResult, ThreadId } from "@t3tools/contracts";

/** Scoped background reads: one in flight and at most one dirty rerun per cwd. */
export function makeTurnGitStatusRefresh(options: {
  scope: Scope.Scope;
  resolveCwd: (threadId: ThreadId) => Effect.Effect<string | null | undefined>;
  read: (cwd: string) => Effect.Effect<GitStatusResult | null>;
  publish: (cwd: string, status: GitStatusResult) => Effect.Effect<void>;
}) {
  const pending = new Map<string, { dirty: boolean }>();
  const refresh = (cwd: string) =>
    Effect.suspend(() => {
      const existing = pending.get(cwd);
      if (existing) {
        existing.dirty = true;
        return Effect.void;
      }
      const entry = { dirty: false };
      pending.set(cwd, entry);
      return Effect.gen(function* () {
        do {
          entry.dirty = false;
          const status = yield* options.read(cwd);
          // A newer completion supersedes a read captured before it.
          if (status && !entry.dirty) yield* options.publish(cwd, status);
        } while (entry.dirty);
      }).pipe(
        Effect.ensuring(Effect.sync(() => pending.delete(cwd))),
        Effect.forkIn(options.scope),
        Effect.asVoid,
      );
    });
  return (threadId: ThreadId) =>
    Effect.gen(function* () {
      const cwd = yield* options.resolveCwd(threadId);
      if (cwd) yield* refresh(cwd);
    }).pipe(Effect.forkIn(options.scope), Effect.asVoid);
}
