import { useEffect, useState } from "react";

import type { WorkflowOverallState, WorkflowTimelinePhase } from "./workflowTimelineTypes";

export interface WorkflowAnnouncementSnapshot {
  readonly overallState: WorkflowOverallState;
  readonly statusLabel: string;
  readonly activePhaseLabel: string | null;
}

export function deriveWorkflowAnnouncementSnapshot(input: {
  readonly overallState: WorkflowOverallState;
  readonly statusLabel: string;
  readonly phases: ReadonlyArray<WorkflowTimelinePhase>;
}): WorkflowAnnouncementSnapshot {
  const activePhase =
    input.phases.find((phase) => phase.state === "active") ??
    input.phases.find((phase) => phase.state === "error") ??
    null;

  return {
    overallState: input.overallState,
    statusLabel: input.statusLabel,
    activePhaseLabel: activePhase?.label ?? null,
  };
}

export function formatWorkflowAnnouncement(
  previous: WorkflowAnnouncementSnapshot,
  next: WorkflowAnnouncementSnapshot,
  title: string,
): string | null {
  if (
    previous.overallState === next.overallState &&
    previous.activePhaseLabel === next.activePhaseLabel &&
    previous.statusLabel === next.statusLabel
  ) {
    return null;
  }

  if (next.overallState === "completed" && previous.overallState !== "completed") {
    return `Workflow completed: ${title}`;
  }

  if (next.overallState === "error" && previous.overallState !== "error") {
    return `Workflow failed: ${next.statusLabel}`;
  }

  if (
    next.overallState === "active" &&
    next.activePhaseLabel &&
    next.activePhaseLabel !== previous.activePhaseLabel
  ) {
    return `Workflow phase: ${next.activePhaseLabel}`;
  }

  if (next.overallState === "active" && previous.overallState !== "active") {
    return `Workflow running: ${next.statusLabel}`;
  }

  return null;
}

interface AnnouncerState {
  readonly workflowKey: string;
  readonly snapshot: WorkflowAnnouncementSnapshot;
  readonly message: string;
  readonly sequence: number;
}

/**
 * Polite live region announcing coarse workflow transitions (phase changes,
 * completion, and errors). Silent on initial mount and route switches.
 */
export function WorkflowStatusAnnouncer(props: {
  readonly workflowKey: string;
  readonly title: string;
  readonly overallState: WorkflowOverallState;
  readonly statusLabel: string;
  readonly phases: ReadonlyArray<WorkflowTimelinePhase>;
}) {
  const nextSnapshot = deriveWorkflowAnnouncementSnapshot({
    overallState: props.overallState,
    statusLabel: props.statusLabel,
    phases: props.phases,
  });

  const [state, setState] = useState<AnnouncerState>(() => ({
    workflowKey: props.workflowKey,
    snapshot: nextSnapshot,
    message: "",
    sequence: 0,
  }));

  useEffect(() => {
    if (!state.message) return;
    const timer = setTimeout(() => {
      setState((current) =>
        current.workflowKey === state.workflowKey && current.sequence === state.sequence
          ? { ...current, message: "" }
          : current,
      );
    }, 7000);
    return () => clearTimeout(timer);
  }, [state.message, state.sequence, state.workflowKey]);

  if (state.workflowKey !== props.workflowKey) {
    setState({
      workflowKey: props.workflowKey,
      snapshot: nextSnapshot,
      message: "",
      sequence: 0,
    });
  } else {
    const announcement = formatWorkflowAnnouncement(state.snapshot, nextSnapshot, props.title);
    if (
      announcement !== null ||
      state.snapshot.overallState !== nextSnapshot.overallState ||
      state.snapshot.activePhaseLabel !== nextSnapshot.activePhaseLabel ||
      state.snapshot.statusLabel !== nextSnapshot.statusLabel
    ) {
      setState({
        workflowKey: props.workflowKey,
        snapshot: nextSnapshot,
        message: announcement ?? state.message,
        sequence: announcement ? state.sequence + 1 : state.sequence,
      });
    }
  }

  // Trailing non-breaking space toggles on repeated text so screen readers announce again.
  const rendered = state.message
    ? state.sequence % 2 === 1
      ? `${state.message}\u00A0`
      : state.message
    : "";

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {rendered}
    </div>
  );
}
