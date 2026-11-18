import { timeOrderedUuid } from "@t3tools/shared/ids";
import { estimateModelContextWindowTokens } from "@t3tools/shared/model";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import { hasNativeOperationReservation } from "../../provider/nativeOperations.ts";
import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadCompaction,
  ThreadId,
} from "@t3tools/contracts";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { Cause, Clock, Deferred, Effect, Layer, Option, Scope, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { resolveBindingInstanceId } from "../../provider/bindingIdentity.ts";
import { readPersistedSessionGeneration } from "../../provider/sessionCapabilities.ts";
import { estimateProviderInstructionTokens } from "../../provider/contextTokenEstimate.ts";
import {
  CLAUDE_ONE_OFF_PROMPT_TIMEOUT_MS,
  CODEX_ONE_OFF_PROMPT_TIMEOUT_MS,
} from "../../provider/oneOffPromptTimeouts.ts";
import { buildThreadInstructionContext } from "../threadSessionInstructions.ts";
import { buildThreadCompactionTranscript } from "../compactionService.ts";
import {
  formatCompactSummary,
  getCompactPrompt,
  getPartialCompactPrompt,
} from "../compactionPrompts.ts";
import { resolveOneOffPromptRoute } from "../oneOffPromptRouting.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  CompactionService,
  type CompactionServiceShape,
  type WorkflowCompactionRequest,
  type WorkflowCompactionOutcome,
} from "../Services/CompactionService.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";

interface WorkflowCompactionJob {
  readonly request: WorkflowCompactionRequest;
  readonly queueDeadline: number;
  readonly started: Deferred.Deferred<void>;
  readonly outcome: Deferred.Deferred<WorkflowCompactionOutcome>;
  cancelled: boolean;
  running: boolean;
}

const QUEUE_TIMEOUT_MS = 240_000;
const EXPIRED = {
  kind: "expired",
  detail: "The summary did not start within four minutes.",
} as const;
const SHUTDOWN = {
  kind: "shutdown",
  detail: "Context recovery was interrupted by shutdown.",
} as const;

type ThreadCompactRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.compact-requested" }
>;

const compactionCommandId = (tag: string) =>
  CommandId.makeUnsafe(`compaction:${tag}:${timeOrderedUuid()}`);

function laterIsoString(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function threadHasChangedSince(
  baselineLastInteractionAt: string,
  currentLastInteractionAt: string,
): boolean {
  return currentLastInteractionAt.localeCompare(baselineLastInteractionAt) > 0;
}

function threadSessionIsBusy(input: {
  readonly status: string;
  readonly activeTurnId: string | null;
}): boolean {
  return input.status === "starting" || input.status === "running" || input.activeTurnId !== null;
}

const make = Effect.gen(function* () {
  const sources = yield* makeShutdownSourceScope("conversation-compaction-sources");
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const directory = yield* Effect.serviceOption(ProviderSessionDirectory);
  const deliveries = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  const pendingThreadIds = new Set<ThreadId>();
  const workflowJobs = new Set<WorkflowCompactionJob>();

  const runSummary = (input: {
    readonly thread: OrchestrationThread;
    readonly transcript: ReturnType<typeof buildThreadCompactionTranscript>;
    readonly direction: ThreadCompaction["direction"];
    readonly route: ReturnType<typeof resolveOneOffPromptRoute>;
    readonly cwd?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly recovery?: boolean;
  }): Effect.Effect<string, Error> => {
    const promptBody =
      input.direction === null ? getCompactPrompt() : getPartialCompactPrompt(input.direction);
    const prompt = `${promptBody}\n\n## Conversation Context\n${input.transcript.transcript}`;
    if (
      input.recovery &&
      prompt.length > estimateModelContextWindowTokens(input.route.model, input.route.provider) * 2
    ) {
      return Effect.fail(
        new Error(
          "The conversation is too large for the summary model. Compact a smaller range or select a model with a larger context window before retrying.",
        ),
      );
    }
    return providerService
      .runOneOffPrompt({
        threadId: input.thread.id,
        provider: input.route.provider,
        model: input.route.model,
        prompt,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        runtimeMode: input.recovery ? "approval-required" : input.thread.runtimeMode,
        ...(input.recovery && input.route.provider === "codex" ? { providerOptions: {} } : {}),
      })
      .pipe(Effect.map((result) => formatCompactSummary(result.text)));
  };

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: compactionCommandId("activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(timeOrderedUuid()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const processEvent = (event: ThreadCompactRequestedEvent) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === event.payload.threadId && entry.deletedAt === null,
      );
      if (!thread) {
        return;
      }
      if (
        thread.compaction &&
        thread.lastInteractionAt.localeCompare(thread.compaction.createdAt) <= 0
      ) {
        return;
      }

      const oneOffRoute = resolveOneOffPromptRoute({
        model: thread.model,
        sessionProviderName: thread.session?.providerName ?? null,
      });
      if (
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        thread.session.activeTurnId !== undefined
      ) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "Interrupt the current turn before compacting the conversation.",
          },
          createdAt: event.occurredAt,
        });
        return;
      }

      // Partial ranges retain F5's summary path. A whole native compaction
      // keeps its cursor and never becomes a prior-work summary on resume.
      if (event.payload.direction === null && providerService.nativeOperations?.executeWithApply) {
        const capabilities = yield* providerService
          .getSessionCapabilities(thread.id)
          .pipe(Effect.orElseSucceed(() => null));
        if (
          capabilities?.actions.some(
            (action) => action.action === "nativeCompaction" && action.supported,
          )
        ) {
          const completed = yield* providerService.nativeOperations
            .executeWithApply(
              {
                threadId: thread.id,
                operationId: `compact:${event.eventId}`,
                generation: capabilities.generation,
                command: { kind: "compact" },
              },
              () => {
                const at = new Date().toISOString();
                return orchestrationEngine
                  .dispatch({
                    type: "thread.compacted.record",
                    commandId: compactionCommandId("native-record"),
                    threadId: thread.id,
                    compaction: {
                      kind: "native",
                      summary: "Native context compacted",
                      trigger: event.payload.trigger,
                      estimatedTokens: 0,
                      modelContextWindowTokens: thread.modelContextWindowTokens ?? 0,
                      createdAt: at,
                      direction: null,
                      pivotMessageId: null,
                      fromTurnCount: null,
                      toTurnCount: null,
                    },
                    createdAt: at,
                  })
                  .pipe(
                    Effect.asVoid,
                    Effect.mapError(
                      (cause) =>
                        new ProviderValidationError({
                          operation: "nativeCompaction.record",
                          issue: cause.message,
                        }),
                    ),
                  );
              },
            )
            .pipe(
              Effect.catch((error) =>
                appendActivity({
                  threadId: thread.id,
                  tone: "error",
                  kind: "thread.compaction.failed",
                  summary: "Native compaction could not start",
                  payload: { detail: error.message },
                  createdAt: event.occurredAt,
                }).pipe(Effect.as(null)),
              ),
            );
          if (completed)
            yield* appendActivity({
              threadId: thread.id,
              tone: completed.state === "completed" ? "info" : "error",
              kind: `thread.compaction.${completed.state}`,
              summary:
                completed.state === "completed"
                  ? "Conversation compacted natively"
                  : "Native compaction has not completed",
              payload: {
                operationId: completed.operationId,
                state: completed.state,
                ...(completed.error ? { detail: completed.error } : {}),
              },
              createdAt: event.occurredAt,
            });
          // A refused admission or proven pre-send failure can use F5 summaries.
          // Never run a fallback while another native mutation may still be active.
          const records = yield* providerService.nativeOperations
            .list(thread.id)
            .pipe(Effect.orElseSucceed(() => null));
          const record = records?.find((entry) => entry.operationId === `compact:${event.eventId}`);
          if (
            hasNativeOperationReservation(thread.id) ||
            records === null ||
            (record && record.state !== "failed") ||
            (completed && completed.state !== "failed")
          )
            return;
        }
      }

      const transcript = buildThreadCompactionTranscript({
        thread,
        direction: event.payload.direction,
        pivotMessageId: event.payload.pivotMessageId,
      });
      if (transcript.transcript.trim().length === 0) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "Not enough conversation history was available to build a compaction summary.",
          },
          createdAt: event.occurredAt,
        });
        return;
      }

      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: readModel.projects,
      });
      const completedAt = new Date().toISOString();
      const baselineLastInteractionAt = laterIsoString(thread.lastInteractionAt, event.occurredAt);

      const summaryResult = yield* runSummary({
        thread,
        route: oneOffRoute,
        cwd,
        transcript,
        direction: event.payload.direction,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (result) => ({ ok: true as const, result }),
        }),
      );

      if (!summaryResult.ok) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: summaryResult.error.message,
          },
          createdAt: completedAt,
        });
        return;
      }

      const formattedSummary = summaryResult.result;
      if (formattedSummary.length === 0) {
        yield* appendActivity({
          threadId: thread.id,
          tone: "error",
          kind: "thread.compaction.failed",
          summary: "Conversation compaction failed",
          payload: {
            detail: "The provider returned an empty compaction summary.",
          },
          createdAt: completedAt,
        });
        return;
      }

      const latestReadModel = yield* orchestrationEngine.getReadModel();
      const latestThread = latestReadModel.threads.find(
        (entry) => entry.id === event.payload.threadId && entry.deletedAt === null,
      );
      if (!latestThread) {
        return;
      }
      if (
        threadHasChangedSince(baselineLastInteractionAt, latestThread.lastInteractionAt) ||
        (latestThread.session &&
          threadSessionIsBusy({
            status: latestThread.session.status,
            activeTurnId: latestThread.session.activeTurnId,
          }))
      ) {
        yield* appendActivity({
          threadId: latestThread.id,
          tone: "error",
          kind: "thread.compaction.aborted",
          summary: "Conversation compaction aborted",
          payload: {
            detail:
              "The thread changed while compaction was running. Start compaction again from the latest conversation state.",
          },
          createdAt: completedAt,
        });
        return;
      }

      if (latestThread.session && latestThread.session.status !== "stopped") {
        const stopSessionResult = yield* providerService
          .stopSession({ threadId: latestThread.id })
          .pipe(
            Effect.match({
              onFailure: (error) => error,
              onSuccess: () => null,
            }),
          );
        if (stopSessionResult !== null) {
          yield* appendActivity({
            threadId: latestThread.id,
            tone: "error",
            kind: "thread.compaction.stop-session-failed",
            summary: "Conversation compaction failed",
            payload: {
              detail: stopSessionResult.message,
            },
            createdAt: completedAt,
          });
          return;
        }
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.compacted.record",
        commandId: compactionCommandId("record"),
        threadId: latestThread.id,
        compaction: {
          summary: formattedSummary,
          trigger: event.payload.trigger,
          estimatedTokens: transcript.estimatedTokens,
          modelContextWindowTokens: transcript.modelContextWindowTokens,
          createdAt: completedAt,
          direction: event.payload.direction,
          pivotMessageId: event.payload.pivotMessageId,
          fromTurnCount: transcript.fromTurnCount,
          toTurnCount: transcript.toTurnCount,
        },
        createdAt: completedAt,
      });

      yield* appendActivity({
        threadId: latestThread.id,
        tone: "info",
        kind: "thread.compaction.completed",
        summary: "Conversation compacted",
        payload: {
          trigger: event.payload.trigger,
          estimatedTokens: transcript.estimatedTokens,
          modelContextWindowTokens: transcript.modelContextWindowTokens,
        },
        createdAt: completedAt,
      });
    });

  const processWorkflowJob = (
    job: WorkflowCompactionJob,
  ): Effect.Effect<WorkflowCompactionOutcome, Error> =>
    Effect.gen(function* () {
      const { request } = job;
      const { threadId } = request;
      if (job.cancelled || (yield* Clock.currentTimeMillis) >= job.queueDeadline) return EXPIRED;
      const stoppedSession = providerService.withStoppedSessionForCompaction;
      if (directory._tag === "None" || deliveries._tag === "None" || !stoppedSession) {
        return { kind: "failed", detail: "Fresh provider context recovery is unavailable." };
      }
      const readContext = Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const thread = snapshot.threads.find(
          (entry) => entry.id === threadId && !entry.deletedAt && !entry.archivedAt,
        );
        const project = snapshot.projects.find(
          (entry) => entry.id === thread?.projectId && !entry.deletedAt,
        );
        const workflow = snapshot.planningWorkflows.find(
          (entry) => entry.id === request.workflowId,
        );
        const implementation = workflow?.implementation;
        if (
          job.cancelled ||
          !thread ||
          !project ||
          !workflow ||
          workflow.archivedAt ||
          workflow.deletedAt ||
          implementation?.status !== "applying_reviews" ||
          implementation.revisionAttempt !== request.attempt ||
          implementation.revisionDispatchCommandId !== request.dispatchCommandId ||
          implementation.revisionCompaction?.requestId !== request.requestId ||
          implementation.threadId !== threadId ||
          (workflow.maxCostUsd != null && workflow.totalCostUsd >= workflow.maxCostUsd)
        ) {
          return yield* Effect.fail(
            new Error(
              "The workflow, cost limit, or implementation thread changed during compaction.",
            ),
          );
        }
        return {
          thread,
          project,
          cwd: resolveThreadWorkspaceCwd({ thread, projects: snapshot.projects }),
        };
      });

      const start = yield* readContext;
      const binding = Option.getOrNull(yield* directory.value.getBinding(threadId));
      const capturedBinding = binding
        ? {
            provider: binding.provider,
            instanceId: resolveBindingInstanceId(binding),
            generation: readPersistedSessionGeneration(binding.runtimePayload),
          }
        : null;
      const deliveryRepository = deliveries.value;
      const checkIdle = (thread: OrchestrationThread) =>
        Effect.gen(function* () {
          const delivery = yield* deliveryRepository.getUnresolvedByThread(threadId);
          if (
            hasNativeOperationReservation(threadId) ||
            (thread.session && threadSessionIsBusy(thread.session)) ||
            thread.latestTurn?.state === "running" ||
            (delivery &&
              !(
                delivery.commandId === request.dispatchCommandId &&
                delivery.state === "rejected" &&
                delivery.certainty === "not_sent"
              ))
          ) {
            return yield* Effect.fail(
              new Error(
                "The implementation thread has an active turn or competing provider delivery.",
              ),
            );
          }
        });
      const idle = yield* checkIdle(start.thread).pipe(Effect.result);
      if (idle._tag === "Failure") return { kind: "busy", detail: idle.failure.message };

      const route = resolveOneOffPromptRoute({
        model: start.thread.model,
        sessionProviderName:
          capturedBinding?.provider ?? start.thread.session?.providerName ?? null,
      });
      if (
        capturedBinding &&
        (capturedBinding.provider !== request.targetSlot.provider ||
          (start.thread.modelSelection &&
            start.thread.modelSelection.instanceId !== capturedBinding.instanceId))
      ) {
        return {
          kind: "skipped",
          detail: "The implementation thread is bound to a different provider instance.",
        };
      }
      const timeoutMs =
        route.provider === "claudeAgent"
          ? CLAUDE_ONE_OFF_PROMPT_TIMEOUT_MS
          : CODEX_ONE_OFF_PROMPT_TIMEOUT_MS;
      const transcript = buildThreadCompactionTranscript({
        thread: start.thread,
        direction: null,
        pivotMessageId: null,
      });
      if (!transcript.transcript.trim()) {
        return { kind: "skipped", detail: "There is no conversation history to summarize." };
      }
      if (job.cancelled || (yield* Clock.currentTimeMillis) >= job.queueDeadline) return EXPIRED;
      job.running = true;
      yield* Deferred.succeed(job.started, undefined);
      if (job.cancelled) return EXPIRED;
      const summary = yield* runSummary({
        thread: start.thread,
        route,
        cwd: start.cwd,
        transcript,
        direction: null,
        timeoutMs,
        recovery: true,
      }).pipe(Effect.timeout(timeoutMs + 30_000));
      if (!summary)
        return { kind: "failed", detail: "The provider returned an empty compaction summary." };

      const validate = Effect.gen(function* () {
        const current = yield* readContext;
        const { thread } = current;
        if (
          thread.lastInteractionAt !== start.thread.lastInteractionAt ||
          thread.worktreePath !== start.thread.worktreePath ||
          thread.branch !== start.thread.branch ||
          thread.model !== start.thread.model ||
          thread.modelSelection?.instanceId !== start.thread.modelSelection?.instanceId ||
          thread.interactionMode !== start.thread.interactionMode ||
          thread.runtimeMode !== start.thread.runtimeMode ||
          thread.compaction?.createdAt !== start.thread.compaction?.createdAt ||
          thread.compaction?.freshSessionRecordId !==
            start.thread.compaction?.freshSessionRecordId ||
          thread.compaction?.summary !== start.thread.compaction?.summary ||
          current.project.workspaceRoot !== start.project.workspaceRoot ||
          current.cwd !== start.cwd
        ) {
          return yield* Effect.fail(
            new Error("The implementation thread changed while its summary was running."),
          );
        }
        yield* checkIdle(thread);
        return current;
      });

      let record: ThreadCompaction | undefined;
      yield* stoppedSession({
        threadId,
        expected: capturedBinding,
        validate: Effect.gen(function* () {
          const current = yield* validate;
          const createdAt = new Date().toISOString();
          const compaction: ThreadCompaction = {
            summary,
            kind: "summary",
            trigger: "automatic",
            estimatedTokens: 0,
            modelContextWindowTokens: request.contextWindowTokens,
            direction: null,
            pivotMessageId: null,
            fromTurnCount: transcript.fromTurnCount,
            toTurnCount: transcript.toTurnCount,
            freshSessionRecordId: request.recordCommandId,
            ...(capturedBinding ? { retiredSessionGeneration: capturedBinding.generation } : {}),
            createdAt,
          };
          const estimatedTokens = yield* Effect.promise(() =>
            estimateProviderInstructionTokens({
              provider: request.targetSlot.provider,
              model: request.targetSlot.model,
              interactionMode: request.interactionMode,
              instructionContext: buildThreadInstructionContext({
                ...current,
                thread: { ...current.thread, compaction, interactionMode: request.interactionMode },
                workflowExecutionProfile: request.workflowExecutionProfile,
              }),
            }),
          );
          const error = request.checkFit(estimatedTokens);
          if (error) return yield* Effect.fail(new Error(error));
          record = { ...compaction, estimatedTokens };
        }),
        commit: Effect.gen(function* () {
          yield* validate;
          if (!record)
            return yield* Effect.fail(new Error("The fresh provider context estimate is missing."));
          yield* orchestrationEngine.dispatch({
            type: "thread.compacted.record",
            commandId: request.recordCommandId,
            threadId,
            compaction: record,
            freshSessionGuard: {
              workflowId: request.workflowId,
              requestId: request.requestId,
              attempt: request.attempt,
              dispatchCommandId: request.dispatchCommandId,
              lastInteractionAt: start.thread.lastInteractionAt,
              branch: start.thread.branch,
              worktreePath: start.thread.worktreePath,
              workspaceRoot: start.project.workspaceRoot,
              model: start.thread.model,
              binding: capturedBinding,
            },
            createdAt: record.createdAt,
          });
        }),
      }).pipe(Effect.timeout("30 seconds"));
      return { kind: "committed" };
    });

  const worker = yield* makeBackgroundWorker(
    (item: ThreadCompactRequestedEvent | WorkflowCompactionJob) => {
      if ("request" in item) {
        return processWorkflowJob(item).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (workflowJobs.delete(item)) pendingThreadIds.delete(item.request.threadId);
              const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
              yield* Deferred.succeed(
                item.outcome,
                exit._tag === "Success"
                  ? exit.value
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? SHUTDOWN
                    : {
                        kind: "failed" as const,
                        detail: error instanceof Error ? error.message : Cause.pretty(exit.cause),
                      },
              );
            }),
          ),
          Effect.ignoreCause,
        );
      }
      const event = item;
      return processEvent(event).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingThreadIds.delete(event.payload.threadId);
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("conversation compaction failed", {
            eventId: event.eventId,
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          });
        }),
      );
    },
    { name: "CompactionService" },
  );

  const requestSummary: CompactionServiceShape["requestSummary"] = (request) =>
    Effect.gen(function* () {
      if (sources.stopped) return SHUTDOWN;
      if (pendingThreadIds.has(request.threadId)) {
        return { kind: "busy", detail: "Another compaction is already reserved for this thread." };
      }
      const job: WorkflowCompactionJob = {
        request,
        queueDeadline: (yield* Clock.currentTimeMillis) + QUEUE_TIMEOUT_MS,
        started: yield* Deferred.make<void>(),
        outcome: yield* Deferred.make<WorkflowCompactionOutcome>(),
        cancelled: false,
        running: false,
      };
      // Check again after allocating the deferreds so no concurrent request can
      // share this thread reservation.
      if (pendingThreadIds.has(request.threadId)) {
        return { kind: "busy", detail: "Another compaction is already reserved for this thread." };
      }
      pendingThreadIds.add(request.threadId);
      workflowJobs.add(job);
      const cancelJob = () => {
        job.cancelled = true;
        if (!job.running && workflowJobs.delete(job)) pendingThreadIds.delete(request.threadId);
      };
      return yield* Effect.raceFirst(
        worker.enqueue(job).pipe(Effect.andThen(Deferred.await(job.started)), Effect.as(null)),
        Deferred.await(job.outcome),
      ).pipe(
        Effect.timeoutOption(QUEUE_TIMEOUT_MS),
        Effect.flatMap((started) => {
          if (Option.isNone(started)) {
            cancelJob();
            return Deferred.succeed(job.outcome, EXPIRED).pipe(Effect.as(EXPIRED));
          }
          return started.value === null
            ? Deferred.await(job.outcome)
            : Effect.succeed(started.value);
        }),
        Effect.catchCause((cause) => {
          cancelJob();
          return Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(SHUTDOWN);
        }),
        Effect.onInterrupt(() =>
          Effect.sync(cancelJob).pipe(Effect.andThen(Deferred.succeed(job.outcome, SHUTDOWN))),
        ),
      );
    });

  const start: CompactionServiceShape["start"] = Effect.gen(function* () {
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
    yield* Effect.forkIn(sources.scope)(
      Scope.provide(sources.scope)(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.compact-requested") {
            return Effect.void;
          }
          if (pendingThreadIds.has(event.payload.threadId)) {
            return Effect.logDebug("skipping duplicate thread.compact-requested event", {
              threadId: event.payload.threadId,
              eventId: event.eventId,
            });
          }
          pendingThreadIds.add(event.payload.threadId);
          return worker.enqueue(event);
        }),
      ),
    ).pipe(Effect.asVoid);
  });

  yield* registerShutdown("conversation-compaction", "drain", () => worker.drain, [
    "provider-ingestion",
  ]);
  yield* Effect.addFinalizer(() => sources.stop);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      workflowJobs,
      (job) => {
        job.cancelled = true;
        return Deferred.succeed(job.outcome, SHUTDOWN);
      },
      { discard: true },
    ),
  );

  return {
    start,
    drain: worker.drain,
    requestSummary,
  } satisfies CompactionServiceShape;
});

export const CompactionServiceLive = Layer.effect(CompactionService, make);
