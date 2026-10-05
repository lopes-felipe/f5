import type {
  InvestigationPhaseStatus,
  InvestigationWorkflow,
  ThreadId,
  WorkflowStepStatus,
} from "@t3tools/contracts";
import {
  threadLabelsFromPhases,
  type WorkflowTimelinePhase as TimelinePhase,
  type WorkflowTimelinePhaseState as PhaseState,
  type WorkflowTimelineStepState as StepState,
} from "./workflowTimelineTypes";

function workflowStepState(status: WorkflowStepStatus): StepState {
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

function investigationPhaseStepState(status: InvestigationPhaseStatus): StepState {
  switch (status) {
    case "pending_start":
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

function combineStepStates(states: ReadonlyArray<StepState>): PhaseState {
  if (states.some((state) => state === "error")) {
    return "error";
  }
  if (states.every((state) => state === "completed")) {
    return "completed";
  }
  if (states.some((state) => state === "active")) {
    return "active";
  }
  return "pending";
}

function deriveInvestigationPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const aState = workflowStepState(workflow.investigatorA.investigationStatus);
  const bState = workflowStepState(workflow.investigatorB.investigationStatus);
  return {
    id: "investigation",
    label: "Investigation",
    state: combineStepStates([aState, bState]),
    steps: [
      {
        key: "investigator-a",
        label: workflow.investigatorA.label,
        threadId: workflow.investigatorA.investigationThreadId,
        state: aState,
        modelSlot: workflow.investigatorA.slot,
      },
      {
        key: "investigator-b",
        label: workflow.investigatorB.label,
        threadId: workflow.investigatorB.investigationThreadId,
        state: bState,
        modelSlot: workflow.investigatorB.slot,
      },
    ],
  };
}

function deriveCrossReviewPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const aState = investigationPhaseStepState(workflow.investigatorA.crossReviewStatus);
  const bState = investigationPhaseStepState(workflow.investigatorB.crossReviewStatus);
  return {
    id: "cross-review",
    label: "Cross-review",
    state: combineStepStates([aState, bState]),
    steps: [
      {
        key: "cross-review-a",
        label: "Cross-review A",
        threadId: workflow.investigatorA.crossReviewThreadId,
        state: aState,
        modelSlot: null,
      },
      {
        key: "cross-review-b",
        label: "Cross-review B",
        threadId: workflow.investigatorB.crossReviewThreadId,
        state: bState,
        modelSlot: null,
      },
    ],
  };
}

function deriveSelfReviewPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const aState = investigationPhaseStepState(workflow.investigatorA.selfReviewStatus);
  const bState = investigationPhaseStepState(workflow.investigatorB.selfReviewStatus);
  return {
    id: "own-model-review",
    label: "Own-model review",
    state: combineStepStates([aState, bState]),
    steps: [
      {
        key: "own-model-review-a",
        label: "Own-model review A",
        threadId: workflow.investigatorA.selfReviewThreadId,
        state: aState,
        modelSlot: null,
      },
      {
        key: "own-model-review-b",
        label: "Own-model review B",
        threadId: workflow.investigatorB.selfReviewThreadId,
        state: bState,
        modelSlot: null,
      },
    ],
  };
}

function deriveSynthesisPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const state = investigationPhaseStepState(workflow.synthesis.status);
  return {
    id: "synthesis",
    label: "Synthesis",
    state,
    steps: [
      {
        key: "synthesis",
        label: "RCA Synthesis",
        threadId: workflow.synthesis.threadId,
        state,
        modelSlot: workflow.synthesis.slot,
      },
    ],
  };
}

export function deriveInvestigationTimelinePhases(
  workflow: InvestigationWorkflow,
): TimelinePhase[] {
  const phases = [deriveInvestigationPhase(workflow), deriveCrossReviewPhase(workflow)];
  if (workflow.selfReviewEnabled) {
    phases.push(deriveSelfReviewPhase(workflow));
  }
  phases.push(deriveSynthesisPhase(workflow));
  return phases;
}

/** Role label per thread (investigator slot labels, cross-reviews, "RCA Synthesis"). */
export function deriveInvestigationWorkflowThreadLabels(
  workflow: InvestigationWorkflow,
): ReadonlyMap<ThreadId, string> {
  return threadLabelsFromPhases(deriveInvestigationTimelinePhases(workflow));
}
