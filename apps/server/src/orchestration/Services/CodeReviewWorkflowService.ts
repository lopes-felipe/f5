import type { WorkerAdmissionError } from "@t3tools/shared/DrainableWorker";
import type {
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationRetryCodeReviewWorkflowInput,
  OrchestrationRetryWorkflowResult,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CodeReviewWorkflowServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void, WorkerAdmissionError>;
  readonly createWorkflow: (
    input: OrchestrationCreateCodeReviewWorkflowInput,
    /** Explicit ids resume creation. A deleted id cannot be reused; mint a new id. */
    options?: { readonly workflowId?: CodeReviewWorkflowId },
  ) => Effect.Effect<CodeReviewWorkflowId, Error>;
  readonly archiveWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly unarchiveWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly deleteWorkflow: (workflowId: CodeReviewWorkflowId) => Effect.Effect<void, Error>;
  readonly retryWorkflow: (
    input: OrchestrationRetryCodeReviewWorkflowInput,
  ) => Effect.Effect<OrchestrationRetryWorkflowResult, Error>;
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
