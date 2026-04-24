import type { ThreadId } from "@t3tools/contracts";

export type WorkflowTimelinePhaseState = "completed" | "active" | "pending" | "error";
export type WorkflowTimelineStepState = "completed" | "active" | "pending" | "error";

export interface WorkflowTimelineStep {
  key: string;
  label: string;
  /** null when the step has not yet been created (placeholder) */
  threadId: ThreadId | null;
  state: WorkflowTimelineStepState;
}

export interface WorkflowTimelinePhase {
  id: string;
  label: string;
  state: WorkflowTimelinePhaseState;
  steps: WorkflowTimelineStep[];
}
