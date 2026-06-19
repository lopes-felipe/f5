import type {
  InvestigationWorkflow,
  InvestigationWorkflowId,
  OrchestrationCreateInvestigationWorkflowInput,
  OrchestrationRetryInvestigationWorkflowInput,
  ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface InvestigationWorkflowServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly createWorkflow: (
    input: OrchestrationCreateInvestigationWorkflowInput,
  ) => Effect.Effect<InvestigationWorkflowId, Error>;
  readonly archiveWorkflow: (workflowId: InvestigationWorkflowId) => Effect.Effect<void, Error>;
  readonly unarchiveWorkflow: (workflowId: InvestigationWorkflowId) => Effect.Effect<void, Error>;
  readonly deleteWorkflow: (workflowId: InvestigationWorkflowId) => Effect.Effect<void, Error>;
  readonly retryWorkflow: (
    input: OrchestrationRetryInvestigationWorkflowInput,
  ) => Effect.Effect<void, Error>;
  readonly workflowForThread: (threadId: ThreadId) => Effect.Effect<
    {
      workflow: InvestigationWorkflow;
      label: string;
    } | null,
    never
  >;
}

export class InvestigationWorkflowService extends ServiceMap.Service<
  InvestigationWorkflowService,
  InvestigationWorkflowServiceShape
>()("t3/orchestration/Services/InvestigationWorkflowService") {}
