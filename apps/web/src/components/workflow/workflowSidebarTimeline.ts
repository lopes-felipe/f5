import { isDocumentWorkflow, documentReaderPassPhase } from "@t3tools/shared/documentWorkflow";
import type {
  PlanningWorkflowSummary as PlanningWorkflow,
  ThreadId,
  WorkflowBranch,
  WorkflowParticipantId,
} from "@t3tools/contracts";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import {
  expectedPlanReviewEdges,
  planningBranches,
  planReviewReviewerBranchId,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import {
  threadLabelsFromPhases,
  type WorkflowTimelinePhase as TimelinePhase,
  type WorkflowTimelinePhaseState as PhaseState,
  type WorkflowTimelineStep as TimelineStep,
  type WorkflowTimelineStepState as StepState,
} from "./workflowTimelineTypes";

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const BRANCH_AT_OR_AFTER_PLAN_SAVED = new Set([
  "plan_saved",
  "reviews_requested",
  "reviews_saved",
  "revising",
  "revised",
]);

const BRANCH_AT_OR_AFTER_REVIEWS_SAVED = new Set(["reviews_saved", "revising", "revised"]);

const BRANCH_AT_OR_AFTER_REVISED = new Set(["revised"]);

const ACTIVE_IMPLEMENTATION_STATUSES = new Set([
  "implementing",
  "implemented",
  "code_reviews_requested",
  "code_reviews_saved",
  "applying_reviews",
]);

const IMPL_AT_OR_AFTER_CODE_REVIEWS_SAVED = new Set([
  "code_reviews_saved",
  "applying_reviews",
  "completed",
]);

// ---------------------------------------------------------------------------
// Phase derivation
// ---------------------------------------------------------------------------

type PlanningBranch = WorkflowBranch;

function deriveAuthoringPhase(workflow: PlanningWorkflow): TimelinePhase {
  const branches = planningBranches(workflow);

  // A persisted plan turn proves authoring completed even when a later-stage
  // failure left the legacy branch status at `error`.
  const isCompleted = (branch: PlanningBranch) =>
    branch.planTurnId !== null || BRANCH_AT_OR_AFTER_PLAN_SAVED.has(branch.status);
  const isError = (branch: PlanningBranch) =>
    planningWorkflowBranchFailureStage(branch) === "authoring";

  let state: PhaseState;
  if (branches.some(isError)) {
    state = "error";
  } else if (branches.every(isCompleted)) {
    state = "completed";
  } else {
    // Authoring starts immediately — never "pending"
    state = "active";
  }

  function branchStepState(branch: PlanningBranch): StepState {
    if (isError(branch)) return "error";
    if (isCompleted(branch)) return "completed";
    return "active";
  }

  return {
    id: "authoring",
    label: "Authoring",
    state,
    steps: branches.map((branch) => ({
      key: `author-${branch.branchId}`,
      label: `Branch ${workflowParticipantLabel(branch.branchId)}`,
      threadId: branch.authorThreadId,
      state: branchStepState(branch),
      modelSlot: branch.authorSlot,
    })),
  };
}

function reviewStepState(status: string): StepState {
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

/**
 * Review step identity. Two-author runs keep `review-cross-a` / "Review A Cross"; mesh runs
 * name the reviewer: `review-cross-a-by-b` / "Review A by B".
 */
function reviewStepIdentity(
  mesh: boolean,
  reviewedId: WorkflowParticipantId,
  slot: "cross" | "self",
  reviewerId: WorkflowParticipantId,
): { key: string; label: string } {
  const reviewed = workflowParticipantLabel(reviewedId);
  if (mesh && slot === "cross") {
    return {
      key: `review-cross-${reviewedId}-by-${reviewerId}`,
      label: `Review ${reviewed} by ${workflowParticipantLabel(reviewerId)}`,
    };
  }
  return {
    key: `review-${slot}-${reviewedId}`,
    label: `Review ${reviewed} ${slot === "cross" ? "Cross" : "Self"}`,
  };
}

function deriveReviewsPhase(workflow: PlanningWorkflow): TimelinePhase {
  const branches = planningBranches(workflow);
  const mesh = workflowUsesMesh(branches.length);
  const statuses = branches.map((branch) => branch.status);

  const allReviews = branches.flatMap((branch) => branch.reviews);
  const hasReviewError = allReviews.some((r) => r.status === "error");
  const hasLegacyReviewError = branches.some(
    (branch) => planningWorkflowBranchFailureStage(branch) === "reviews",
  );

  // Also check actual review objects — on retry, branches may be reset to
  // "pending" while completed review threads are preserved.
  const allReviewsCompleted =
    allReviews.length > 0 && allReviews.every((r) => r.status === "completed");
  const anyReviewRunning = allReviews.some((r) => r.status === "running");

  let state: PhaseState;
  if (hasReviewError || hasLegacyReviewError) {
    state = "error";
  } else if (
    statuses.every((status) => BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(status)) ||
    allReviewsCompleted
  ) {
    state = "completed";
  } else if (
    statuses.some((status) => status === "reviews_requested" || status === "reviews_saved") ||
    anyReviewRunning
  ) {
    state = "active";
  } else if (allReviews.length > 0) {
    // Reviews exist (e.g. some completed, some pending after partial retry)
    // but neither branch-level flags nor review statuses indicate full completion.
    state = "active";
  } else {
    // No reviews exist yet
    state = "pending";
  }

  // Real reviews where they exist; a placeholder for every other expected review.
  const entries = branches.flatMap((branch) => {
    const expected = expectedPlanReviewEdges(workflow, branch.branchId);
    const stored = branch.reviews.map((review) => ({
      reviewedId: branch.branchId,
      slot: review.slot,
      reviewerId: planReviewReviewerBranchId(workflow, branch.branchId, review),
      threadId: review.threadId as ThreadId | null,
      state: reviewStepState(review.status),
    }));
    // Two-author runs show placeholders only before any review exists, as before.
    const missing =
      !mesh && allReviews.length > 0
        ? []
        : expected
            .filter(
              (edge) =>
                !stored.some(
                  (review) =>
                    review.slot === edge.slot && review.reviewerId === edge.reviewerBranchId,
                ),
            )
            .map((edge) => ({
              reviewedId: branch.branchId,
              slot: edge.slot,
              reviewerId: edge.reviewerBranchId,
              threadId: null,
              state: "pending" as StepState,
            }));
    return [...stored, ...missing];
  });
  const steps: TimelineStep[] = entries
    .toSorted((left, right) => {
      if (left.slot !== right.slot) return left.slot === "cross" ? -1 : 1;
      return (
        left.reviewedId.localeCompare(right.reviewedId) ||
        left.reviewerId.localeCompare(right.reviewerId)
      );
    })
    .map((entry) => ({
      ...reviewStepIdentity(mesh, entry.reviewedId, entry.slot, entry.reviewerId),
      threadId: entry.threadId,
      state: entry.state,
      modelSlot: null,
    }));

  return { id: "reviews", label: "Reviews", state, steps };
}

function deriveRevisionPhase(workflow: PlanningWorkflow): TimelinePhase {
  const branches = planningBranches(workflow);
  const isRevised = (branch: PlanningBranch) => BRANCH_AT_OR_AFTER_REVISED.has(branch.status);
  const hasErrorInRevision = branches.some(
    (branch) => planningWorkflowBranchFailureStage(branch) === "revision",
  );

  let state: PhaseState;
  if (hasErrorInRevision) {
    state = "error";
  } else if (branches.every(isRevised)) {
    state = "completed";
  } else if (branches.some((branch) => branch.status === "revising")) {
    state = "active";
  } else if (branches.every((branch) => BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(branch.status))) {
    // Every branch finished reviews but none started revising yet —
    // revision is the next stage, so show it as active.
    state = "active";
  } else {
    state = "pending";
  }

  function branchRevisionStepState(branch: PlanningBranch): StepState {
    if (planningWorkflowBranchFailureStage(branch) === "revision") return "error";
    if (isRevised(branch)) return "completed";
    if (branch.status === "revising") return "active";
    return "pending";
  }

  return {
    id: "revision",
    label: "Revision",
    state,
    steps: branches.map((branch) => ({
      key: `revision-${branch.branchId}`,
      label: `Branch ${workflowParticipantLabel(branch.branchId)}`,
      threadId: branch.authorThreadId,
      state: branchRevisionStepState(branch),
      modelSlot: branch.authorSlot,
    })),
  };
}

function deriveMergePhase(workflow: PlanningWorkflow): TimelinePhase {
  const mergeStatus = workflow.merge.status;

  let state: PhaseState;
  switch (mergeStatus) {
    case "merged":
    case "manual_review":
      state = "completed";
      break;
    case "in_progress":
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
        label: "Merge",
        threadId: workflow.merge.threadId,
        state,
        modelSlot: workflow.merge.mergeSlot,
      },
    ],
  };
}

function deriveImplementationPhase(workflow: PlanningWorkflow): TimelinePhase {
  const impl = workflow.implementation;

  let state: PhaseState;
  if (!impl || impl.status === "not_started") {
    state = "pending";
  } else if (impl.status === "error") {
    const errorBelongsToLaterPhase =
      impl.codeReviews.some((review) => review.status === "error") ||
      (impl.codeReviews.length > 0 &&
        impl.codeReviews.every((review) => review.status === "completed"));
    state = errorBelongsToLaterPhase ? "completed" : "error";
  } else if (impl.status === "completed") {
    state = "completed";
  } else if (ACTIVE_IMPLEMENTATION_STATUSES.has(impl.status)) {
    state = "active";
  } else {
    state = "pending";
  }

  const steps: TimelineStep[] = [
    {
      key: "implementation",
      label: "Implementation",
      threadId: impl?.threadId ?? null,
      state,
      modelSlot: impl?.implementationSlot ?? null,
    },
  ];

  return {
    id: "implementation",
    label: "Implementation",
    state,
    steps,
  };
}

function deriveCodeReviewPhase(workflow: PlanningWorkflow): TimelinePhase {
  const impl = workflow.implementation;

  if (!impl || impl.codeReviews.length === 0) {
    return {
      id: "code-review",
      label: "Code Review",
      state: "pending",
      steps: [],
    };
  }

  const codeReviews = impl.codeReviews;
  const hasReviewError = codeReviews.some((r) => r.status === "error");
  const allReviewsCompleted = codeReviews.every((r) => r.status === "completed");
  const anyReviewRunning = codeReviews.some((r) => r.status === "running");

  let state: PhaseState;
  if (hasReviewError) {
    state = "error";
  } else if (allReviewsCompleted && IMPL_AT_OR_AFTER_CODE_REVIEWS_SAVED.has(impl.status)) {
    state = "completed";
  } else if (impl.status === "code_reviews_requested" || anyReviewRunning) {
    state = "active";
  } else {
    state = "pending";
  }

  const steps: TimelineStep[] = codeReviews.map((review, index) => {
    let stepState: StepState;
    switch (review.status) {
      case "running":
        stepState = "active";
        break;
      case "completed":
        stepState = "completed";
        break;
      case "error":
        stepState = "error";
        break;
      default:
        stepState = "pending";
    }

    return {
      key: `code-review-${index}-${review.threadId}`,
      label: `Code Review ${String.fromCharCode(65 + index)}`,
      threadId: review.threadId,
      state: stepState,
      modelSlot: review.reviewerSlot,
    };
  });

  return {
    id: "code-review",
    label: "Code Review",
    state,
    steps,
  };
}

function deriveApplyReviewsPhase(workflow: PlanningWorkflow): TimelinePhase {
  const impl = workflow.implementation;

  let state: PhaseState;
  if (!impl) {
    state = "pending";
  } else if (impl.status === "applying_reviews") {
    state = "active";
  } else if (impl.status === "completed") {
    state = "completed";
  } else if (
    impl.status === "error" &&
    impl.codeReviews.length > 0 &&
    impl.codeReviews.every((r) => r.status === "completed")
  ) {
    // Only claim the error once the implementation has moved past code
    // reviews; earlier errors belong to the Implementation or Code Review
    // phases.
    state = "error";
  } else {
    state = "pending";
  }

  return {
    id: "apply-reviews",
    label: "Apply Reviews",
    state,
    steps: [
      {
        key: "apply-reviews",
        label: "Apply Reviews",
        threadId: impl?.threadId ?? null,
        state,
        modelSlot: impl?.implementationSlot ?? null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveTimelinePhases(workflow: PlanningWorkflow): TimelinePhase[] {
  if (isDocumentWorkflow(workflow)) {
    const phases = [
      { ...deriveAuthoringPhase(workflow), label: "Drafting" },
      deriveReviewsPhase(workflow),
      deriveRevisionPhase(workflow),
      deriveMergePhase(workflow),
    ];
    if (workflow.readerReviewEnabled) {
      const pass = workflow.readerPass;
      const phase = documentReaderPassPhase(workflow);
      const state: PhaseState =
        pass?.status === "skipped"
          ? "skipped"
          : phase === "error"
            ? "error"
            : phase === "done"
              ? "completed"
              : phase
                ? "active"
                : "pending";
      phases.push({
        id: "reader-pass",
        label: "Reader pass",
        state,
        steps: [
          {
            key: "reader-review",
            label: "Reader review",
            threadId: pass?.readerThreadId ?? null,
            modelSlot: workflow.readerSlot ?? null,
            state:
              pass?.status === "skipped"
                ? "skipped"
                : pass?.pinnedTurnId
                  ? "completed"
                  : phase === "reading"
                    ? "active"
                    : pass?.errorStage === "reader"
                      ? "error"
                      : "pending",
          },
          {
            key: "polish",
            label: "Polish",
            threadId: workflow.merge.threadId,
            modelSlot: workflow.merge.mergeSlot,
            state:
              pass?.status === "skipped"
                ? "skipped"
                : pass?.status === "completed"
                  ? "completed"
                  : phase === "polishing"
                    ? "active"
                    : pass?.errorStage === "polish"
                      ? "error"
                      : "pending",
          },
        ],
      });
    }
    return phases;
  }
  return [
    deriveAuthoringPhase(workflow),
    deriveReviewsPhase(workflow),
    deriveRevisionPhase(workflow),
    deriveMergePhase(workflow),
    deriveImplementationPhase(workflow),
    deriveCodeReviewPhase(workflow),
    deriveApplyReviewsPhase(workflow),
  ];
}

/** Role label per thread ("Branch A", "Review A Cross", "Merge", "Reader review"...). */
export function deriveWorkflowThreadLabels(
  workflow: PlanningWorkflow,
): ReadonlyMap<ThreadId, string> {
  return threadLabelsFromPhases(deriveTimelinePhases(workflow));
}
