import {
  CommandId,
  MessageId,
  type NextTurnQueueSnapshot,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";
import { holdsAutomaticResume } from "@t3tools/shared/pendingUserInputs";
import { Cause, Data, Effect, Layer, Option, Semaphore, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AgentControlPauseService } from "../mcp/agentControlPause.ts";
import { canonicalRequestHash } from "../nextTurnQueue/canonicalRequestHash.ts";
import { NextTurnQueueDispatcher } from "../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  NATIVE_CONTINUATION_ADMISSION_MS,
  MAX_CONCURRENT_NATIVE_CONTINUATIONS,
} from "./continuationPolicy.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "./ProviderContinuationRequests.ts";

export class ProviderContinuationError extends Data.TaggedError("ProviderContinuationError")<{
  readonly detail: string;
}> {}
interface ContinuationWorkerDependencies {
  readonly enqueue: (
    request: ProviderContinuationRequest,
  ) => Effect.Effect<"queued" | "wait" | "rejected", ProviderContinuationError>;
  readonly snapshot: (
    request: ProviderContinuationRequest,
  ) => Effect.Effect<
    Pick<NextTurnQueueSnapshot, "paused" | "blockedKind" | "items">,
    ProviderContinuationError
  >;
  readonly notify: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  /** Removes only this continuation's still-queued item, never a sending/user item. */
  readonly discardQueued: (
    request: ProviderContinuationRequest,
  ) => Effect.Effect<void, ProviderContinuationError>;
  readonly now: () => number;
  readonly delay: Effect.Effect<void>;
}

/** Native output already exists. Rejection retires it; retry must never manufacture a new prompt. */
export const processProviderContinuation = (
  request: ProviderContinuationRequest,
  deps: ContinuationWorkerDependencies,
) =>
  Effect.gen(function* () {
    let adopted = false;
    const deadline = request.createdAt + NATIVE_CONTINUATION_ADMISSION_MS;
    return yield* Effect.gen(function* () {
      if (deps.now() >= deadline || (yield* request.status) !== "pending") return false;
      let queued = false;
      while (deps.now() < deadline && (yield* request.status) === "pending") {
        const admission = yield* request.dispatchIfCurrent(deps.enqueue(request));
        if (Option.isNone(admission) || admission.value === "rejected") return false;
        if (admission.value === "queued") {
          queued = true;
          break;
        }
        yield* deps.delay;
      }
      if (!queued) return false;
      yield* deps.notify(request);
      while (deps.now() < deadline) {
        const status = yield* request.status;
        if (status === "adopted") {
          adopted = true;
          return true;
        }
        if (status === "closed") return false;
        const snapshot = yield* deps.snapshot(request);
        const own = snapshot.items.find(
          (item) => item.command.continuationRequestId === request.requestId,
        );
        if (!own || snapshot.paused || snapshot.blockedKind === "error" || own.status === "failed")
          return false;
        yield* deps.delay;
      }
      return false;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          adopted
            ? Effect.void
            : request.clearIfCurrent.pipe(
                Effect.andThen(
                  deps
                    .discardQueued(request)
                    .pipe(
                      Effect.catch(() =>
                        Effect.logWarning(
                          "Could not remove an obsolete native continuation queue item.",
                          { threadId: request.threadId },
                        ),
                      ),
                    ),
                ),
                Effect.andThen(deps.notify(request)),
              ),
        ),
      ),
    );
  });

export class ProviderContinuationWorker extends ServiceMap.Service<
  ProviderContinuationWorker,
  { readonly start: Effect.Effect<void, never, import("effect").Scope.Scope> }
>()("t3/provider/ProviderContinuationWorker") {}
export const ProviderContinuationWorkerLive = Layer.effect(
  ProviderContinuationWorker,
  Effect.gen(function* () {
    const requestsOption = yield* Effect.serviceOption(ProviderContinuationRequests);
    if (Option.isNone(requestsOption)) return { start: Effect.void };
    const requests = requestsOption.value;
    const engine = yield* OrchestrationEngineService;
    const queue = yield* NextTurnQueueStore;
    const dispatcher = yield* NextTurnQueueDispatcher;
    const settings = yield* ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const pause = yield* Effect.serviceOption(AgentControlPauseService);
    const concurrency = yield* Semaphore.make(MAX_CONCURRENT_NATIVE_CONTINUATIONS);
    const deps: ContinuationWorkerDependencies = {
      enqueue: (request) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const model = yield* engine.getReadModel();
              const thread = model.threads.find((thread) => thread.id === request.threadId);
              const project =
                thread &&
                model.projects.find(
                  (project) => project.id === thread.projectId && project.deletedAt === null,
                );
              if (
                !thread ||
                !project ||
                thread.archivedAt ||
                thread.settledAt ||
                thread.session?.providerInstanceId !== request.providerInstanceId ||
                thread.session.providerName !== "pi" ||
                thread.runtimeMode !== request.runtimeMode ||
                (request.model !== undefined && thread.model !== request.model) ||
                thread.pendingUserInputs?.some(holdsAutomaticResume) ||
                (Option.isSome(pause) && pause.value.has(thread.id))
              )
                return "rejected" as const;
              if (
                !resolveProjectProviderInstanceEnabled(
                  yield* settings.getSettings,
                  thread.projectId,
                  request.providerInstanceId,
                )
              )
                return "rejected" as const;
              const state = yield* queue.listByThread(thread.id);
              if (state.state.paused || state.state.worktreeBlockToken || state.quarantinedCount)
                return "rejected" as const;
              if (state.items.length) {
                const previous = state.items[0];
                return state.items.length === 1 &&
                  previous?.status === "dispatching" &&
                  previous.command.commandId === request.previousCommandId
                  ? ("wait" as const)
                  : ("rejected" as const);
              }
              // Runtime events can trail Pi's settlement. Keep the owned wake
              // bounded while the canonical F5 turn catches up; do not drop it.
              if (thread.latestTurn?.turnId !== request.previousTurnId) return "wait" as const;
              if (thread.latestTurn.state === "interrupted" || thread.latestTurn.state === "error")
                return "rejected" as const;
              const id = CommandId.make(request.requestId);
              const command: ThreadTurnStartCommand = {
                type: "thread.turn.start",
                commandId: id,
                threadId: thread.id,
                message: {
                  messageId: MessageId.make(request.requestId),
                  role: "user",
                  text: "Continue the work already in progress.",
                  attachments: [],
                },
                model: thread.model,
                ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                ...(thread.session.workflowExecutionProfile
                  ? { workflowExecutionProfile: thread.session.workflowExecutionProfile }
                  : {}),
                presentation: "continuation",
                continuationRequestId: request.requestId,
                createdAt: new Date().toISOString(),
              };
              const inserted = yield* queue.insertSubmission({
                command,
                submissionSource: "automation",
                submissionId: id,
                itemId: id,
                requestHash: canonicalRequestHash(command),
                atHead: false,
              });
              return inserted.kind === "created" ? ("queued" as const) : ("rejected" as const);
            }),
          )
          .pipe(
            Effect.mapError(
              () =>
                new ProviderContinuationError({ detail: "Native continuation enqueue failed." }),
            ),
          ),
      snapshot: (request) =>
        dispatcher.getSnapshot(request.threadId).pipe(
          Effect.mapError(
            () =>
              new ProviderContinuationError({
                detail: "Native continuation queue state could not be read.",
              }),
          ),
        ),
      notify: (request) => dispatcher.notify(request.threadId),
      discardQueued: (request) =>
        Effect.gen(function* () {
          const item = yield* queue.getItem(CommandId.make(request.requestId));
          if (item?.status === "queued" && item.command.continuationRequestId === request.requestId)
            yield* queue
              .softDelete({ itemId: item.itemId, expectedUpdatedAt: item.updatedAt })
              .pipe(Effect.ignore);
        }).pipe(
          Effect.mapError(
            () =>
              new ProviderContinuationError({
                detail: "Obsolete continuation could not be removed.",
              }),
          ),
        ),
      now: Date.now,
      delay: Effect.sleep("25 millis"),
    };
    return {
      start: Effect.forever(
        requests.take.pipe(
          Effect.flatMap((request) =>
            concurrency
              .withPermit(
                processProviderContinuation(request, deps).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : Effect.logWarning("Native provider continuation could not be admitted.", {
                          threadId: request.threadId,
                        }),
                  ),
                  Effect.ensuring(requests.settle(request)),
                ),
              )
              .pipe(Effect.forkScoped),
          ),
          Effect.asVoid,
        ),
      ).pipe(Effect.forkScoped, Effect.asVoid),
    };
  }),
);
