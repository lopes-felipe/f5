import type { CodeReviewWorkflow, ThreadId } from "@t3tools/contracts";
import {
  threadLabelsFromPhases,
  type WorkflowTimelinePhase as TimelinePhase,
  type WorkflowTimelinePhaseState as PhaseState,
  type WorkflowTimelineStepState as StepState,
} from "./workflowTimelineTypes";

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function reviewerStepState(status: string): StepState {
  switch (status) {
    case "running":
      return "active";
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Phase derivation
// ---------------------------------------------------------------------------

function deriveReviewersPhase(workflow: CodeReviewWorkflow): TimelinePhase {
  const aState = reviewerStepState(workflow.reviewerA.status);
  const bState = reviewerStepState(workflow.reviewerB.status);

  let state: PhaseState;
  if (aState === "error" || bState === "error") {
    state = "error";
  } else if (aState === "completed" && bState === "completed") {
    state = "completed";
  } else if (aState === "active" || bState === "active") {
    state = "active";
  } else {
    // Both still pending — the phase itself is pending unless at least one
    // reviewer has started.
    state = "pending";
  }

  return {
    id: "reviewers",
    label: "Reviewers",
    state,
    steps: [
      {
        key: "reviewer-a",
        label: workflow.reviewerA.label,
        threadId: workflow.reviewerA.threadId,
        state: aState,
        modelSlot: workflow.reviewerA.slot,
      },
      {
        key: "reviewer-b",
        label: workflow.reviewerB.label,
        threadId: workflow.reviewerB.threadId,
        state: bState,
        modelSlot: workflow.reviewerB.slot,
      },
    ],
  };
}

function deriveMergePhase(workflow: CodeReviewWorkflow): TimelinePhase {
  const consolidation = workflow.consolidation;

  let state: PhaseState;
  switch (consolidation.status) {
    case "completed":
      state = "completed";
      break;
    case "pending_start":
    case "running":
      state = "active";
      break;
    case "error":
      state = "error";
      break;
    default:
      state = "pending";
  }

  return {
    id: "merge",
    label: "Merge",
    state,
    steps: [
      {
        key: "merge",
        label: "Review Merge",
        threadId: consolidation.threadId,
        state,
        modelSlot: consolidation.slot,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveCodeReviewTimelinePhases(workflow: CodeReviewWorkflow): TimelinePhase[] {
  return [deriveReviewersPhase(workflow), deriveMergePhase(workflow)];
}

/** Role label per thread (reviewer slot labels, "Review Merge"). */
export function deriveCodeReviewWorkflowThreadLabels(
  workflow: CodeReviewWorkflow,
): ReadonlyMap<ThreadId, string> {
  return threadLabelsFromPhases(deriveCodeReviewTimelinePhases(workflow));
}
