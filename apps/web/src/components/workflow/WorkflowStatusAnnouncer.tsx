import { useState } from "react";

import { useLiveRegionMessage } from "../../hooks/useLiveRegionMessage";
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
    (input.overallState === "error"
      ? input.phases.find((phase) => phase.state === "error")
      : undefined) ??
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

  if (
    next.overallState === "active" &&
    previous.overallState === "active" &&
    next.statusLabel !== previous.statusLabel &&
    next.statusLabel.trim().length > 0
  ) {
    return `Workflow status: ${next.statusLabel}`;
  }

  return null;
}

interface SnapshotTracker {
  readonly workflowKey: string;
  readonly snapshot: WorkflowAnnouncementSnapshot;
}

/**
 * Polite live region announcing coarse workflow transitions (phase changes,
 * within-phase status changes, completion, and errors). Silent on initial mount
 * and route switches.
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

  const [tracker, setTracker] = useState<SnapshotTracker>(() => ({
    workflowKey: props.workflowKey,
    snapshot: nextSnapshot,
  }));
  const liveRegion = useLiveRegionMessage(props.workflowKey);

  if (tracker.workflowKey !== props.workflowKey) {
    setTracker({ workflowKey: props.workflowKey, snapshot: nextSnapshot });
    liveRegion.reset(props.workflowKey);
  } else if (
    tracker.snapshot.overallState !== nextSnapshot.overallState ||
    tracker.snapshot.activePhaseLabel !== nextSnapshot.activePhaseLabel ||
    tracker.snapshot.statusLabel !== nextSnapshot.statusLabel
  ) {
    const announcement = formatWorkflowAnnouncement(tracker.snapshot, nextSnapshot, props.title);
    setTracker({ workflowKey: props.workflowKey, snapshot: nextSnapshot });
    if (announcement !== null) {
      liveRegion.announce(announcement);
    }
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {liveRegion.renderedMessage}
    </div>
  );
}
