import {
  CommandId,
  type OrchestrationReadModel,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  type PlanningWorkflow,
  type ProviderInteractionMode,
  ThreadId,
  TurnId,
  type WorkflowBranch,
  type WorkflowBranchId,
  type WorkflowModelSlot,
  type WorkflowReview,
  type WorkflowReviewSlot,
} from "@t3tools/contracts";
import {
  planningBranches,
  planReviewReviewerBranchId,
  requirePlanningBranch,
  updatePlanningBranch,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import { createHash } from "node:crypto";
import {
  isDocumentWorkflow,
  planningWorkflowDocumentType,
  validateDocumentArtifact,
} from "@t3tools/shared/documentWorkflow";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import { isDeletedWorkflow } from "@t3tools/shared/workflowArchive";

import {
  getFinishedConsumableLatestTurn,
  type WorkflowFitThread,
  workflowPromptFitError,
} from "../workflowSharedUtils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { buildDocumentMergePrompt } from "../documentWorkflowPrompts.ts";
import { buildMergePrompt, type MergePlanInput } from "../workflowPrompts.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";
import {
  allocateArtifactCharBudget,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "../workflowSharedUtils.ts";
import { isProviderResumeFailureText } from "../../provider/resumeFailure.ts";
import { resolveWorkflowBehavior } from "../workflowBehavior.ts";

export const WORKFLOW_PLANNING_INTERACTION_MODE: ProviderInteractionMode = "plan";
export const MAX_AUTO_RETRY_ATTEMPTS = 2;
export const AUTO_RETRY_BACKOFF_MS = 5_000;
// An automatic retry dispatches only after the thread's session looks settled
// on two observations this far apart, the last one at the end of the backoff.
// A session that is still restarting after the failure would otherwise turn
// the retry into an ambiguous delivery.
export const AUTO_RETRY_SETTLE_INTERVAL_MS = 1_000;
export const AUTO_RETRY_SETTLE_TIMEOUT_MS = 120_000;

export function stableWorkflowUuid(
  namespace: string,
  ...parts: ReadonlyArray<string | number | null>
) {
  const digest = createHash("sha256")
    .update([namespace, ...parts.map(String)].join("\0"))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function stableWorkflowCommandId(
  namespace: string,
  ...parts: ReadonlyArray<string | number | null>
): CommandId {
  return CommandId.makeUnsafe(`workflow:${namespace}:${stableWorkflowUuid(namespace, ...parts)}`);
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function workflowPromptInvariant(input: {
  readonly workflow: PlanningWorkflow;
  readonly prompt: string;
  readonly artifacts: ReadonlyArray<string>;
  readonly targetSlot: WorkflowModelSlot;
  readonly artifactLabel: string;
  readonly thread?: WorkflowFitThread | null;
  readonly artifactBudgetRecovery?: string;
}): OrchestrationCommandInvariantError | null {
  const behavior = resolveWorkflowBehavior({
    runKind: "planning",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
  return workflowPromptFitError({
    ...input,
    enforceArtifactBudget: behavior.loudAuthoritativeArtifactLimit,
  });
}

export type WorkflowTitleGenerationWorkItem = {
  readonly workflowId: PlanningWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

export function isRetryableSessionError(session: {
  readonly lastError: string | null;
  readonly lastErrorRetryability?: "retryable" | "non-retryable" | null | undefined;
}): boolean {
  // A resume or transcript failure repeats on every retry until the saved
  // conversation is repaired.
  if (isProviderResumeFailureText(session.lastError)) {
    return false;
  }
  if (session.lastErrorRetryability) {
    return session.lastErrorRetryability === "retryable";
  }
  const lastError = session.lastError;
  if (!lastError) {
    return false;
  }

  const normalized = lastError.toLowerCase();
  const nonRetryablePatterns = [
    "authentication",
    "unauthorized",
    "forbidden",
    "invalid api key",
    "auth failed",
    "content policy",
    "policy violation",
    "safety policy",
  ];
  if (nonRetryablePatterns.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  return [
    "timeout",
    "timed out",
    "rate limit",
    "429",
    "502",
    "503",
    "overloaded",
    "capacity",
    "econnrefused",
    "econnreset",
    "connection reset",
  ].some((pattern) => normalized.includes(pattern));
}

export function formatSessionError(
  session: {
    readonly lastError: string | null;
    readonly providerName: string | null;
  },
  fallback: string,
): string {
  return [
    session.lastError ?? fallback,
    session.providerName ? `provider: ${session.providerName}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
}

export function isSessionSettledForAutoRetry(
  thread: Pick<OrchestrationReadModel["threads"][number], "session"> | null | undefined,
): boolean {
  if (!thread) return false;
  const status = thread.session?.status ?? null;
  return status !== "starting" && !hasRunningSessionTurn(thread);
}

export function hasRunningSessionTurn(
  thread: Pick<OrchestrationReadModel["threads"][number], "session"> | null | undefined,
): boolean {
  return thread?.session?.status === "running" && thread.session.activeTurnId !== null;
}

export function isSessionUnavailableForReconciliation(
  thread:
    | Pick<OrchestrationReadModel["threads"][number], "latestTurn" | "messages" | "session">
    | null
    | undefined,
  options?: {
    readonly allowCompletedTurn?: boolean;
  },
): boolean {
  const status = thread?.session?.status ?? null;
  const unavailable = !thread || status === null || status === "error" || status === "stopped";
  if (!unavailable) {
    return false;
  }
  if (options?.allowCompletedTurn && getFinishedConsumableLatestTurn(thread)) {
    return false;
  }
  return true;
}

export function getFinishedLatestTurnId(
  thread:
    | Pick<OrchestrationReadModel["threads"][number], "latestTurn" | "session">
    | null
    | undefined,
): TurnId | null {
  if (!thread?.latestTurn || thread.latestTurn.state !== "completed") {
    return null;
  }
  if (
    thread.session?.status === "running" &&
    thread.session.activeTurnId === thread.latestTurn.turnId
  ) {
    return null;
  }
  return thread.latestTurn.turnId;
}

export function updateAuthoringBranch(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  now: string,
  outcome: { ok: true } | { ok: false; error: string },
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      status: outcome.ok ? ("authoring" as const) : ("error" as const),
      error: outcome.ok ? null : outcome.error,
      errorStage: outcome.ok ? null : ("authoring" as const),
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

/** `Cross review` / `Self review`; on mesh runs `Cross review by Author B`. */
export function planReviewLabel(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  review: WorkflowReview,
) {
  if (review.slot === "self" || !workflowUsesMesh(planningBranches(workflow).length)) {
    return review.slot === "self" ? "Self review" : "Cross review";
  }
  return `Cross review by Author ${workflowParticipantLabel(
    planReviewReviewerBranchId(workflow, branchId, review),
  )}`;
}

export function labelForThread(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; label: string } | null {
  if (
    workflow.readerPass?.readerThreadId === threadId ||
    workflow.readerPass?.previousReaderThreadIds?.includes(threadId)
  )
    return { workflow, label: "Reader review" };
  const branches = planningBranches(workflow);
  for (const branch of branches) {
    if (branch.authorThreadId === threadId) {
      return {
        workflow,
        label: `Branch ${workflowParticipantLabel(branch.branchId)} authoring`,
      };
    }
  }
  for (const branch of branches) {
    for (const review of branch.reviews) {
      if (review.threadId === threadId) {
        const label = workflowParticipantLabel(branch.branchId);
        return {
          workflow,
          label: workflowUsesMesh(branches.length)
            ? `Branch ${label} ${planReviewLabel(workflow, branch.branchId, review).toLowerCase()}`
            : `Branch ${label} ${review.slot} review`,
        };
      }
    }
  }
  if (workflow.merge.threadId === threadId) {
    return { workflow, label: "Merge" };
  }
  if (workflow.implementation?.threadId === threadId) {
    return { workflow, label: "Implementation" };
  }
  for (const review of workflow.implementation?.codeReviews ?? []) {
    if (review.threadId === threadId) {
      return { workflow, label: `Code review (${review.reviewerLabel})` };
    }
  }
  return null;
}

export function workflowForAuthorThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; branchId: WorkflowBranchId } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    const branch = planningBranches(workflow).find((entry) => entry.authorThreadId === threadId);
    if (branch) {
      return { workflow, branchId: branch.branchId };
    }
  }
  return null;
}

export function markBranchPlanSaved(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  input: {
    readonly turnId: string | null;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      status: "plan_saved" as const,
      planTurnId: input.turnId ?? branch.planTurnId,
      error: null,
      errorStage: null,
      updatedAt: input.updatedAt,
    })),
    updatedAt: input.updatedAt,
  };
}

export function markBranchError(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  input: {
    readonly error: string;
    readonly stage: "authoring" | "revision";
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      status: "error" as const,
      error: input.error,
      errorStage: input.stage,
      updatedAt: input.updatedAt,
    })),
    updatedAt: input.updatedAt,
  };
}

export function workflowForReviewThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; branchId: WorkflowBranchId } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    const branch = planningBranches(workflow).find((entry) =>
      entry.reviews.some((review) => review.threadId === threadId),
    );
    if (branch) {
      return { workflow, branchId: branch.branchId };
    }
  }
  return null;
}

export function workflowForCodeReviewThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow) || !workflow.implementation) {
      continue;
    }
    if (workflow.implementation.codeReviews.some((review) => review.threadId === threadId)) {
      return { workflow };
    }
  }
  return null;
}

export function workflowForImplementationThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    if (workflow.implementation?.threadId === threadId) {
      return { workflow };
    }
  }
  return null;
}

export function workflowForMergeThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    if (workflow.merge.threadId === threadId) {
      return { workflow };
    }
  }
  return null;
}

/**
 * The model that writes a review of `reviewedId`'s plan. A reviewer id with no branch is an
 * invariant error on that review; another model is never substituted.
 */
export function planReviewerSlot(
  workflow: PlanningWorkflow,
  reviewedId: WorkflowBranchId,
  review: Pick<WorkflowReview, "slot" | "reviewerBranchId">,
): WorkflowModelSlot {
  return requirePlanningBranch(workflow, planReviewReviewerBranchId(workflow, reviewedId, review))
    .authorSlot;
}

/** A plan review the launcher has decided to run, before its turn is dispatched. */
export interface PlanReviewIntent {
  readonly slot: WorkflowReviewSlot;
  readonly threadId: ThreadId;
  /** Persisted only on runs with more than two authors. */
  readonly reviewerBranchId?: WorkflowBranchId | undefined;
}

/** Records every expected review as `pending` in one write, before any dispatch. */
export function markReviewsRequested(
  workflow: PlanningWorkflow,
  input: {
    readonly reviews: ReadonlyMap<WorkflowBranchId, ReadonlyArray<PlanReviewIntent>>;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  let next = workflow;
  for (const branch of planningBranches(workflow)) {
    next = updatePlanningBranch(next, branch.branchId, (current) => ({
      ...current,
      reviews: (input.reviews.get(branch.branchId) ?? []).map(
        (review): WorkflowReview => ({
          slot: review.slot,
          ...(review.reviewerBranchId ? { reviewerBranchId: review.reviewerBranchId } : {}),
          threadId: review.threadId,
          outputFilePath: null,
          status: "pending",
          error: null,
          retryCount: 0,
          pinnedTurnId: null,
          pinnedAssistantMessageId: null,
          lastRetryAt: null,
          updatedAt: input.updatedAt,
        }),
      ),
      status: "reviews_requested",
      error: null,
      errorStage: null,
      updatedAt: input.updatedAt,
    }));
  }
  return { ...next, updatedAt: input.updatedAt };
}

export function markReviewCompleted(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  threadId: ThreadId,
  updatedAt: string,
  turnId: TurnId,
  assistantMessageId: string,
): PlanningWorkflow {
  const reviewedBranch = requirePlanningBranch(workflow, branchId);
  const review = reviewedBranch.reviews.find((entry) => entry.threadId === threadId);
  if (
    (reviewedBranch.status !== "reviews_requested" &&
      planningWorkflowBranchFailureStage(reviewedBranch) !== "reviews") ||
    (review?.status !== "running" && review?.status !== "error")
  ) {
    return workflow;
  }

  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => {
      const reviews = branch.reviews.map((entry) =>
        entry.threadId === threadId
          ? {
              ...entry,
              status: "completed" as const,
              error: null,
              pinnedTurnId: turnId,
              pinnedAssistantMessageId: assistantMessageId,
              updatedAt,
            }
          : entry,
      );
      // Every expected review record exists from the start, so all-completed means every edge.
      const complete = reviews.length > 0 && reviews.every((entry) => entry.status === "completed");
      return {
        ...branch,
        reviews,
        status: complete ? "reviews_saved" : "reviews_requested",
        error: null,
        errorStage: null,
        updatedAt,
      };
    }),
    updatedAt,
  };
}

export function markPlanningReviewError(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  threadId: ThreadId,
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  const branch = requirePlanningBranch(workflow, branchId);
  const review = branch.reviews.find((entry) => entry.threadId === threadId);
  // Only a running attempt can fail this way: a review requeued as pending hasn't started, and
  // an error from its previous attempt must not fail it (admission failures use `writeReview`).
  if (branch.status !== "reviews_requested" || review?.status !== "running") {
    return workflow;
  }

  return {
    ...updatePlanningBranch(workflow, branchId, (current) => ({
      ...current,
      reviews: current.reviews.map((entry) =>
        entry.threadId === threadId
          ? {
              ...entry,
              status: "error" as const,
              error,
              updatedAt,
            }
          : entry,
      ),
      status: "reviews_requested",
      error: null,
      errorStage: null,
      updatedAt,
    })),
    updatedAt,
  };
}

export function markBranchRevising(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      status: "revising",
      error: null,
      errorStage: null,
      updatedAt,
    })),
    updatedAt,
  };
}

export function markBranchRevised(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  input: {
    readonly turnId: string | null;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      status: "revised",
      revisionTurnId: input.turnId ?? branch.revisionTurnId,
      error: null,
      errorStage: null,
      updatedAt: input.updatedAt,
    })),
    updatedAt: input.updatedAt,
  };
}

export function markMergeStarted(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    merge: {
      ...workflow.merge,
      threadId,
      status: "in_progress",
      error: null,
      updatedAt,
    },
    updatedAt,
  };
}

export function markMergeError(
  workflow: PlanningWorkflow,
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    merge: {
      ...workflow.merge,
      status: "error",
      error,
      updatedAt,
    },
    updatedAt,
  };
}

export function markMergeReadyForManualReview(
  workflow: PlanningWorkflow,
  input: {
    readonly turnId: string | null;
    readonly updatedAt: string;
    readonly outputFilePath?: string | null;
    readonly approvedPlanId?: string | null;
  },
): PlanningWorkflow {
  return {
    ...workflow,
    merge: {
      ...workflow.merge,
      turnId: input.turnId ?? workflow.merge.turnId,
      outputFilePath: input.outputFilePath ?? workflow.merge.outputFilePath,
      approvedPlanId: workflow.merge.approvedPlanId ?? input.approvedPlanId ?? null,
      status: "manual_review",
      error: null,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}

export function repinManualReviewApprovedPlan(
  workflow: PlanningWorkflow,
  input: {
    readonly proposedPlanId: typeof OrchestrationProposedPlanId.Type;
    readonly turnId: string | null;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...workflow,
    merge: {
      ...workflow.merge,
      // In manual review, refinements replace the approved merged plan, so this
      // turn id follows the turn that produced the currently approved plan.
      turnId: input.turnId ?? workflow.merge.turnId,
      approvedPlanId: input.proposedPlanId,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}

export function markImplementationDone(
  workflow: PlanningWorkflow,
  turnId: string | null,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          implementationTurnId: turnId ?? workflow.implementation.implementationTurnId,
          status: "implemented",
          error: null,
          errorStage: null,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

export function markCodeReviewsRequested(
  workflow: PlanningWorkflow,
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewerSlot: WorkflowModelSlot;
    readonly threadId: ThreadId;
  }>,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          codeReviews: reviews.map((review) => ({
            reviewerLabel: review.reviewerLabel,
            reviewerSlot: review.reviewerSlot,
            threadId: review.threadId,
            status: "pending" as const,
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt,
          })),
          status: "code_reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

export function markCodeReviewsRunning(
  workflow: PlanningWorkflow,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.implementation) return workflow;
  return {
    ...workflow,
    implementation: {
      ...workflow.implementation,
      codeReviews: workflow.implementation.codeReviews.map((review) => ({
        ...review,
        status: review.status === "pending" ? ("running" as const) : review.status,
        updatedAt,
      })),
      updatedAt,
    },
    updatedAt,
  };
}

export function markCodeReviewCompleted(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
  turn: NonNullable<ReturnType<typeof getFinishedConsumableLatestTurn>>,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.implementation) {
    return workflow;
  }

  const nextReviews = workflow.implementation.codeReviews.map((review) =>
    review.threadId === threadId
      ? {
          ...review,
          status: "completed" as const,
          error: null,
          pinnedTurnId: turn.turnId,
          pinnedAssistantMessageId: turn.assistantMessageId,
          updatedAt,
        }
      : review,
  );
  const allDone =
    nextReviews.length > 0 && nextReviews.every((review) => review.status === "completed");

  return {
    ...workflow,
    implementation: {
      ...workflow.implementation,
      codeReviews: nextReviews,
      status: allDone ? "code_reviews_saved" : workflow.implementation.status,
      error: allDone ? null : workflow.implementation.error,
      updatedAt,
    },
    updatedAt,
  };
}

export function markImplementationApplyingReviews(
  workflow: PlanningWorkflow,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          status: "applying_reviews",
          error: null,
          errorStage: null,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

export function hasMisattributedRevision(workflow: PlanningWorkflow): boolean {
  const implementation = workflow.implementation;
  return (
    implementation?.status === "completed" &&
    implementation.revisionTurnId !== null &&
    implementation.revisionTurnId === implementation.implementationTurnId
  );
}

export function isApplyReviewsLifecycle(workflow: PlanningWorkflow): boolean {
  const implementation = workflow.implementation;
  return Boolean(
    implementation &&
    (hasMisattributedRevision(workflow) ||
      implementation.status === "code_reviews_saved" ||
      implementation.status === "applying_reviews" ||
      implementation.revisionDispatchCommandId ||
      implementation.revisionAttempt !== undefined ||
      (implementation.status === "error" &&
        (implementation.errorStage === "apply-feedback" ||
          (implementation.codeReviews.length > 0 &&
            implementation.codeReviews.every((review) => review.status === "completed"))))),
  );
}

export function markImplementationCompleted(
  workflow: PlanningWorkflow,
  revisionTurnId: string | null,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          revisionTurnId: revisionTurnId ?? workflow.implementation.revisionTurnId,
          status: "completed",
          error: null,
          errorStage: null,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

export function markImplementationError(
  workflow: PlanningWorkflow,
  error: string,
  updatedAt: string,
  errorStage: NonNullable<PlanningWorkflow["implementation"]>["errorStage"] = "implementation",
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          status: "error",
          error,
          errorStage,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

export function markCodeReviewError(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.implementation) {
    return workflow;
  }

  return {
    ...workflow,
    implementation: {
      ...workflow.implementation,
      codeReviews: workflow.implementation.codeReviews.map((review) =>
        review.threadId === threadId
          ? {
              ...review,
              status: "error" as const,
              error,
              updatedAt,
            }
          : review,
      ),
      status: "error",
      error,
      errorStage: "reviewer",
      updatedAt,
    },
    updatedAt,
  };
}

export function incrementBranchRetryCount(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...updatePlanningBranch(workflow, branchId, (branch) => ({
      ...branch,
      retryCount: branch.retryCount + 1,
      lastRetryAt: updatedAt,
      updatedAt,
    })),
    updatedAt,
  };
}

export function incrementPlanningReviewRetryCount(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  threadId: ThreadId,
  updatedAt: string,
): PlanningWorkflow {
  const updateBranch = (branch: WorkflowBranch): WorkflowBranch => ({
    ...branch,
    reviews: branch.reviews.map((review) =>
      review.threadId === threadId
        ? {
            ...review,
            status: "running" as const,
            error: null,
            retryCount: review.retryCount + 1,
            lastRetryAt: updatedAt,
            updatedAt,
          }
        : review,
    ),
    status: "reviews_requested",
    error: null,
    errorStage: null,
    updatedAt,
  });

  return { ...updatePlanningBranch(workflow, branchId, updateBranch), updatedAt };
}

export function incrementImplementationRetryCount(
  workflow: PlanningWorkflow,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.implementation) {
    return workflow;
  }

  return {
    ...workflow,
    implementation: {
      ...workflow.implementation,
      retryCount: workflow.implementation.retryCount + 1,
      lastRetryAt: updatedAt,
      updatedAt,
    },
    updatedAt,
  };
}

export function incrementCodeReviewRetryCount(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
  updatedAt: string,
): PlanningWorkflow {
  if (!workflow.implementation) {
    return workflow;
  }

  return {
    ...workflow,
    implementation: {
      ...workflow.implementation,
      codeReviews: workflow.implementation.codeReviews.map((review) =>
        review.threadId === threadId
          ? {
              ...review,
              retryCount: review.retryCount + 1,
              lastRetryAt: updatedAt,
              updatedAt,
            }
          : review,
      ),
      updatedAt,
    },
    updatedAt,
  };
}

export function latestMarkdownFileChangePath(
  thread: {
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly turnId: TurnId | null;
      readonly payload: unknown;
    }>;
  },
  turnId: TurnId,
): string | null {
  for (const activity of thread.activities.toReversed()) {
    if (activity.kind !== "tool.completed" || activity.turnId !== turnId) {
      continue;
    }
    const payload = readToolActivityPayload(activity.payload);
    if (!payload || payload.itemType !== "file_change" || !payload.changedFiles) {
      continue;
    }
    for (let index = payload.changedFiles.length - 1; index >= 0; index -= 1) {
      const path = payload.changedFiles[index];
      if (path && path.trim().toLowerCase().endsWith(".md")) {
        return path.trim();
      }
    }
  }
  return null;
}

export function hasProposedPlanForTurn(
  thread: {
    readonly proposedPlans: ReadonlyArray<{
      readonly turnId: TurnId | null;
    }>;
  },
  turnId: TurnId,
): boolean {
  return thread.proposedPlans.some((plan) => plan.turnId === turnId);
}

// Review thread ids are derived from the draft turn they reviewed, so the
// reviewed draft stays recoverable even if `planTurnId` was later overwritten.
export function reviewedPlanTurnIdForBranch(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  branch: WorkflowBranch,
  snapshot: OrchestrationReadModel,
): TurnId | null {
  if (branch.reviews.length === 0) return null;
  const thread = snapshot.threads.find((entry) => entry.id === branch.authorThreadId);
  if (!thread) return null;
  for (const plan of thread.proposedPlans) {
    const turnId = plan.turnId;
    if (
      turnId &&
      branch.reviews.every(
        (review) => review.threadId === planReviewThreadId(workflow, branchId, review, turnId),
      )
    )
      return turnId;
  }
  return null;
}

export function planOverBudgetMessage(
  workflow: PlanningWorkflow,
  renderedChars: number,
  maxPlanChars: number,
): string {
  return `The ${planningWorkflowDocumentType(workflow) ? "document" : "plan"} takes ${renderedChars.toLocaleString("en-US")} characters in the merge; this run allows at most ${maxPlanChars.toLocaleString("en-US")} characters per author so every plan fits. Submit a shorter complete version.`;
}

export function validateCapturedPlanForTurn(input: {
  readonly workflow: PlanningWorkflow;
  readonly provider: WorkflowModelSlot["provider"];
  readonly thread: Pick<
    OrchestrationReadModel["threads"][number],
    "latestTurn" | "messages" | "session" | "proposedPlans"
  >;
  readonly turnId: TurnId;
  /**
   * Author and revision captures on runs with more than two authors must stay under the
   * per-plan budget (`workflowPlanCharBudget`); merge captures pass nothing.
   */
  readonly maxPlanChars?: number | null | undefined;
  /** The author whose plan is measured against `maxPlanChars` as the merge renders it. */
  readonly branchId?: WorkflowBranchId | undefined;
}):
  | { readonly valid: true }
  | { readonly valid: false; readonly error: string; readonly overBudget?: true } {
  const plan = input.thread.proposedPlans.find((candidate) => candidate.turnId === input.turnId);
  const renderedChars =
    input.maxPlanChars != null && plan
      ? input.branchId
        ? workflowPlanMergeChars(input.workflow, input.branchId, plan.planMarkdown, input.turnId)
        : plan.planMarkdown.length
      : null;
  if (input.maxPlanChars != null && renderedChars !== null && renderedChars > input.maxPlanChars) {
    return {
      valid: false,
      overBudget: true,
      error: planOverBudgetMessage(input.workflow, renderedChars, input.maxPlanChars),
    };
  }
  const behavior = resolveWorkflowBehavior({
    runKind: "planning",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
  const documentType = planningWorkflowDocumentType(input.workflow);
  if (documentType) {
    const finished = getFinishedConsumableLatestTurn(input.thread);
    const candidate =
      plan?.planMarkdown ?? (finished?.turnId === input.turnId ? finished.assistantText : "") ?? "";
    const result = validateDocumentArtifact(candidate, documentType, "capture");
    return result.valid && plan
      ? { valid: true }
      : { valid: false, error: result.valid ? "No document was captured." : result.reason };
  }
  if (!behavior.strictPlanCapture) {
    return plan ? { valid: true } : { valid: false, error: "No proposed plan was captured." };
  }

  const capture = behavior.planCaptureForProvider(input.provider);
  if (capture === "unsupported") {
    return {
      valid: false,
      error: `Provider '${input.provider}' does not support strict plan capture.`,
    };
  }
  if (!plan?.planMarkdown.trim()) {
    return { valid: false, error: "No non-empty proposed plan record was captured." };
  }
  // Provider plan events (including ExitPlanMode) are already explicit captures.
  // Text synthesis below validates the wrapper before creating such a record.
  return { valid: true };
}

export function compareWorkflowReviewSlots(
  left: WorkflowReviewSlot,
  right: WorkflowReviewSlot,
): number {
  const leftRank = left === "cross" ? 0 : 1;
  const rightRank = right === "cross" ? 0 : 1;
  return leftRank - rightRank;
}

// `mergeThread.proposedPlans` comes from the retention-capped read model
// (MAX_THREAD_PROPOSED_PLANS). This is safe because a "Merge" thread is an
// ephemeral, single-purpose workflow thread that produces on the order of one
// proposed plan, far below the cap, so the pinned `approvedPlanId` is always
// retained. The `.at(-1)` fallback additionally returns the most recent plan
// (the merge plan) if the pinned id is ever absent.
export function resolveApprovedMergedPlan(
  workflow: PlanningWorkflow,
  mergeThread: {
    readonly proposedPlans: ReadonlyArray<{
      readonly id: typeof OrchestrationProposedPlanId.Type;
      readonly planMarkdown: string;
    }>;
  },
) {
  if (workflow.merge.approvedPlanId) {
    const pinned = mergeThread.proposedPlans.find(
      (plan) => plan.id === workflow.merge.approvedPlanId,
    );
    if (pinned) {
      return pinned;
    }
  }
  return mergeThread.proposedPlans.at(-1) ?? null;
}

function latestUnimplementedMergedPlan(mergeThread: {
  readonly proposedPlans: ReadonlyArray<{
    readonly id: typeof OrchestrationProposedPlanId.Type;
    readonly turnId: TurnId | null;
    readonly planMarkdown: string;
    readonly implementedAt: string | null;
    readonly updatedAt: string;
  }>;
}) {
  for (let index = mergeThread.proposedPlans.length - 1; index >= 0; index -= 1) {
    const plan = mergeThread.proposedPlans[index];
    if (plan && plan.implementedAt === null) {
      return plan;
    }
  }
  return null;
}

export function resolveMergedPlanForImplementation(
  workflow: PlanningWorkflow,
  mergeThread: {
    readonly proposedPlans: ReadonlyArray<{
      readonly id: typeof OrchestrationProposedPlanId.Type;
      readonly turnId: TurnId | null;
      readonly planMarkdown: string;
      readonly implementedAt: string | null;
      readonly updatedAt: string;
    }>;
  },
  updatedAt: string,
): {
  readonly workflow: PlanningWorkflow;
  readonly mergedPlan: {
    readonly id: typeof OrchestrationProposedPlanId.Type;
    readonly planMarkdown: string;
  } | null;
  readonly repinned: boolean;
} {
  const latestPlan = latestUnimplementedMergedPlan(mergeThread);
  if (
    latestPlan &&
    latestPlan.id !== workflow.merge.approvedPlanId &&
    Date.parse(latestPlan.updatedAt) > Date.parse(workflow.merge.updatedAt)
  ) {
    return {
      workflow: repinManualReviewApprovedPlan(workflow, {
        proposedPlanId: latestPlan.id,
        turnId: latestPlan.turnId,
        updatedAt,
      }),
      mergedPlan: latestPlan,
      repinned: true,
    };
  }

  return {
    workflow,
    mergedPlan: resolveApprovedMergedPlan(workflow, mergeThread),
    repinned: false,
  };
}

/** Every branch's revised plan as merge input, in author order. */
function workflowMergePlanInputs(
  workflow: PlanningWorkflow,
  plans: ReadonlyArray<string>,
  options?: { readonly includeTurnIds?: boolean },
): MergePlanInput[] {
  return planningBranches(workflow).map((branch, index) => ({
    label: workflowParticipantLabel(branch.branchId),
    markdown: plans[index] ?? "",
    source: {
      workflowId: workflow.id,
      stage: `revision-${branch.branchId}`,
      ...(options?.includeTurnIds !== false && branch.revisionTurnId
        ? { turnId: branch.revisionTurnId }
        : {}),
    },
    model: branch.authorSlot,
  }));
}

export function buildWorkflowMergePrompt(
  workflow: PlanningWorkflow,
  plans: ReadonlyArray<string>,
  retry?: WorkflowRetryContext,
  options?: { readonly includeTurnIds?: boolean },
): string {
  return (isDocumentWorkflow(workflow) ? buildDocumentMergePrompt : buildMergePrompt)({
    workflow,
    plans: workflowMergePlanInputs(workflow, plans, options),
    mergeSlot: workflow.merge.mergeSlot,
    retry,
  });
}

/** Slack for envelope escaping in the revision prompt. */
const REVISION_EXCERPT_MARGIN_CHARS = 1_000;

function revisionExcerptNote(label: string, shown: number, total: number): string {
  return `\n\n[Excerpt: the first ${shown} of ${total} characters of the ${label} review. The rest is not available to you.]`;
}

/**
 * Shares `room` (the rendered limit minus the revision prompt with empty reviews) among the
 * reviews with `allocateArtifactCharBudget`; a review that does not fit whole is cut and marked.
 * `smallestExcerpt` is the smallest share an excerpted review got (`null` when all fit).
 */
export function excerptRevisionReviews<
  T extends { readonly reviewerLabel: string; readonly reviewMarkdown: string },
>(
  reviews: ReadonlyArray<T>,
  room: number,
): { readonly reviews: ReadonlyArray<T>; readonly smallestExcerpt: number | null } {
  // A note names its review's label, so its room is measured; `shown` never has more digits
  // than `total`.
  const noteReserve = reviews.reduce((sum, review) => {
    const total = review.reviewMarkdown.length;
    return sum + revisionExcerptNote(review.reviewerLabel, total, total).length;
  }, 0);
  const { allowances, smallestExcerpt } = allocateArtifactCharBudget(
    reviews.map((review) => review.reviewMarkdown.length),
    room - REVISION_EXCERPT_MARGIN_CHARS - noteReserve,
  );
  return {
    reviews: reviews.map((review, index) => {
      const allowance = allowances[index]!;
      const total = review.reviewMarkdown.length;
      return allowance >= total
        ? review
        : {
            ...review,
            reviewMarkdown: `${review.reviewMarkdown.slice(0, allowance)}${revisionExcerptNote(review.reviewerLabel, allowance, total)}`,
          };
    }),
    smallestExcerpt,
  };
}

/**
 * Per-plan length limit on runs with more than two authors, so every revised plan fits in the
 * merge prompt: the rendered limit minus the merge prompt with empty plans and a 1,000-character
 * margin, shared evenly. Two-author runs have no limit (`null`).
 */
export function workflowPlanCharBudget(workflow: PlanningWorkflow): number | null {
  const count = planningBranches(workflow).length;
  if (!workflowUsesMesh(count)) return null;
  const emptyMergePrompt = buildWorkflowMergePrompt(
    workflow,
    Array.from({ length: count }, () => ""),
    undefined,
    { includeTurnIds: false },
  );
  return Math.floor(
    (WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT - emptyMergePrompt.length - 1_000) / count,
  );
}

/**
 * The characters a plan adds to the merge prompt as the merge renders it. Document drafts are
 * normalized, their envelope terminators escaped and their source turn named, so the raw length
 * can understate it. The baseline is the merge prompt with every plan empty and no turn ids, the
 * same one `workflowPlanCharBudget` subtracts, so plans that each fit their share fit together.
 */
export function workflowPlanMergeChars(
  workflow: PlanningWorkflow,
  branchId: WorkflowBranchId,
  planMarkdown: string,
  turnId: string | null,
): number {
  const branches = planningBranches(workflow);
  const measured = updatePlanningBranch(workflow, branchId, (branch) => ({
    ...branch,
    revisionTurnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
  }));
  const withPlan = buildWorkflowMergePrompt(
    measured,
    branches.map((branch) => (branch.branchId === branchId ? planMarkdown : "")),
  ).length;
  const withoutPlan = buildWorkflowMergePrompt(
    measured,
    branches.map(() => ""),
    undefined,
    { includeTurnIds: false },
  ).length;
  return withPlan - withoutPlan;
}

export interface ReplacementPlanCandidate {
  readonly planMarkdown: string;
  readonly turnId: TurnId | null;
}

/** Accepts a replacement plan only when it fits the per-plan budget as the merge renders it. */
export function planReplacementFilter(workflow: PlanningWorkflow, branchId: WorkflowBranchId) {
  const budget = workflowPlanCharBudget(workflow);
  return (plan: ReplacementPlanCandidate) =>
    budget === null ||
    workflowPlanMergeChars(workflow, branchId, plan.planMarkdown, plan.turnId) <= budget;
}

/** Stable plan-review thread id; mesh runs add the reviewer so every edge gets its own thread. */
export function planReviewThreadId(
  workflow: PlanningWorkflow,
  reviewedId: WorkflowBranchId,
  review: {
    readonly slot: WorkflowReviewSlot;
    readonly reviewerBranchId?: WorkflowBranchId | undefined;
  },
  planTurnId: string,
): ThreadId {
  return ThreadId.makeUnsafe(
    workflowUsesMesh(planningBranches(workflow).length)
      ? stableWorkflowUuid(
          "plan-review-thread",
          workflow.id,
          reviewedId,
          review.slot,
          planTurnId,
          planReviewReviewerBranchId(workflow, reviewedId, review),
        )
      : stableWorkflowUuid("plan-review-thread", workflow.id, reviewedId, review.slot, planTurnId),
  );
}
