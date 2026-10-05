import type { ThreadId, WorkflowModelSlot } from "@t3tools/contracts";

export type WorkflowTimelinePhaseState = "completed" | "active" | "pending" | "error" | "skipped";
export type WorkflowTimelineStepState = "completed" | "active" | "pending" | "error" | "skipped";

export interface WorkflowTimelineStep {
  key: string;
  label: string;
  /** null when the step has not yet been created (placeholder) */
  threadId: ThreadId | null;
  state: WorkflowTimelineStepState;
  /**
   * The model the workflow configured for this step, shown until the step's
   * thread exists. null when the contract does not record one (plan reviews).
   */
  modelSlot: WorkflowModelSlot | null;
}

export interface WorkflowTimelinePhase {
  id: string;
  label: string;
  state: WorkflowTimelinePhaseState;
  steps: WorkflowTimelineStep[];
}

/**
 * Role label per workflow thread ("Branch A", "Merge", "Code Review A"...):
 * the label of the first phase step that references the thread.
 */
export function threadLabelsFromPhases(
  phases: ReadonlyArray<WorkflowTimelinePhase>,
): ReadonlyMap<ThreadId, string> {
  const labels = new Map<ThreadId, string>();
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.threadId !== null && !labels.has(step.threadId)) {
        labels.set(step.threadId, step.label);
      }
    }
  }
  return labels;
}

export type WorkflowOverallState = "error" | "active" | "completed" | "pending";

/** Overall run state for a workflow row: an error wins, then any active phase. */
export function overallStateFromPhases(
  phases: ReadonlyArray<WorkflowTimelinePhase>,
): WorkflowOverallState {
  if (phases.some((phase) => phase.state === "error")) return "error";
  if (phases.some((phase) => phase.state === "active")) return "active";
  const relevant = phases.filter((phase) => phase.state !== "skipped");
  if (relevant.length > 0 && relevant.every((phase) => phase.state === "completed")) {
    return "completed";
  }
  return "pending";
}
