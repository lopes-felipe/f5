import { toTurnSubmissionError } from "./TurnSubmissionError.ts";
import {
  CommandId,
  type NextTurnQueueSubmitInput,
  type TurnSubmissionResult,
  type ClientThreadTurnStartCommand,
  type OrchestrationCommand,
  type ThreadTurnStartCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, type FileSystem, type Path } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalRequestHash } from "./nextTurnQueue/canonicalRequestHash.ts";
import { NextTurnQueueIdempotencyConflictError } from "./nextTurnQueue/Errors.ts";
import type { NextTurnQueueStoreShape } from "./nextTurnQueue/Services/NextTurnQueueStore.ts";
import type { NextTurnQueueDispatcherShape } from "./nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSetupScriptRunnerShape } from "./project/Services/ProjectSetupScriptRunner.ts";
import type { WorktreeSetupShape } from "./project/Services/WorktreeSetup.ts";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { assertWorktreeReady } from "./project/worktreeReadiness.ts";
import { RouteRequestError, mapNextTurnQueueRouteError } from "./turnSubmissionErrors.ts";
type SubmissionSource = "human" | "automation";
type Runtime = {
  nextTurnQueueDispatcher: NextTurnQueueDispatcherShape;
  orchestrationEngine: OrchestrationEngineShape;
  projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
  worktreeSetup: WorktreeSetupShape;
};
type SubmissionEnvironment = FileSystem.FileSystem | Path.Path | SqlClient.SqlClient;
export interface TurnSubmissionDependencies {
  readonly nextTurnQueueStore: NextTurnQueueStoreShape;
  readonly awaitOrchestrationRuntimeForRoute: Effect.Effect<Runtime, RouteRequestError>;
  readonly git: GitCoreShape;
  readonly singleFlightBootstrap: <
    A extends TurnSubmissionResult | null,
    E extends { readonly message: string },
    R,
  >(
    submissionId: string,
    hash: string,
    run: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RouteRequestError, R>;
  readonly startWorktreeSetupSubmission: (input: {
    command: ClientThreadTurnStartCommand;
    submissionId: CommandId;
    requestHash: string;
    worktreeSetup: WorktreeSetupShape;
    submissionSource: SubmissionSource;
  }) => Effect.Effect<TurnSubmissionResult | null, RouteRequestError, SubmissionEnvironment>;
  readonly runBootstrapTurnStart: (input: {
    command: ClientThreadTurnStartCommand;
    orchestrationEngine: OrchestrationEngineShape;
    projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
    submissionSource: SubmissionSource;
  }) => Effect.Effect<{ sequence: number }, RouteRequestError, SubmissionEnvironment>;
  readonly normalizeDispatchCommand: (input: {
    command: ClientThreadTurnStartCommand;
    submissionSource: SubmissionSource;
  }) => Effect.Effect<OrchestrationCommand, RouteRequestError, SubmissionEnvironment>;
  readonly removePersistedTurnAttachments: (
    command: ThreadTurnStartCommand,
  ) => Effect.Effect<void, never, SubmissionEnvironment>;
  readonly releaseSentUploads: (
    threadId: ThreadId,
    attachments: ReadonlyArray<{ readonly type: string; readonly uploadId?: string }>,
  ) => Effect.Effect<void>;
}
/** Authoritative transport-independent bootstrap, normalization, ordering and receipt path. */
export function makeTurnSubmissionService(deps: TurnSubmissionDependencies) {
  const {
    nextTurnQueueStore,
    awaitOrchestrationRuntimeForRoute,
    git,
    singleFlightBootstrap,
    startWorktreeSetupSubmission,
    runBootstrapTurnStart,
    normalizeDispatchCommand,
    removePersistedTurnAttachments,
    releaseSentUploads,
  } = deps;
  return (
    body: NextTurnQueueSubmitInput,
    options: { readonly submissionSource: SubmissionSource },
  ) =>
    Effect.gen(function* () {
      const requestHash = canonicalRequestHash(body.command);
      const existingSubmission = yield* nextTurnQueueStore
        .getBySubmissionId(body.submissionId)
        .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      const {
        nextTurnQueueDispatcher,
        orchestrationEngine,
        projectSetupScriptRunner,
        worktreeSetup,
      } = yield* awaitOrchestrationRuntimeForRoute;
      if (
        body.command.bootstrap?.createThread !== undefined &&
        body.command.bootstrap.prepareWorktree !== undefined &&
        existingSubmission === null
      ) {
        // A new thread in a worktree: the thread and its queued first turn are
        // created now, and the worktree is prepared in the background while
        // the queue waits. The client gets `queued` right away.
        const started = yield* singleFlightBootstrap(
          body.submissionId,
          requestHash,
          startWorktreeSetupSubmission({
            command: body.command,
            submissionId: body.submissionId,
            requestHash,
            worktreeSetup,
            submissionSource: options.submissionSource,
          }),
        );
        if (started !== null) return started;
        // No usable repository or base: fall through to the project checkout.
      }
      if (body.command.bootstrap !== undefined && existingSubmission === null) {
        // A first send creates its thread here, so it cannot be admitted to
        // the thread's queue first. The submission is recorded once the turn
        // starts; a retry with the same id then replays the result above.
        // A retry that arrives while the first attempt still runs joins it
        // instead of racing it into a second thread.
        const fallbackCommand =
          body.command.bootstrap.prepareWorktree === undefined ||
          body.command.bootstrap.createThread === undefined
            ? body.command
            : {
                ...body.command,
                bootstrap: {
                  createThread: body.command.bootstrap.createThread,
                },
              };
        return yield* singleFlightBootstrap(
          body.submissionId,
          requestHash,
          Effect.gen(function* () {
            const dispatched = yield* runBootstrapTurnStart({
              command: fallbackCommand,
              orchestrationEngine,
              projectSetupScriptRunner,
              submissionSource: options.submissionSource,
            });
            yield* nextTurnQueueStore
              .recordStartedSubmission({
                submissionId: body.submissionId,
                threadId: body.command.threadId,
                requestHash,
                messageId: body.command.message.messageId,
                sequence: dispatched.sequence,
              })
              .pipe(Effect.mapError(mapNextTurnQueueRouteError));
            yield* releaseSentUploads(body.command.threadId, body.command.message.attachments);
            yield* nextTurnQueueDispatcher.notify(body.command.threadId);
            return {
              disposition: "started" as const,
              submissionId: body.submissionId,
              sequence: dispatched.sequence,
            };
          }),
        );
      }
      if (existingSubmission !== null) {
        if (existingSubmission.requestHash !== requestHash) {
          return yield* mapNextTurnQueueRouteError(
            new NextTurnQueueIdempotencyConflictError({
              message: "That send identifier was already used for different content.",
            }),
          );
        }
        if (existingSubmission.disposition === "started") {
          return {
            disposition: "started" as const,
            submissionId: body.submissionId,
            sequence: existingSubmission.resultSequence ?? 0,
          };
        }
        if (
          existingSubmission.disposition === "canceled" ||
          existingSubmission.disposition === "cleared" ||
          existingSubmission.disposition === "rejected"
        ) {
          return {
            disposition: existingSubmission.disposition,
            submissionId: body.submissionId,
            reasonCode: existingSubmission.reasonCode ?? existingSubmission.disposition,
          };
        }
        if (existingSubmission.itemId !== null) {
          if (
            existingSubmission.disposition === "pending" &&
            (body.intent === "auto" || body.intent === "steer")
          ) {
            return yield* nextTurnQueueDispatcher
              .submitAndSettle({
                threadId: existingSubmission.threadId,
                itemId: existingSubmission.itemId,
                submissionId: body.submissionId,
              })
              .pipe(Effect.mapError(mapNextTurnQueueRouteError));
          }
          return {
            disposition: "queued" as const,
            submissionId: body.submissionId,
            itemId: existingSubmission.itemId,
            snapshot: yield* nextTurnQueueDispatcher
              .getSnapshot(existingSubmission.threadId)
              .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
          };
        }
      }
      const workspaceModel = yield* orchestrationEngine.getReadModel();
      const workspaceThread = workspaceModel.threads.find(
        (thread) => thread.id === body.command.threadId,
      );
      if (workspaceThread?.worktreePath) {
        const project = workspaceModel.projects.find(
          (project) => project.id === workspaceThread.projectId && project.deletedAt === null,
        );
        if (!project)
          return yield* new RouteRequestError({
            message: "Workspace identity cannot be verified.",
          });
        yield* assertWorktreeReady(
          git,
          {
            projectCwd: project.workspaceRoot,
            worktreePath: workspaceThread.worktreePath,
            branch: workspaceThread.branch,
          },
          body.intent !== "steer",
          {
            allowBranchDrift:
              body.intent === "steer" && Boolean(workspaceThread.session?.activeTurnId),
          },
        ).pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }
      const command = yield* normalizeDispatchCommand({
        command: body.command,
        submissionSource: options.submissionSource,
      });
      if (command.type !== "thread.turn.start") {
        return yield* new RouteRequestError({
          message: "Only thread turn-start commands can be queued.",
        });
      }
      const itemId = CommandId.makeUnsafe(crypto.randomUUID());
      const steeringThread =
        body.intent === "steer"
          ? (yield* (yield* awaitOrchestrationRuntimeForRoute).orchestrationEngine.getReadModel()).threads.find(
              (thread) => thread.id === command.threadId,
            )
          : undefined;
      if (
        body.intent === "steer" &&
        (!steeringThread?.session?.activeTurnId ||
          steeringThread.runtimeMode !== command.runtimeMode ||
          steeringThread.interactionMode !== command.interactionMode)
      ) {
        yield* removePersistedTurnAttachments(command);
        return yield* new RouteRequestError({
          message:
            "Steering requires an active turn with the same Build/Plan and permission modes.",
        });
      }
      const queuedCommand = steeringThread?.session?.activeTurnId
        ? { ...command, expectedTurnId: steeringThread.session.activeTurnId }
        : command;
      const inserted = yield* nextTurnQueueStore
        .insertSubmission({
          submissionId: body.submissionId,
          requestHash,
          itemId,
          command: queuedCommand,
          submissionSource: options.submissionSource,
          supersedeUsageResume: body.intent !== "queue-tail",
          atHead: body.intent === "queue-head" || body.intent === "steer",
        })
        .pipe(
          Effect.tapError(() => removePersistedTurnAttachments(command)),
          Effect.mapError(mapNextTurnQueueRouteError),
        );
      if (inserted.kind === "replay") {
        // A concurrent request may have normalized a second, independently-id'd
        // attachment set before the winning ledger transaction committed.
        // The ledger result is authoritative; discard this request's ingress files.
        yield* removePersistedTurnAttachments(command);
        const replayItemId = inserted.submission.itemId ?? itemId;
        if (body.intent === "auto" || body.intent === "steer") {
          return yield* nextTurnQueueDispatcher
            .submitAndSettle({
              threadId: inserted.submission.threadId,
              itemId: replayItemId,
              submissionId: body.submissionId,
            })
            .pipe(Effect.mapError(mapNextTurnQueueRouteError));
        }
        return {
          disposition: "queued" as const,
          submissionId: body.submissionId,
          itemId: replayItemId,
          snapshot: yield* nextTurnQueueDispatcher
            .getSnapshot(inserted.submission.threadId)
            .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
        };
      }
      const result =
        body.intent === "auto" || body.intent === "steer"
          ? yield* nextTurnQueueDispatcher
              .submitAndSettle({
                threadId: command.threadId,
                itemId,
                submissionId: body.submissionId,
              })
              .pipe(Effect.mapError(mapNextTurnQueueRouteError))
          : {
              disposition: "queued" as const,
              submissionId: body.submissionId,
              itemId,
              snapshot: yield* nextTurnQueueDispatcher
                .getSnapshot(command.threadId)
                .pipe(Effect.mapError(mapNextTurnQueueRouteError)),
            };
      yield* nextTurnQueueStore
        .settleSubmission({ submissionId: body.submissionId, result })
        .pipe(Effect.mapError(mapNextTurnQueueRouteError));
      // The queue item now owns its attachment copies; retries replay by submissionId.
      yield* releaseSentUploads(command.threadId, body.command.message.attachments);
      yield* nextTurnQueueDispatcher.notify(command.threadId);
      return result;
    }).pipe(Effect.mapError(toTurnSubmissionError));
}
