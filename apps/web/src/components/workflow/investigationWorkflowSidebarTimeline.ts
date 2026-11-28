import type {
  InvestigationPhaseStatus,
  InvestigationWorkflowSummary as InvestigationWorkflow,
  ThreadId,
  WorkflowStepStatus,
} from "@t3tools/contracts";
import {
  investigationCrossReviews,
  investigationInvestigators,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
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
  const steps = investigationInvestigators(workflow).map(({ id, investigator }) => ({
    key: `investigator-${id}`,
    label: investigator.label,
    threadId: investigator.investigationThreadId,
    turnId: investigator.investigationTurnId,
    state: workflowStepState(investigator.investigationStatus),
    modelSlot: investigator.slot,
  }));
  return {
    id: "investigation",
    label: "Investigation",
    state: combineStepStates(steps.map((step) => step.state)),
    parallel: true,
    steps,
  };
}

function deriveCrossReviewPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const mesh = workflowUsesMesh(investigationInvestigators(workflow).length);
  // One step per expected edge, so queued reviews show as placeholders.
  const steps = investigationCrossReviews(workflow).map((view) => {
    const reviewer = workflowParticipantLabel(view.reviewerId);
    const reviewee = workflowParticipantLabel(view.revieweeId);
    return {
      key: mesh
        ? `cross-review-${view.reviewerId}-on-${view.revieweeId}`
        : `cross-review-${view.reviewerId}`,
      label: mesh ? `Cross-review ${reviewer} on ${reviewee}` : `Cross-review ${reviewer}`,
      threadId: view.threadId,
      turnId: view.turnId,
      state: investigationPhaseStepState(view.status),
      modelSlot: null,
    };
  });
  return {
    id: "cross-review",
    label: "Cross-review",
    state: combineStepStates(steps.map((step) => step.state)),
    parallel: true,
    steps,
  };
}

function deriveSelfReviewPhase(workflow: InvestigationWorkflow): TimelinePhase {
  const steps = investigationInvestigators(workflow).map(({ id, investigator }) => ({
    key: `own-model-review-${id}`,
    label: `Own-model review ${workflowParticipantLabel(id)}`,
    threadId: investigator.selfReviewThreadId,
    turnId: investigator.selfReviewTurnId,
    state: investigationPhaseStepState(investigator.selfReviewStatus),
    modelSlot: null,
  }));
  return {
    id: "own-model-review",
    label: "Own-model review",
    state: combineStepStates(steps.map((step) => step.state)),
    parallel: true,
    steps,
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
        turnId: workflow.synthesis.pinnedTurnId,
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
