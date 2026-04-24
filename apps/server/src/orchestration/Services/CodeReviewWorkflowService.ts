import type {
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationRetryCodeReviewWorkflowInput,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CodeReviewWorkflowServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly createWorkflow: (
    input: OrchestrationCreateCodeReviewWorkflowInput,
  ) => Effect.Effect<CodeReviewWorkflowId, Error>;
  readonly archiveWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly unarchiveWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly deleteWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly retryWorkflow: (
    input: OrchestrationRetryCodeReviewWorkflowInput,
  ) => Effect.Effect<void, Error>;
  readonly workflowForThread: (threadId: ThreadId) => Effect.Effect<
    {
      workflow: CodeReviewWorkflow;
      label: string;
    } | null,
    never
  >;
}

export class CodeReviewWorkflowService extends ServiceMap.Service<
  CodeReviewWorkflowService,
  CodeReviewWorkflowServiceShape
>()("t3/orchestration/Services/CodeReviewWorkflowService") {}
