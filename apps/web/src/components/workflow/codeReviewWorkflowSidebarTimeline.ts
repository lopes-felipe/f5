import type { CodeReviewWorkflowSummary as CodeReviewWorkflow, ThreadId } from "@t3tools/contracts";
import { codeReviewReviewers } from "@t3tools/shared/workflowParticipants";
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
  const reviewers = codeReviewReviewers(workflow).map(({ id, reviewer }) => ({
    id,
    reviewer,
    state: reviewerStepState(reviewer.status),
  }));
  const states = reviewers.map((entry) => entry.state);

  let state: PhaseState;
  if (states.includes("error")) {
    state = "error";
  } else if (states.every((entry) => entry === "completed")) {
    state = "completed";
  } else if (states.includes("active")) {
    state = "active";
  } else {
    // Reviewers still queued or pending, none started yet.
    state = "pending";
  }

  return {
    id: "reviewers",
    label: "Reviewers",
    state,
    parallel: true,
    steps: reviewers.map(({ id, reviewer, state: stepState }) => ({
      key: `reviewer-${id}`,
      label: reviewer.label,
      threadId: reviewer.threadId,
      turnId: reviewer.pinnedTurnId,
      state: stepState,
      modelSlot: reviewer.slot,
    })),
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
        turnId: consolidation.pinnedTurnId,
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
