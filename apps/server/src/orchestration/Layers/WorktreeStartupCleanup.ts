import { assertWorktreeReady } from "../../project/worktreeReadiness.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { Option } from "effect";
import { GitCore } from "../../git/Services/GitCore.ts";
/** Preserve missing workspaces; only deleted projects lose their workspace reference. */
import { CommandId } from "@t3tools/contracts";
import { Cause, Effect, FileSystem } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export const cleanupStaleWorktrees = Effect.fn("server.startup.worktree.cleanup")(function* (
  orchestrationEngine: OrchestrationEngineShape,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitCore;
  const queue = yield* Effect.serviceOption(NextTurnQueueStore);
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
      if (Option.isSome(queue))
        yield* queue.value
          .setPaused({
            threadId: thread.id,
            paused: true,
            reasonCode: "worktree_missing",
            detail: "The recorded workspace could not be inspected. Recover it before sending.",
          })
          .pipe(Effect.ignore);
      continue;
    }

    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (!project || project.deletedAt === null) {
      const readiness = project
        ? yield* assertWorktreeReady(
            git,
            { projectCwd: project.workspaceRoot, worktreePath, branch: thread.branch },
            true,
          ).pipe(Effect.exit)
        : null;
      if (readiness === null || readiness._tag === "Failure") {
        if (Option.isSome(queue))
          yield* queue.value
            .setPaused({
              threadId: thread.id,
              paused: true,
              reasonCode: "worktree_missing",
              detail: "The recorded worktree requires recovery.",
            })
            .pipe(Effect.ignore);
      }
      if (!probe.exists || readiness === null || readiness._tag === "Failure")
        yield* Effect.logInfo("preserving recorded worktree for recovery", {
          threadId: thread.id,
          worktreePath,
        });
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
