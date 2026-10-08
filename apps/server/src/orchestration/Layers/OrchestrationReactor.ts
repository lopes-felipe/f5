import { CommandId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import { InvestigationWorkflowService } from "../Services/InvestigationWorkflowService.ts";
import { NativeSessionCleanupReactor } from "../Services/NativeSessionCleanupReactor.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SessionNotesService } from "../Services/SessionNotesService.ts";
import { WorkflowService } from "../Services/WorkflowService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { startThreadSnoozeReactor } from "../threadSnoozeReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const providerTurnDeliveryWorker = yield* ProviderTurnDeliveryWorker;
  const checkpointReactor = yield* CheckpointReactor;
  const compactionService = yield* CompactionService;
  const projectSkillSyncService = yield* ProjectSkillSyncService;
  const sessionNotesService = yield* SessionNotesService;
  const workflowService = yield* WorkflowService;
  const codeReviewWorkflowService = yield* CodeReviewWorkflowService;
  const investigationWorkflowService = yield* InvestigationWorkflowService;
  const nextTurnQueueDispatcher = yield* NextTurnQueueDispatcher;
  const nativeSessionCleanupReactor = yield* NativeSessionCleanupReactor;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* providerRuntimeIngestion.start;
    yield* providerCommandReactor.start;
    yield* Stream.runForEach(providerTurnDeliveryWorker.outcomes, (outcome) =>
      Effect.gen(function* () {
        let projectionSucceeded = true;
        if (outcome.usageLimit && outcome.state === "rejected") {
          const limit = outcome.usageLimit;
          yield* Effect.gen(function* () {
            const thread = (yield* orchestrationEngine.getReadModel()).threads.find(
              (entry) => entry.id === outcome.threadId,
            );
            if (
              thread &&
              !thread.session?.activeTurnId &&
              thread.session?.status !== "running" &&
              thread.session?.status !== "starting" &&
              !(
                outcome.occurredAt &&
                thread.session &&
                thread.session.updatedAt > outcome.occurredAt
              ) &&
              thread.session?.usageLimit?.deliveryId !== outcome.deliveryId
            ) {
              const now = new Date().toISOString();
              yield* orchestrationEngine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe(`delivery-limit:${outcome.deliveryId}`),
                threadId: thread.id,
                session: {
                  threadId: thread.id,
                  status: "error",
                  providerName: thread.session?.providerName ?? null,
                  providerInstanceId: limit.providerInstanceId,
                  runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
                  activeTurnId: null,
                  lastError: outcome.detail ?? "Usage limit reached",
                  lastErrorId: `delivery:${outcome.deliveryId}`,
                  lastErrorOccurredAt: now,
                  usageLimit: limit,
                  updatedAt: now,
                },
                createdAt: now,
              });
            }
          }).pipe(
            Effect.catchCause((cause) => {
              projectionSucceeded = false;
              return Effect.logWarning("failed to project provider usage rejection", {
                threadId: outcome.threadId,
                cause,
              });
            }),
          );
        }
        yield* nextTurnQueueDispatcher.handleDeliveryOutcome(outcome);
        // Keep the durable outcome replayable until its session projection succeeds.
        if (projectionSucceeded)
          yield* providerTurnDeliveryWorker.acknowledgeOutcome(outcome.deliveryId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to project provider delivery outcome into the queue", {
            threadId: outcome.threadId,
            cause,
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);
    yield* providerTurnDeliveryWorker.start;
    yield* checkpointReactor.start;
    yield* compactionService.start;
    yield* projectSkillSyncService.start;
    yield* sessionNotesService.start;
    yield* workflowService.start;
    yield* codeReviewWorkflowService.start;
    yield* investigationWorkflowService.start;
    yield* nextTurnQueueDispatcher.start;
    yield* nativeSessionCleanupReactor.start;
    yield* startThreadSnoozeReactor(orchestrationEngine);
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
