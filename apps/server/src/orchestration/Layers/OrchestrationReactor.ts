import { Effect, Layer, Stream } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import { InvestigationWorkflowService } from "../Services/InvestigationWorkflowService.ts";
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
  const orchestrationEngine = yield* OrchestrationEngineService;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* providerRuntimeIngestion.start;
    yield* providerCommandReactor.start;
    yield* Stream.runForEach(providerTurnDeliveryWorker.outcomes, (outcome) =>
      nextTurnQueueDispatcher.handleDeliveryOutcome(outcome).pipe(
        Effect.andThen(providerTurnDeliveryWorker.acknowledgeOutcome(outcome.deliveryId)),
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
