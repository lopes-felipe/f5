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
    // Steps of this phase without a row (no thread yet, or a snoozed one) still count toward
    // its state, so a phase whose second half hasn't started doesn't read as done.
    const rowlessStates: WorkflowSidebarStepState[] = [];
    let hasThreadStep = false;
    for (const step of phase.steps) {
      if (step.threadId === null) {
        rowlessStates.push(step.state);
        continue;
      }
      hasThreadStep = true;
      if (claimed.has(step.threadId)) continue;
      claimed.add(step.threadId);
      // Snoozed threads are left out of the workflow's list.
      const thread = threadById.get(step.threadId);
      if (!thread) {
        rowlessStates.push(step.state);
        continue;
      }
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
        // The phase's own state counts too: an active phase whose next thread doesn't exist
        // yet stays active. Rows carry later reruns (Authoring runs again during Revision).
        state: workflowGroupState([
          phase.state,
          ...rows.map((row) => row.stepState),
          ...rowlessStates,
        ]),
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

type ActivityThread = { readonly id: ThreadId; readonly lastInteractionAt: string };

/**
 * When a workflow last did something. A finished workflow goes by its newest thread activity
 * (else its update time): `workflow.updatedAt` moves on bookkeeping writes long after the
 * work, so it would read "just now" and never age out of view. An unfinished workflow also
 * counts `updatedAt`, which moves when it advances to a step with no thread yet (a queued
 * implementation, a retry). `activityOf` reads a thread's time, e.g. its live activity,
 * since summaries keep a stale `lastInteractionAt` while the activity order holds.
 */
export function workflowActivityAt<T extends ActivityThread>(input: {
  readonly updatedAt: string;
  readonly threads: readonly T[];
  readonly finished: boolean;
  readonly activityOf?: ((thread: T) => string) | undefined;
}): string {
  const activityOf = input.activityOf ?? ((thread: T) => thread.lastInteractionAt);
  let newest: string | null = null;
  for (const thread of input.threads) {
    const at = activityOf(thread);
    if (newest === null || at > newest) newest = at;
  }
  if (newest === null) return input.updatedAt;
  return input.finished || newest > input.updatedAt ? newest : input.updatedAt;
}

/** The thread with the newest `lastInteractionAt`, or null when there are none. */
export function newestActivityThread<T extends ActivityThread>(threads: readonly T[]): T | null {
  let newest: T | null = null;
  for (const thread of threads) {
    if (newest === null || thread.lastInteractionAt > newest.lastInteractionAt) newest = thread;
  }
  return newest;
}
