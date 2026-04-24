import {
  type OrchestrationCreateWorkflowInput,
  type PlanningWorkflow,
  type PlanningWorkflowId,
  type ProviderModelOptions,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export type CreateWorkflowInput = OrchestrationCreateWorkflowInput;

export interface WorkflowServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly createWorkflow: (input: CreateWorkflowInput) => Effect.Effect<PlanningWorkflowId, Error>;
  readonly archiveWorkflow: (workflowId: PlanningWorkflowId) => Effect.Effect<void, Error>;
  readonly unarchiveWorkflow: (workflowId: PlanningWorkflowId) => Effect.Effect<void, Error>;
  readonly deleteWorkflow: (workflowId: PlanningWorkflowId) => Effect.Effect<void, Error>;
  readonly retryWorkflow: (workflowId: PlanningWorkflowId) => Effect.Effect<void, Error>;
  readonly startImplementation: (input: {
    workflowId: PlanningWorkflowId;
    provider: ProviderKind;
    model: string;
    modelOptions?: ProviderModelOptions;
    runtimeMode?: RuntimeMode;
    codeReviewEnabled?: boolean;
    envMode?: "local" | "worktree";
    baseBranch?: string;
  }) => Effect.Effect<void, Error>;
  readonly workflowForThread: (threadId: ThreadId) => Effect.Effect<
    {
      workflow: PlanningWorkflow;
      label: string;
    } | null,
    never
  >;
}

export class WorkflowService extends ServiceMap.Service<WorkflowService, WorkflowServiceShape>()(
  "t3/orchestration/Services/WorkflowService",
) {}
