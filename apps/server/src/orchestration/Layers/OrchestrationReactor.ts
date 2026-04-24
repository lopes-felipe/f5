import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SessionNotesService } from "../Services/SessionNotesService.ts";
import { WorkflowService } from "../Services/WorkflowService.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const compactionService = yield* CompactionService;
  const projectSkillSyncService = yield* ProjectSkillSyncService;
  const sessionNotesService = yield* SessionNotesService;
  const workflowService = yield* WorkflowService;
  const codeReviewWorkflowService = yield* CodeReviewWorkflowService;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* providerRuntimeIngestion.start;
    yield* providerCommandReactor.start;
    yield* checkpointReactor.start;
    yield* compactionService.start;
    yield* projectSkillSyncService.start;
    yield* sessionNotesService.start;
    yield* workflowService.start;
    yield* codeReviewWorkflowService.start;
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
