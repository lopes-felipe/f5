import { CommandId, type OrchestrationCommand } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";
import { Effect, Schema } from "effect";

import { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { resolveDefaultWorktreePath } from "../git/worktreePaths.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  OrchestrationListenerCallbackError,
  OrchestrationProjectorDecodeError,
} from "../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  bootstrapStageTotal,
  bootstrapTurnStartDuration,
  increment,
  setupScriptLaunchTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import type { ProjectSetupScriptRunnerShape } from "../project/Services/ProjectSetupScriptRunner.ts";

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type DispatchThreadTurnStartCommand = Omit<ThreadTurnStartCommand, "bootstrap">;
type BootstrapTurnStartError = GitCommandError | OrchestrationDispatchError;
type BootstrapFailureStage =
  | "read-existing-thread"
  | "thread-create"
  | "worktree-create"
  | "thread-meta-update"
  | "final-turn-dispatch";
type BootstrapObservedStage = BootstrapFailureStage | "setup-script-launch" | "cleanup";
interface BootstrapCreatedWorktree {
  readonly cwd: string;
  readonly path: string;
}
interface BootstrapPreviousThreadMeta {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const stripBootstrapFromTurnStart = (
  command: ThreadTurnStartCommand,
): DispatchThreadTurnStartCommand => {
  const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
  return finalTurnStartCommand;
};

export interface BootstrapTurnStartDependencies {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
  readonly git: Pick<GitCoreShape, "createWorktree" | "removeWorktree">;
  readonly projectSetupScriptRunner: Pick<ProjectSetupScriptRunnerShape, "runForThread">;
  readonly worktreesDir?: string | undefined;
}

function isDefinitelyUncommittedDispatchError(error: OrchestrationDispatchError): boolean {
  return (
    Schema.is(OrchestrationCommandInvariantError)(error) ||
    Schema.is(OrchestrationCommandPreviouslyRejectedError)(error)
  );
}

function shouldAttemptRollback(
  stage: BootstrapFailureStage,
  error: BootstrapTurnStartError,
): boolean {
  if (Schema.is(GitCommandError)(error)) {
    return true;
  }

  switch (stage) {
    case "worktree-create":
      return true;
    case "thread-create":
    case "thread-meta-update":
    case "final-turn-dispatch":
      return isDefinitelyUncommittedDispatchError(error);
    case "read-existing-thread":
      return false;
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function cleanupFailureSuffix(step: string, cleanupError: BootstrapTurnStartError): string {
  return ` Cleanup failed during ${step}: ${cleanupError.message}`;
}

function withAppendedCleanupDetail(
  error: BootstrapTurnStartError,
  step: string,
  cleanupError: BootstrapTurnStartError,
): BootstrapTurnStartError {
  const suffix = cleanupFailureSuffix(step, cleanupError);
  if (Schema.is(GitCommandError)(error)) {
    return new GitCommandError({
      ...error,
      detail: `${error.detail}${suffix}`,
    });
  }
  if (Schema.is(PersistenceSqlError)(error)) {
    return new PersistenceSqlError({
      ...error,
      detail: `${error.detail}${suffix}`,
    });
  }
  if (Schema.is(PersistenceDecodeError)(error)) {
    return new PersistenceDecodeError({
      ...error,
      issue: `${error.issue}${suffix}`,
    });
  }
  if (Schema.is(OrchestrationCommandInvariantError)(error)) {
    return new OrchestrationCommandInvariantError({
      ...error,
      detail: `${error.detail}${suffix}`,
    });
  }
  if (Schema.is(OrchestrationCommandPreviouslyRejectedError)(error)) {
    return new OrchestrationCommandPreviouslyRejectedError({
      ...error,
      detail: `${error.detail}${suffix}`,
    });
  }
  if (Schema.is(OrchestrationProjectorDecodeError)(error)) {
    return new OrchestrationProjectorDecodeError({
      ...error,
      issue: `${error.issue}${suffix}`,
    });
  }
  if (Schema.is(OrchestrationListenerCallbackError)(error)) {
    return new OrchestrationListenerCallbackError({
      ...error,
      detail: `${error.detail}${suffix}`,
    });
  }
  const exhaustive: never = error;
  return exhaustive;
}

export const dispatchBootstrapTurnStart = Effect.fnUntraced(function* (
  input: BootstrapTurnStartDependencies & {
    readonly command: ThreadTurnStartCommand;
  },
) {
  const bootstrap = input.command.bootstrap;
  if (!bootstrap) {
    return yield* input.orchestrationEngine.dispatch(input.command);
  }

  const finalTurnStartCommand = stripBootstrapFromTurnStart(input.command);
  let createdThread = false;
  let createdWorktree: BootstrapCreatedWorktree | null = null;
  let previousThreadMeta: BootstrapPreviousThreadMeta | null = null;
  let appliedBootstrapThreadMeta: BootstrapPreviousThreadMeta | null = null;
  let mutatedExistingThreadMeta = false;
  let targetProjectId = bootstrap.createThread?.projectId;
  let targetProjectCwd = bootstrap.prepareWorktree?.projectCwd;
  let targetWorktreePath = bootstrap.createThread?.worktreePath ?? null;
  let failureStage: BootstrapFailureStage = "read-existing-thread";
  const cleanupWorktreePath = () => createdWorktree?.path ?? targetWorktreePath;
  const annotateBootstrapSpan = () =>
    Effect.annotateCurrentSpan({
      "thread.id": input.command.threadId,
      "command.id": input.command.commandId,
      ...(targetProjectId ? { "project.id": targetProjectId } : {}),
      ...(targetProjectCwd ? { "project.cwd": targetProjectCwd } : {}),
      ...(targetWorktreePath ? { "worktree.path": targetWorktreePath } : {}),
    });
  const observeBootstrapStage = <A, E>(
    stage: BootstrapObservedStage,
    effect: Effect.Effect<A, E>,
  ) =>
    effect.pipe(
      withMetrics({
        counter: bootstrapStageTotal,
        attributes: {
          stage,
        },
      }),
      Effect.withSpan(`bootstrap.stage.${stage}`),
    );

  const runCleanupStep = <A>(
    primaryError: BootstrapTurnStartError,
    step: string,
    effect: Effect.Effect<A, BootstrapTurnStartError>,
  ): Effect.Effect<
    | { readonly ok: true; readonly value: A }
    | { readonly ok: false; readonly error: BootstrapTurnStartError }
  > =>
    effect.pipe(
      Effect.matchEffect({
        onFailure: (cleanupError) =>
          Effect.logWarning("bootstrap turn start cleanup failed", {
            threadId: input.command.threadId,
            step,
            ...(cleanupWorktreePath() ? { worktreePath: cleanupWorktreePath() } : {}),
            detail: cleanupError.message,
          }).pipe(
            Effect.as({
              ok: false as const,
              error: withAppendedCleanupDetail(primaryError, step, cleanupError),
            }),
          ),
        onSuccess: (value) =>
          Effect.succeed({
            ok: true as const,
            value,
          }),
      }),
    );

  const rollbackBootstrapFailure = (
    error: BootstrapTurnStartError,
  ): Effect.Effect<never, BootstrapTurnStartError> =>
    observeBootstrapStage(
      "cleanup",
      Effect.gen(function* () {
        yield* annotateBootstrapSpan();
        if (!shouldAttemptRollback(failureStage, error)) {
          yield* Effect.logWarning("bootstrap turn start cleanup skipped after ambiguous failure", {
            threadId: input.command.threadId,
            stage: failureStage,
            ...(cleanupWorktreePath() ? { worktreePath: cleanupWorktreePath() } : {}),
            detail: error.message,
          });
          return yield* error;
        }

        if (createdThread) {
          const deleteThread = yield* runCleanupStep(
            error,
            "thread delete",
            input.orchestrationEngine.dispatch({
              type: "thread.delete",
              commandId: serverCommandId("bootstrap-thread-delete"),
              threadId: input.command.threadId,
            }),
          );
          if (!deleteThread.ok) {
            return yield* deleteThread.error;
          }
          if (createdWorktree) {
            const removeWorktree = yield* runCleanupStep(
              error,
              "worktree removal",
              input.git.removeWorktree({
                cwd: createdWorktree.cwd,
                path: createdWorktree.path,
                force: true,
              }),
            );
            if (!removeWorktree.ok) {
              return yield* removeWorktree.error;
            }
          }
          return yield* error;
        }

        if (mutatedExistingThreadMeta && previousThreadMeta) {
          const readModel = yield* input.orchestrationEngine.getReadModel();
          const currentThread = readModel.threads.find(
            (thread) => thread.id === input.command.threadId && thread.deletedAt === null,
          );
          const canRestorePreviousThreadMeta =
            currentThread !== undefined &&
            appliedBootstrapThreadMeta !== null &&
            currentThread.branch === appliedBootstrapThreadMeta.branch &&
            currentThread.worktreePath === appliedBootstrapThreadMeta.worktreePath;
          let restoredPreviousThreadMeta = false;

          if (canRestorePreviousThreadMeta) {
            const restoreThreadMeta = yield* runCleanupStep(
              error,
              "thread metadata restore",
              input.orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-restore"),
                threadId: input.command.threadId,
                branch: previousThreadMeta.branch,
                worktreePath: previousThreadMeta.worktreePath,
              }),
            );
            if (!restoreThreadMeta.ok) {
              return yield* restoreThreadMeta.error;
            }
            restoredPreviousThreadMeta = true;
          } else {
            yield* Effect.logWarning("bootstrap turn start skipped stale metadata restore", {
              threadId: input.command.threadId,
              ...(cleanupWorktreePath() ? { worktreePath: cleanupWorktreePath() } : {}),
            });
          }

          const canRemoveCreatedWorktree =
            createdWorktree !== null &&
            (restoredPreviousThreadMeta ||
              currentThread === undefined ||
              currentThread.worktreePath !== createdWorktree.path);
          if (canRemoveCreatedWorktree && createdWorktree) {
            const removeWorktree = yield* runCleanupStep(
              error,
              "worktree removal",
              input.git.removeWorktree({
                cwd: createdWorktree.cwd,
                path: createdWorktree.path,
                force: true,
              }),
            );
            if (!removeWorktree.ok) {
              return yield* removeWorktree.error;
            }
          }
          return yield* error;
        }

        if (createdWorktree) {
          const removeWorktree = yield* runCleanupStep(
            error,
            "worktree removal",
            input.git.removeWorktree({
              cwd: createdWorktree.cwd,
              path: createdWorktree.path,
              force: true,
            }),
          );
          if (!removeWorktree.ok) {
            return yield* removeWorktree.error;
          }
        }

        return yield* error;
      }),
    );

  if (!bootstrap.createThread) {
    failureStage = "read-existing-thread";
    const readModel = yield* observeBootstrapStage(
      "read-existing-thread",
      input.orchestrationEngine.getReadModel(),
    );
    const existingThread = readModel.threads.find(
      (thread) => thread.id === input.command.threadId && thread.deletedAt === null,
    );
    previousThreadMeta = existingThread
      ? {
          branch: existingThread.branch,
          worktreePath: existingThread.worktreePath,
        }
      : null;
  }

  const bootstrapProgram: Effect.Effect<{ sequence: number }, BootstrapTurnStartError> = Effect.gen(
    function* () {
      yield* annotateBootstrapSpan();
      yield* Effect.logInfo("bootstrap turn start received", {
        threadId: input.command.threadId,
        hasCreateThread: bootstrap.createThread !== undefined,
        hasPrepareWorktree: bootstrap.prepareWorktree !== undefined,
        suppliedWorktreePath: bootstrap.createThread?.worktreePath ?? null,
        suppliedBranch: bootstrap.createThread?.branch ?? null,
        prepareWorktreeBaseBranch: bootstrap.prepareWorktree?.baseBranch ?? null,
      });
      if (bootstrap.createThread) {
        failureStage = "thread-create";
        yield* observeBootstrapStage(
          "thread-create",
          input.orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: serverCommandId("bootstrap-thread-create"),
            threadId: input.command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            model: bootstrap.createThread.model,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            createdAt: bootstrap.createThread.createdAt,
          }),
        );
        createdThread = true;
      }

      // Idempotency guard: if the thread already has a valid worktreePath
      // (e.g., produced by a workflow path that creates the worktree up
      // front, or a stale client cache that re-sends `prepareWorktree`), skip
      // creating a second worktree. Otherwise the subsequent
      // `thread.meta.update` below would replace the existing `worktreePath`
      // and leave the earlier worktree orphaned on disk.
      let shouldPrepareWorktree = bootstrap.prepareWorktree !== undefined;
      if (shouldPrepareWorktree && bootstrap.prepareWorktree) {
        const preWorktreeReadModel = yield* input.orchestrationEngine.getReadModel();
        const existingThreadBeforeWorktree = preWorktreeReadModel.threads.find(
          (thread) =>
            thread.id === input.command.threadId &&
            thread.deletedAt === null &&
            typeof thread.worktreePath === "string" &&
            thread.worktreePath.length > 0,
        );
        if (existingThreadBeforeWorktree) {
          yield* Effect.logInfo(
            "bootstrap turn start skipping worktree creation; thread already has a worktree",
            {
              threadId: input.command.threadId,
              existingWorktreePath: existingThreadBeforeWorktree.worktreePath,
            },
          );
          targetWorktreePath = existingThreadBeforeWorktree.worktreePath;
          targetProjectCwd = bootstrap.prepareWorktree.projectCwd;
          yield* annotateBootstrapSpan();
          shouldPrepareWorktree = false;
        }
      }

      if (shouldPrepareWorktree && bootstrap.prepareWorktree) {
        failureStage = "worktree-create";
        const newBranch = bootstrap.prepareWorktree.branch ?? buildTemporaryWorktreeBranchName();
        const worktree = yield* observeBootstrapStage(
          "worktree-create",
          input.git.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            branch: bootstrap.prepareWorktree.baseBranch,
            newBranch,
            path:
              input.worktreesDir === undefined
                ? null
                : resolveDefaultWorktreePath({
                    worktreesDir: input.worktreesDir,
                    cwd: bootstrap.prepareWorktree.projectCwd,
                    branch: newBranch,
                  }),
          }),
        );
        targetProjectCwd = bootstrap.prepareWorktree.projectCwd;
        targetWorktreePath = worktree.worktree.path;
        createdWorktree = {
          cwd: bootstrap.prepareWorktree.projectCwd,
          path: worktree.worktree.path,
        };
        yield* annotateBootstrapSpan();

        failureStage = "thread-meta-update";
        yield* observeBootstrapStage(
          "thread-meta-update",
          input.orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: serverCommandId("bootstrap-thread-meta-update"),
            threadId: input.command.threadId,
            branch: worktree.worktree.branch,
            worktreePath: worktree.worktree.path,
          }),
        );
        appliedBootstrapThreadMeta = {
          branch: worktree.worktree.branch,
          worktreePath: worktree.worktree.path,
        };
        if (!createdThread) {
          mutatedExistingThreadMeta = true;
        }
      }

      if (bootstrap.runSetupScript && targetWorktreePath) {
        const setupScriptLaunch = input.projectSetupScriptRunner
          .runForThread({
            threadId: input.command.threadId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
            worktreePath: targetWorktreePath,
          })
          .pipe(
            Effect.tap((result) =>
              increment(setupScriptLaunchTotal, {
                outcome: result.status,
              }),
            ),
            Effect.tapError((error) =>
              increment(setupScriptLaunchTotal, {
                outcome: "failure",
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("bootstrap turn start failed to launch setup script", {
                    threadId: input.command.threadId,
                    worktreePath: targetWorktreePath,
                    detail: error instanceof Error ? error.message : "Unknown setup failure.",
                  }),
                ),
              ),
            ),
          );

        yield* observeBootstrapStage("setup-script-launch", setupScriptLaunch).pipe(
          Effect.catch(() => Effect.void),
        );
      }

      failureStage = "final-turn-dispatch";
      return yield* observeBootstrapStage(
        "final-turn-dispatch",
        input.orchestrationEngine.dispatch(finalTurnStartCommand),
      );
    },
  );

  return yield* bootstrapProgram.pipe(
    Effect.catch(rollbackBootstrapFailure),
    withMetrics({
      timer: bootstrapTurnStartDuration,
    }),
    Effect.withSpan("bootstrap.turn.start"),
  );
});
