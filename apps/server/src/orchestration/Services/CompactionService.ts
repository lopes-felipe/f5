import type { WorkerAdmissionError } from "@t3tools/shared/DrainableWorker";
import type {
  CommandId,
  PlanningWorkflowId,
  ProviderInteractionMode,
  ThreadId,
  WorkflowModelSlot,
  WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CompactionServiceShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void, WorkerAdmissionError>;
  readonly requestSummary: (
    request: WorkflowCompactionRequest,
  ) => Effect.Effect<WorkflowCompactionOutcome>;
}

export interface WorkflowCompactionRequest {
  readonly workflowId: PlanningWorkflowId;
  readonly threadId: ThreadId;
  readonly attempt: number;
  readonly dispatchCommandId: CommandId;
  readonly requestId: CommandId;
  readonly recordCommandId: CommandId;
  readonly targetSlot: WorkflowModelSlot;
  readonly contextWindowTokens: number;
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile | undefined;
  /** Reject a prospective launch before replacing its existing context. */
  readonly checkFit: (contextUsageTokens: number) => string | null;
}

export type WorkflowCompactionOutcome =
  | { readonly kind: "committed" }
  | {
      readonly kind: "busy" | "skipped" | "expired" | "failed" | "shutdown";
      readonly detail: string;
    };

export class CompactionService extends ServiceMap.Service<
  CompactionService,
  CompactionServiceShape
>()("t3/orchestration/Services/CompactionService") {}
