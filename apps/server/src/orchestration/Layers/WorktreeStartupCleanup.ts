/**
 * WorktreeStartupCleanup - Clear stale `worktreePath` projections at startup.
 *
 * Threads persist a `worktreePath` that the UI repeatedly polls for git
 * status. When a user removes that worktree directory outside of the app
 * (e.g. `rm -rf`), the projection keeps pointing at a missing path and every
 * polled git command spams the logs with ENOENT failures.
 *
 * This helper walks the read model once after the orchestration runtime is
 * ready, verifies each thread's `worktreePath` exists on disk, and dispatches
 * a `thread.meta.update` with `worktreePath: null` for any that no longer do.
 * Running the cleanup through the orchestration engine (rather than mutating
 * the projection row directly) keeps the event log as the source of truth so
 * the projection remains reproducible via replay.
 *
 * @module WorktreeStartupCleanup
 */
import { CommandId } from "@t3tools/contracts";
import { Cause, Effect, FileSystem } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

/**
 * Walk all live threads and clear any `worktreePath` whose directory is gone.
 *
 * Safe to run once per process startup after the orchestration runtime is
 * ready. Errors dispatching individual updates are logged and swallowed so a
 * single failure does not abort the sweep.
 */
export const cleanupStaleWorktrees = Effect.fn("server.startup.worktree.cleanup")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const readModel = yield* orchestrationEngine.getReadModel();

  const candidates = readModel.threads.filter(
    (thread) => thread.deletedAt === null && thread.worktreePath !== null,
  );

  if (candidates.length === 0) {
    return;
  }

  let clearedCount = 0;
  for (const thread of candidates) {
    const worktreePath = thread.worktreePath;
    if (worktreePath === null) {
      continue;
    }

    // Distinguish "directory definitely missing" from "FS check errored". A
    // transient failure (EIO, EACCES, not-yet-mounted network volume, timeout)
    // must NOT trigger a durable `thread.meta.update` that nulls the
    // projection — that projection is event-sourced, so the clear would
    // survive the filesystem recovering. Skip this thread on error and let a
    // future startup retry the decision.
    const probe = yield* fileSystem.exists(worktreePath).pipe(
      Effect.match({
        onSuccess: (exists) => ({ status: "ok" as const, exists }),
        onFailure: (cause) => ({ status: "errored" as const, cause }),
      }),
    );
    if (probe.status === "errored") {
      yield* Effect.logWarning("skipping stale worktree check; filesystem probe failed", {
        threadId: thread.id,
        worktreePath,
        cause: probe.cause instanceof Error ? probe.cause.message : String(probe.cause),
      });
      continue;
    }
    if (probe.exists) {
      continue;
    }

    yield* Effect.logInfo("clearing stale worktree projection", {
      threadId: thread.id,
      worktreePath,
    });

    yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(`server:worktree-startup-cleanup:${crypto.randomUUID()}`),
        threadId: thread.id,
        worktreePath: null,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            clearedCount += 1;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to clear stale worktree projection", {
            threadId: thread.id,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  }

  if (clearedCount > 0) {
    yield* Effect.logInfo("stale worktree cleanup complete", {
      clearedCount,
      scannedCount: candidates.length,
    });
  }
});
