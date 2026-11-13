import type { ThreadId, WorkflowModelSlot } from "@t3tools/contracts";

import type {
  WorkflowPhaseStepSummary,
  WorkflowPhaseSummary,
} from "../workflow/workflowTimelineTypes";

/** A workflow step's run state, as its sidebar row shows it. */
export type WorkflowSidebarStepState = WorkflowPhaseStepSummary["state"];

export interface WorkflowSidebarRow<T> {
  thread: T;
  /** The label inside its phase group ("A Cross" under Reviews). */
  label: string;
  /** The step's own label ("Review A Cross"), for a row shown outside a group. */
  fullLabel: string;
  /** The thread's latest step state; null for a thread no phase names. */
  stepState: WorkflowSidebarStepState | null;
}

export type WorkflowSidebarGroup<T> =
  | {
      kind: "phase";
      id: string;
      label: string;
      state: WorkflowSidebarStepState;
      rows: readonly WorkflowSidebarRow<T>[];
    }
  | {
      /** A phase none of whose steps has a thread yet: shown, but nothing to open. */
      kind: "pending";
      id: string;
      label: string;
      state: WorkflowSidebarStepState;
      stepCount: number;
      modelSlot: WorkflowModelSlot | null;
    };

/**
 * A step label without the phase word it repeats, when more than one word is left:
 * "Review A Cross" under "Reviews" is "A Cross"; "Code Review A" under "Code Review" stays.
 */
export function shortWorkflowStepLabel(phaseLabel: string, stepLabel: string): string {
  const singular = phaseLabel.endsWith("s") ? phaseLabel.slice(0, -1) : phaseLabel;
  const prefix = `${singular} `.toLowerCase();
  if (!stepLabel.toLowerCase().startsWith(prefix)) return stepLabel;
  const rest = stepLabel.slice(prefix.length).trim();
  return rest.split(/\s+/).length > 1 ? rest : stepLabel;
}

/** An error wins, then a running row, then all done; anything else is still pending. */
export function workflowGroupState(
  states: ReadonlyArray<WorkflowSidebarStepState | null>,
): WorkflowSidebarStepState {
  if (states.includes("error")) return "error";
  if (states.includes("active")) return "active";
  if (states.every((state) => state === null || state === "completed")) return "completed";
  return "pending";
}

/**
 * A workflow's threads grouped by the phase that first names them, in pipeline order. A
 * thread appears once, so a phase that only reuses earlier threads (Revision reruns the
 * Branch A/B authors) gets no group; its progress shows on those threads' rows, whose state
 * is their latest started step's. A phase with no threads yet becomes a `pending` group.
 * Threads no phase names come last, one per group, labelled by `labelForUnmatched`.
 */
export function groupWorkflowThreadsByPhase<T extends { id: ThreadId }>(
  phases: readonly WorkflowPhaseSummary[],
  threads: readonly T[],
  labelForUnmatched: (thread: T) => string,
): WorkflowSidebarGroup<T>[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const stepStateByThreadId = new Map<ThreadId, WorkflowSidebarStepState>();
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.threadId === null) continue;
      // A later step that has started replaces an earlier state; a pending one never does.
      if (step.state !== "pending" || !stepStateByThreadId.has(step.threadId)) {
        stepStateByThreadId.set(step.threadId, step.state);
      }
    }
  }

  const claimed = new Set<ThreadId>();
  const groups: WorkflowSidebarGroup<T>[] = [];
  for (const phase of phases) {
    const rows: WorkflowSidebarRow<T>[] = [];
    let hasThreadStep = false;
    for (const step of phase.steps) {
      if (step.threadId === null) continue;
      hasThreadStep = true;
      if (claimed.has(step.threadId)) continue;
      claimed.add(step.threadId);
      // Snoozed threads are left out of the workflow's list.
      const thread = threadById.get(step.threadId);
      if (!thread) continue;
      rows.push({
        thread,
        label: shortWorkflowStepLabel(phase.label, step.label),
        fullLabel: step.label,
        stepState: stepStateByThreadId.get(step.threadId) ?? step.state,
      });
    }
    if (rows.length > 0) {
      groups.push({
        kind: "phase",
        id: phase.id,
        label: phase.label,
        state: workflowGroupState(rows.map((row) => row.stepState)),
        rows,
      });
    } else if (!hasThreadStep) {
      groups.push({
        kind: "pending",
        id: phase.id,
        label: phase.label,
        state: phase.state,
        stepCount: phase.steps.length,
        modelSlot: phase.steps.find((step) => step.modelSlot !== null)?.modelSlot ?? null,
      });
    }
  }

  for (const thread of threads) {
    if (claimed.has(thread.id)) continue;
    const label = labelForUnmatched(thread);
    groups.push({
      kind: "phase",
      id: `thread:${thread.id}`,
      label,
      state: "completed",
      rows: [{ thread, label, fullLabel: label, stepState: null }],
    });
  }
  return groups;
}

/**
 * When a workflow last did something: its newest thread activity, else its own update time.
 * `workflow.updatedAt` alone moves on bookkeeping writes long after the work, so a finished
 * workflow would read "just now" and never age out of view.
 */
export function workflowActivityAt(
  workflow: { readonly updatedAt: string },
  threads: ReadonlyArray<{ readonly lastInteractionAt: string }>,
): string {
  return newestThreadActivityAt(threads) ?? workflow.updatedAt;
}

/** The newest `lastInteractionAt` among `threads`, or null when there are none. */
export function newestThreadActivityAt(
  threads: ReadonlyArray<{ readonly lastInteractionAt: string }>,
): string | null {
  let newest: string | null = null;
  for (const thread of threads) {
    if (newest === null || thread.lastInteractionAt > newest) newest = thread.lastInteractionAt;
  }
  return newest;
}
