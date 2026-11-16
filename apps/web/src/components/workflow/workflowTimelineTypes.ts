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
  /** The phase's stable id ("authoring", "reviews"...), unique within a workflow. */
  id: string;
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
            id: phase.id,
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
  /**
   * The thread the row's step line opens: the step's own thread, else the newest thread the
   * workflow has run in pipeline order (a completed workflow's last thread), else null.
   */
  targetThreadId: ThreadId | null;
  /** The configured model, shown until the step's thread exists. */
  modelSlot: WorkflowModelSlot | null;
}

/** The thread of the last non-skipped step, in pipeline order, that has one. */
function latestStepThreadId(phases: ReadonlyArray<WorkflowTimelinePhase>): ThreadId | null {
  for (let phaseIndex = phases.length - 1; phaseIndex >= 0; phaseIndex -= 1) {
    const steps = phases[phaseIndex]!.steps;
    for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = steps[stepIndex]!;
      if (step.state !== "skipped" && step.threadId) return step.threadId;
    }
  }
  return null;
}

/**
 * The one step a collapsed workflow row names: the first failed step (an error wins, as in
 * `overallStateFromPhases`), else the running step of the first active phase (an active
 * step with a thread first), else "Completed" when every phase is done, else the next
 * pending step. `targetThreadId` falls back to the newest thread so far when the step has
 * none, so the line always opens a thread once the workflow has one.
 */
export function currentStepFromPhases(
  phases: ReadonlyArray<WorkflowTimelinePhase>,
): WorkflowCurrentStep | null {
  const relevant = phases.filter((phase) => phase.state !== "skipped");
  if (relevant.length === 0) return null;
  const latestThreadId = latestStepThreadId(relevant);
  const currentStepOf = (
    step: WorkflowTimelineStep,
    state: WorkflowCurrentStepState,
  ): WorkflowCurrentStep => ({
    label: step.label,
    state,
    threadId: step.threadId,
    targetThreadId: step.threadId ?? latestThreadId,
    modelSlot: step.modelSlot,
  });
  const phaseStep = (label: string, state: WorkflowCurrentStepState): WorkflowCurrentStep => ({
    label,
    state,
    threadId: null,
    targetThreadId: latestThreadId,
    modelSlot: null,
  });

  for (const phase of relevant) {
    const step = phase.steps.find((candidate) => candidate.state === "error");
    if (step) return currentStepOf(step, "needs-attention");
    if (phase.state === "error") {
      return phase.steps[0]
        ? currentStepOf(phase.steps[0], "needs-attention")
        : phaseStep(phase.label, "needs-attention");
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
    return step ? currentStepOf(step, "running") : phaseStep(activePhase.label, "running");
  }

  if (relevant.every((phase) => phase.state === "completed")) {
    return phaseStep("Completed", "completed");
  }

  const pendingPhase = relevant.find((phase) => phase.state === "pending");
  if (!pendingPhase) return null;
  const step =
    pendingPhase.steps.find((candidate) => candidate.state === "pending") ?? pendingPhase.steps[0];
  return step ? currentStepOf(step, "waiting") : phaseStep(pendingPhase.label, "waiting");
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
