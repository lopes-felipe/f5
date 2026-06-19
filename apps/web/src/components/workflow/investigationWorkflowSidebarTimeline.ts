import type {
  InvestigationPhaseStatus,
  InvestigationWorkflow,
  WorkflowStepStatus,
} from "@t3tools/contracts";
import type {
  WorkflowTimelinePhase as TimelinePhase,
  WorkflowTimelinePhaseState as PhaseState,
  WorkflowTimelineStepState as StepState,
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
      },
      {
        key: "investigator-b",
        label: workflow.investigatorB.label,
        threadId: workflow.investigatorB.investigationThreadId,
        state: bState,
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
      },
      {
        key: "cross-review-b",
        label: "Cross-review B",
        threadId: workflow.investigatorB.crossReviewThreadId,
        state: bState,
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
      },
      {
        key: "own-model-review-b",
        label: "Own-model review B",
        threadId: workflow.investigatorB.selfReviewThreadId,
        state: bState,
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
