import type { PlanningWorkflow } from "@t3tools/contracts";
import type {
  WorkflowTimelinePhase as TimelinePhase,
  WorkflowTimelinePhaseState as PhaseState,
  WorkflowTimelineStep as TimelineStep,
  WorkflowTimelineStepState as StepState,
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

function deriveAuthoringPhase(workflow: PlanningWorkflow): TimelinePhase {
  const aStatus = workflow.branchA.status;
  const bStatus = workflow.branchB.status;

  const aCompleted = BRANCH_AT_OR_AFTER_PLAN_SAVED.has(aStatus);
  const bCompleted = BRANCH_AT_OR_AFTER_PLAN_SAVED.has(bStatus);

  let state: PhaseState;
  if (aStatus === "error" || bStatus === "error") {
    state = "error";
  } else if (aCompleted && bCompleted) {
    state = "completed";
  } else {
    // Authoring starts immediately — never "pending"
    state = "active";
  }

  function branchStepState(branchStatus: string): StepState {
    if (branchStatus === "error") return "error";
    if (BRANCH_AT_OR_AFTER_PLAN_SAVED.has(branchStatus)) return "completed";
    return "active";
  }

  return {
    id: "authoring",
    label: "Authoring",
    state,
    steps: [
      {
        key: "author-a",
        label: "Branch A",
        threadId: workflow.branchA.authorThreadId,
        state: branchStepState(aStatus),
      },
      {
        key: "author-b",
        label: "Branch B",
        threadId: workflow.branchB.authorThreadId,
        state: branchStepState(bStatus),
      },
    ],
  };
}

function deriveReviewsPhase(workflow: PlanningWorkflow): TimelinePhase {
  const aStatus = workflow.branchA.status;
  const bStatus = workflow.branchB.status;

  const aReviewsDone = BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(aStatus);
  const bReviewsDone = BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(bStatus);

  const allReviews = [...workflow.branchA.reviews, ...workflow.branchB.reviews];
  const hasReviewError = allReviews.some((r) => r.status === "error");

  // Also check actual review objects — on retry, branches may be reset to
  // "pending" while completed review threads are preserved.
  const allReviewsCompleted =
    allReviews.length > 0 && allReviews.every((r) => r.status === "completed");
  const anyReviewRunning = allReviews.some((r) => r.status === "running");

  let state: PhaseState;
  if (hasReviewError) {
    state = "error";
  } else if ((aReviewsDone && bReviewsDone) || allReviewsCompleted) {
    state = "completed";
  } else if (
    aStatus === "reviews_requested" ||
    bStatus === "reviews_requested" ||
    aStatus === "reviews_saved" ||
    bStatus === "reviews_saved" ||
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

  // When real reviews exist, map them; otherwise show placeholders.
  if (allReviews.length > 0) {
    const reviewsWithBranch = [
      ...workflow.branchA.reviews.map((r) => ({ ...r, branch: "A" as const })),
      ...workflow.branchB.reviews.map((r) => ({ ...r, branch: "B" as const })),
    ].toSorted((left, right) => {
      if (left.slot !== right.slot) return left.slot === "cross" ? -1 : 1;
      return left.branch.localeCompare(right.branch);
    });

    const steps: TimelineStep[] = reviewsWithBranch.map((review) => {
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

      const slotLabel = review.slot === "cross" ? "Cross" : "Self";
      return {
        key: `review-${review.slot}-${review.branch.toLowerCase()}`,
        label: `Review ${review.branch} ${slotLabel}`,
        threadId: review.threadId,
        state: stepState,
      };
    });

    return { id: "reviews", label: "Reviews", state, steps };
  }

  // Placeholders
  const steps: TimelineStep[] = [
    { key: "review-cross-a", label: "Review A Cross", threadId: null, state: "pending" },
    { key: "review-cross-b", label: "Review B Cross", threadId: null, state: "pending" },
  ];

  if (workflow.selfReviewEnabled) {
    steps.push(
      { key: "review-self-a", label: "Review A Self", threadId: null, state: "pending" },
      { key: "review-self-b", label: "Review B Self", threadId: null, state: "pending" },
    );
  }

  return { id: "reviews", label: "Reviews", state, steps };
}

function deriveRevisionPhase(workflow: PlanningWorkflow): TimelinePhase {
  const aStatus = workflow.branchA.status;
  const bStatus = workflow.branchB.status;

  const aRevised = BRANCH_AT_OR_AFTER_REVISED.has(aStatus);
  const bRevised = BRANCH_AT_OR_AFTER_REVISED.has(bStatus);
  const aRevising = aStatus === "revising";
  const bRevising = bStatus === "revising";
  const aReviewsDone = BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(aStatus);
  const bReviewsDone = BRANCH_AT_OR_AFTER_REVIEWS_SAVED.has(bStatus);

  // Only attribute a branch error to the Revision phase if at least one branch
  // is actually at or past the reviews_saved stage — otherwise the error
  // belongs to an earlier phase (authoring or reviews).
  const anyPastReviews =
    aReviewsDone || bReviewsDone || aRevising || bRevising || aRevised || bRevised;
  const hasErrorInRevision = (aStatus === "error" || bStatus === "error") && anyPastReviews;

  let state: PhaseState;
  if (hasErrorInRevision) {
    state = "error";
  } else if (aRevised && bRevised) {
    state = "completed";
  } else if (aRevising || bRevising) {
    state = "active";
  } else if (aReviewsDone && bReviewsDone) {
    // Both branches finished reviews but haven't started revising yet —
    // revision is the next stage, so show it as active.
    state = "active";
  } else {
    state = "pending";
  }

  function branchRevisionStepState(branchStatus: string): StepState {
    if (branchStatus === "error") {
      // Only surface as error at the step level if this phase owns the error.
      return hasErrorInRevision ? "error" : "pending";
    }
    if (BRANCH_AT_OR_AFTER_REVISED.has(branchStatus)) return "completed";
    if (branchStatus === "revising") return "active";
    return "pending";
  }

  return {
    id: "revision",
    label: "Revision",
    state,
    steps: [
      {
        key: "revision-a",
        label: "Branch A",
        threadId: workflow.branchA.authorThreadId,
        state: branchRevisionStepState(aStatus),
      },
      {
        key: "revision-b",
        label: "Branch B",
        threadId: workflow.branchB.authorThreadId,
        state: branchRevisionStepState(bStatus),
      },
    ],
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
    state = "error";
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
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function deriveTimelinePhases(workflow: PlanningWorkflow): TimelinePhase[] {
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
