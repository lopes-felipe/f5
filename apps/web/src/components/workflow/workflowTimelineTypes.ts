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

/** Thread ids in the order they first appear in the phases' steps: the pipeline order. */
export function threadOrderFromPhases(phases: ReadonlyArray<WorkflowTimelinePhase>): ThreadId[] {
  const order: ThreadId[] = [];
  const seen = new Set<ThreadId>();
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.threadId !== null && !seen.has(step.threadId)) {
        seen.add(step.threadId);
        order.push(step.threadId);
      }
    }
  }
  return order;
}

export interface WorkflowPhaseStepSummary {
  label: string;
  state: Exclude<WorkflowTimelineStepState, "skipped">;
  threadId: ThreadId | null;
  modelSlot: WorkflowModelSlot | null;
}

export interface WorkflowPhaseSummary {
  label: string;
  state: Exclude<WorkflowTimelinePhaseState, "skipped">;
  /** The phase's steps that were not skipped, for the workflow hover card. */
  steps: readonly WorkflowPhaseStepSummary[];
}

/** The phases a workflow row's phase strip shows: every phase that was not skipped. */
export function phaseSummariesFromPhases(
  phases: ReadonlyArray<WorkflowTimelinePhase>,
): WorkflowPhaseSummary[] {
  return phases.flatMap((phase) =>
    phase.state === "skipped"
      ? []
      : [
          {
            label: phase.label,
            state: phase.state,
            steps: phase.steps.flatMap((step) =>
              step.state === "skipped"
                ? []
                : [
                    {
                      label: step.label,
                      state: step.state,
                      threadId: step.threadId,
                      modelSlot: step.modelSlot,
                    },
                  ],
            ),
          },
        ],
  );
}

export type WorkflowCurrentStepState = "running" | "needs-attention" | "waiting" | "completed";

export interface WorkflowCurrentStep {
  label: string;
  state: WorkflowCurrentStepState;
  /** The step's thread; null before it exists, and for a completed workflow. */
  threadId: ThreadId | null;
  /** The configured model, shown until the step's thread exists. */
  modelSlot: WorkflowModelSlot | null;
}

function currentStepOf(
  step: WorkflowTimelineStep,
  state: WorkflowCurrentStepState,
): WorkflowCurrentStep {
  return { label: step.label, state, threadId: step.threadId, modelSlot: step.modelSlot };
}

/**
 * The one step a collapsed workflow row names: the first failed step (an error wins, as in
 * `overallStateFromPhases`), else the running step of the first active phase (an active
 * step with a thread first), else "Completed" when every phase is done, else the next
 * pending step.
 */
export function currentStepFromPhases(
  phases: ReadonlyArray<WorkflowTimelinePhase>,
): WorkflowCurrentStep | null {
  const relevant = phases.filter((phase) => phase.state !== "skipped");
  if (relevant.length === 0) return null;

  for (const phase of relevant) {
    const step = phase.steps.find((candidate) => candidate.state === "error");
    if (step) return currentStepOf(step, "needs-attention");
    if (phase.state === "error") {
      return phase.steps[0]
        ? currentStepOf(phase.steps[0], "needs-attention")
        : { label: phase.label, state: "needs-attention", threadId: null, modelSlot: null };
    }
  }

  const activePhase = relevant.find((phase) => phase.state === "active");
  if (activePhase) {
    const step =
      activePhase.steps.find((candidate) => candidate.state === "active" && candidate.threadId) ??
      activePhase.steps.find((candidate) => candidate.state === "active") ??
      activePhase.steps.find(
        (candidate) => candidate.state !== "completed" && candidate.state !== "skipped",
      ) ??
      activePhase.steps[0];
    return step
      ? currentStepOf(step, "running")
      : { label: activePhase.label, state: "running", threadId: null, modelSlot: null };
  }

  if (relevant.every((phase) => phase.state === "completed")) {
    return { label: "Completed", state: "completed", threadId: null, modelSlot: null };
  }

  const pendingPhase = relevant.find((phase) => phase.state === "pending");
  if (!pendingPhase) return null;
  const step =
    pendingPhase.steps.find((candidate) => candidate.state === "pending") ?? pendingPhase.steps[0];
  return step
    ? currentStepOf(step, "waiting")
    : { label: pendingPhase.label, state: "waiting", threadId: null, modelSlot: null };
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
