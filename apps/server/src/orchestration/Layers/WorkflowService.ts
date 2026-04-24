import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  type PlanningWorkflow,
  type ProviderInteractionMode,
  ThreadId,
  type TurnId,
  type WorkflowReviewSlot,
} from "@t3tools/contracts";
import { readFile } from "node:fs/promises";
import { Duration, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";

import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkflowService,
  type CreateWorkflowInput,
  type WorkflowServiceShape,
} from "../Services/WorkflowService.ts";
import {
  buildAuthorPrompt,
  buildCodeReviewPrompt,
  buildImplementationPrompt,
  buildImplementationRevisionPrompt,
  buildMergePrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
} from "../workflowPrompts.ts";
import {
  getFinishedConsumableLatestTurn,
  latestAssistantFeedback,
  nextWorkflowSlug,
  slotLabel,
} from "../workflowSharedUtils.ts";

const WORKFLOW_PLANNING_INTERACTION_MODE: ProviderInteractionMode = "plan";
const MAX_AUTO_RETRY_ATTEMPTS = 2;
const AUTO_RETRY_BACKOFF_MS = 5_000;

type WorkflowTitleGenerationWorkItem = {
  readonly workflowId: PlanningWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

function isRetryableSessionError(lastError: string | null): boolean {
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

function formatSessionError(
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

function addUsd(left: number, right: number): number {
  return Number((left + right).toFixed(6));
}

function applyWorkflowTurnCost(
  workflow: PlanningWorkflow,
  turnCostUsd: number | undefined,
  updatedAt: string,
): PlanningWorkflow {
  if (turnCostUsd === undefined || !Number.isFinite(turnCostUsd) || turnCostUsd <= 0) {
    return workflow;
  }

  return {
    ...workflow,
    totalCostUsd: addUsd(workflow.totalCostUsd, turnCostUsd),
    updatedAt,
  };
}

function hasActiveRunningTurn(
  thread: Pick<OrchestrationReadModel["threads"][number], "session"> | null | undefined,
): boolean {
  return thread?.session?.status === "running" && thread.session.activeTurnId !== null;
}

function isSessionUnavailableForReconciliation(
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

function getFinishedLatestTurnId(
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

function resetWorkflowForRetry(workflow: PlanningWorkflow, now: string): PlanningWorkflow {
  const resetBranch = (branch: PlanningWorkflow["branchA"]): PlanningWorkflow["branchA"] => ({
    ...branch,
    planTurnId: branch.status === "error" ? null : branch.planTurnId,
    revisionTurnId: branch.status === "error" ? null : branch.revisionTurnId,
    retryCount: 0,
    lastRetryAt: null,
    reviews: branch.reviews.map((review) =>
      review.status === "error"
        ? {
            ...review,
            status: "pending",
            error: null,
            updatedAt: now,
          }
        : review,
    ),
    status: branch.status === "error" ? "pending" : branch.status,
    error: branch.status === "error" ? null : branch.error,
    updatedAt: now,
  });

  let implementation = workflow.implementation;
  if (implementation) {
    const resetCodeReviews = implementation.codeReviews.map((review) => ({
      ...review,
      retryCount: 0,
      lastRetryAt: null,
      ...(review.status === "error"
        ? {
            status: "pending" as const,
            error: null,
            updatedAt: now,
          }
        : {}),
    }));

    if (implementation.status === "error" && implementation.codeReviews.length === 0) {
      implementation = null;
    } else {
      const hasFailedReviews = implementation.codeReviews.some(
        (review) => review.status === "error",
      );
      if (implementation.status === "error" && hasFailedReviews) {
        implementation = {
          ...implementation,
          codeReviews: resetCodeReviews,
          status: "code_reviews_requested",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        };
      } else if (implementation.status === "error") {
        implementation = {
          ...implementation,
          codeReviews: resetCodeReviews,
          revisionTurnId: null,
          status: "code_reviews_saved",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        };
      } else {
        implementation = {
          ...implementation,
          codeReviews: resetCodeReviews,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        };
      }
    }
  }

  return {
    ...workflow,
    branchA: resetBranch(workflow.branchA),
    branchB: resetBranch(workflow.branchB),
    merge:
      workflow.merge.status === "error"
        ? {
            ...workflow.merge,
            turnId: null,
            status: "not_started",
            error: null,
            updatedAt: now,
          }
        : workflow.merge,
    implementation,
    totalCostUsd: workflow.totalCostUsd,
    updatedAt: now,
  };
}

function buildWorkflowRecord(input: {
  workflowId: PlanningWorkflowId;
  projectId: CreateWorkflowInput["projectId"];
  title: PlanningWorkflow["title"];
  slug: string;
  requirementPrompt: CreateWorkflowInput["requirementPrompt"];
  plansDirectory: string;
  selfReviewEnabled: boolean;
  authorThreadIdA: ThreadId;
  authorThreadIdB: ThreadId;
  branchA: CreateWorkflowInput["branchA"];
  branchB: CreateWorkflowInput["branchB"];
  merge: CreateWorkflowInput["merge"];
  createdAt: string;
}): PlanningWorkflow {
  return {
    id: input.workflowId,
    projectId: input.projectId,
    title: input.title,
    slug: input.slug,
    requirementPrompt: input.requirementPrompt,
    plansDirectory: input.plansDirectory,
    selfReviewEnabled: input.selfReviewEnabled,
    branchA: {
      branchId: "a",
      authorSlot: input.branchA,
      authorThreadId: input.authorThreadIdA,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: input.createdAt,
    },
    branchB: {
      branchId: "b",
      authorSlot: input.branchB,
      authorThreadId: input.authorThreadIdB,
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "pending",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: input.createdAt,
    },
    merge: {
      mergeSlot: input.merge,
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: input.createdAt,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  };
}

function updateAuthoringBranch(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  now: string,
  outcome: { ok: true } | { ok: false; error: string },
): PlanningWorkflow {
  const nextBranch =
    branchId === "a"
      ? {
          ...workflow.branchA,
          status: outcome.ok ? ("authoring" as const) : ("error" as const),
          error: outcome.ok ? null : outcome.error,
          updatedAt: now,
        }
      : {
          ...workflow.branchB,
          status: outcome.ok ? ("authoring" as const) : ("error" as const),
          error: outcome.ok ? null : outcome.error,
          updatedAt: now,
        };

  return {
    ...workflow,
    branchA: branchId === "a" ? nextBranch : workflow.branchA,
    branchB: branchId === "b" ? nextBranch : workflow.branchB,
    updatedAt: now,
  };
}

function labelForThread(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; label: string } | null {
  if (workflow.branchA.authorThreadId === threadId) {
    return { workflow, label: "Branch A authoring" };
  }
  if (workflow.branchB.authorThreadId === threadId) {
    return { workflow, label: "Branch B authoring" };
  }
  for (const review of workflow.branchA.reviews) {
    if (review.threadId === threadId) {
      return { workflow, label: `Branch A ${review.slot} review` };
    }
  }
  for (const review of workflow.branchB.reviews) {
    if (review.threadId === threadId) {
      return { workflow, label: `Branch B ${review.slot} review` };
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

function workflowForAuthorThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; branchId: "a" | "b" } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    if (workflow.branchA.authorThreadId === threadId) {
      return { workflow, branchId: "a" };
    }
    if (workflow.branchB.authorThreadId === threadId) {
      return { workflow, branchId: "b" };
    }
  }
  return null;
}

function markBranchPlanSaved(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  input: {
    readonly turnId: string | null;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  const nextBranch =
    branchId === "a"
      ? {
          ...workflow.branchA,
          status: "plan_saved" as const,
          planTurnId: input.turnId ?? workflow.branchA.planTurnId,
          error: null,
          updatedAt: input.updatedAt,
        }
      : {
          ...workflow.branchB,
          status: "plan_saved" as const,
          planTurnId: input.turnId ?? workflow.branchB.planTurnId,
          error: null,
          updatedAt: input.updatedAt,
        };

  return {
    ...workflow,
    branchA: branchId === "a" ? nextBranch : workflow.branchA,
    branchB: branchId === "b" ? nextBranch : workflow.branchB,
    updatedAt: input.updatedAt,
  };
}

function markBranchError(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  input: {
    readonly error: string;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  const nextBranch =
    branchId === "a"
      ? {
          ...workflow.branchA,
          status: "error" as const,
          error: input.error,
          updatedAt: input.updatedAt,
        }
      : {
          ...workflow.branchB,
          status: "error" as const,
          error: input.error,
          updatedAt: input.updatedAt,
        };

  return {
    ...workflow,
    branchA: branchId === "a" ? nextBranch : workflow.branchA,
    branchB: branchId === "b" ? nextBranch : workflow.branchB,
    updatedAt: input.updatedAt,
  };
}

function workflowForReviewThread(
  workflows: ReadonlyArray<PlanningWorkflow>,
  threadId: ThreadId,
): { workflow: PlanningWorkflow; branchId: "a" | "b" } | null {
  for (const workflow of workflows) {
    if (isDeletedWorkflow(workflow)) {
      continue;
    }
    if (workflow.branchA.reviews.some((review) => review.threadId === threadId)) {
      return { workflow, branchId: "a" };
    }
    if (workflow.branchB.reviews.some((review) => review.threadId === threadId)) {
      return { workflow, branchId: "b" };
    }
  }
  return null;
}

function workflowForCodeReviewThread(
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

function workflowForImplementationThread(
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

function workflowForMergeThread(
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

function markReviewsRequested(
  workflow: PlanningWorkflow,
  input: {
    readonly branchAReviews: ReadonlyArray<{
      readonly slot: WorkflowReviewSlot;
      readonly threadId: ThreadId;
    }>;
    readonly branchBReviews: ReadonlyArray<{
      readonly slot: WorkflowReviewSlot;
      readonly threadId: ThreadId;
    }>;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...workflow,
    branchA: {
      ...workflow.branchA,
      reviews: input.branchAReviews.map((review) => ({
        slot: review.slot,
        threadId: review.threadId,
        outputFilePath: null,
        status: "running" as const,
        error: null,
        updatedAt: input.updatedAt,
      })),
      status: "reviews_requested",
      updatedAt: input.updatedAt,
    },
    branchB: {
      ...workflow.branchB,
      reviews: input.branchBReviews.map((review) => ({
        slot: review.slot,
        threadId: review.threadId,
        outputFilePath: null,
        status: "running" as const,
        error: null,
        updatedAt: input.updatedAt,
      })),
      status: "reviews_requested",
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}

function markReviewCompleted(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  threadId: ThreadId,
  updatedAt: string,
): PlanningWorkflow {
  const completeReview = (review: PlanningWorkflow["branchA"]["reviews"][number]) =>
    review.threadId === threadId
      ? {
          ...review,
          status: "completed" as const,
          error: null,
          updatedAt,
        }
      : review;

  const branchA =
    branchId === "a"
      ? {
          ...workflow.branchA,
          reviews: workflow.branchA.reviews.map(completeReview),
          updatedAt,
        }
      : workflow.branchA;
  const branchB =
    branchId === "b"
      ? {
          ...workflow.branchB,
          reviews: workflow.branchB.reviews.map(completeReview),
          updatedAt,
        }
      : workflow.branchB;
  const branchAComplete =
    branchA.reviews.length > 0 && branchA.reviews.every((review) => review.status === "completed");
  const branchBComplete =
    branchB.reviews.length > 0 && branchB.reviews.every((review) => review.status === "completed");

  return {
    ...workflow,
    branchA: {
      ...branchA,
      status: branchAComplete ? "reviews_saved" : branchA.status,
    },
    branchB: {
      ...branchB,
      status: branchBComplete ? "reviews_saved" : branchB.status,
    },
    updatedAt,
  };
}

function markBranchRevising(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    branchA:
      branchId === "a"
        ? {
            ...workflow.branchA,
            status: "revising",
            error: null,
            updatedAt,
          }
        : workflow.branchA,
    branchB:
      branchId === "b"
        ? {
            ...workflow.branchB,
            status: "revising",
            error: null,
            updatedAt,
          }
        : workflow.branchB,
    updatedAt,
  };
}

function markBranchRevised(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  input: {
    readonly turnId: string | null;
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  return {
    ...workflow,
    branchA:
      branchId === "a"
        ? {
            ...workflow.branchA,
            status: "revised",
            revisionTurnId: input.turnId ?? workflow.branchA.revisionTurnId,
            error: null,
            updatedAt: input.updatedAt,
          }
        : workflow.branchA,
    branchB:
      branchId === "b"
        ? {
            ...workflow.branchB,
            status: "revised",
            revisionTurnId: input.turnId ?? workflow.branchB.revisionTurnId,
            error: null,
            updatedAt: input.updatedAt,
          }
        : workflow.branchB,
    updatedAt: input.updatedAt,
  };
}

function markMergeStarted(
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

function markMergeError(
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

function markMergeReadyForManualReview(
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

function markImplementationDone(
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
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

function markCodeReviewsRequested(
  workflow: PlanningWorkflow,
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
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
            status: "running" as const,
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt,
          })),
          status: "code_reviews_requested",
          error: null,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

function markCodeReviewCompleted(
  workflow: PlanningWorkflow,
  threadId: ThreadId,
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

function markImplementationApplyingReviews(
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
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

function markImplementationCompleted(
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
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

function markImplementationError(
  workflow: PlanningWorkflow,
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  return {
    ...workflow,
    implementation: workflow.implementation
      ? {
          ...workflow.implementation,
          status: "error",
          error,
          updatedAt,
        }
      : workflow.implementation,
    updatedAt,
  };
}

function markCodeReviewError(
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
      updatedAt,
    },
    updatedAt,
  };
}

function incrementBranchRetryCount(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  updatedAt: string,
): PlanningWorkflow {
  const nextBranch =
    branchId === "a"
      ? {
          ...workflow.branchA,
          retryCount: workflow.branchA.retryCount + 1,
          lastRetryAt: updatedAt,
          updatedAt,
        }
      : {
          ...workflow.branchB,
          retryCount: workflow.branchB.retryCount + 1,
          lastRetryAt: updatedAt,
          updatedAt,
        };

  return {
    ...workflow,
    branchA: branchId === "a" ? nextBranch : workflow.branchA,
    branchB: branchId === "b" ? nextBranch : workflow.branchB,
    updatedAt,
  };
}

function incrementImplementationRetryCount(
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

function incrementCodeReviewRetryCount(
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

function latestMarkdownFileChangePath(
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

function hasProposedPlanForTurn(
  thread: {
    readonly proposedPlans: ReadonlyArray<{
      readonly turnId: TurnId | null;
    }>;
  },
  turnId: TurnId,
): boolean {
  return thread.proposedPlans.some((plan) => plan.turnId === turnId);
}

function compareWorkflowReviewSlots(left: WorkflowReviewSlot, right: WorkflowReviewSlot): number {
  const leftRank = left === "cross" ? 0 : 1;
  const rightRank = right === "cross" ? 0 : 1;
  return leftRank - rightRank;
}

function resolveApprovedMergedPlan(
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

export const makeWorkflowService = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;
  const gitCore = yield* GitCore;

  const upsertWorkflow = (workflow: PlanningWorkflow) =>
    orchestrationEngine.dispatch({
      type: "project.workflow.upsert",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      projectId: workflow.projectId,
      workflow,
      createdAt: workflow.updatedAt,
    });

  const forkAutoRetry = (input: {
    readonly kind: "authoring" | "implementation" | "code_review";
    readonly workflowId: PlanningWorkflowId;
    readonly threadId: ThreadId;
    readonly buildDispatch: (input: {
      readonly workflow: PlanningWorkflow;
      readonly snapshot: OrchestrationReadModel;
    }) => ReturnType<OrchestrationEngineShape["dispatch"]> | null;
  }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(AUTO_RETRY_BACKOFF_MS));
      const snapshot = yield* snapshotQuery.getSnapshot();
      const workflow =
        snapshot.planningWorkflows.find(
          (entry) =>
            entry.id === input.workflowId &&
            !isDeletedWorkflow(entry) &&
            !isArchivedWorkflow(entry),
        ) ?? null;
      if (!workflow) {
        return;
      }

      const dispatch = input.buildDispatch({ workflow, snapshot });
      if (!dispatch) {
        return;
      }

      yield* dispatch;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.autoRetryDispatch failed", {
          kind: input.kind,
          workflowId: input.workflowId,
          threadId: input.threadId,
          cause,
        }),
      ),
      Effect.forkScoped,
    );

  const titleGenerationWorker = yield* makeDrainableWorker(
    (item: WorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshotQuery.getSnapshot();
        const workflow =
          snapshot.planningWorkflows.find(
            (entry) => entry.id === item.workflowId && !isDeletedWorkflow(entry),
          ) ?? null;
        if (!workflow || workflow.title !== item.expectedCurrentTitle) {
          return;
        }

        const cwd =
          snapshot.projects.find(
            (project) => project.id === workflow.projectId && project.deletedAt === null,
          )?.workspaceRoot ?? null;
        const title = yield* resolveBestEffortGeneratedTitle({
          cwd,
          titleSourceText: item.titleSourceText,
          attachments: [],
          titleGenerationModel: item.titleGenerationModel,
          defaultTitle: item.defaultTitle,
          textGeneration,
          logPrefix: "workflow service",
          logContext: {
            workflowId: item.workflowId,
          },
        });
        if (title === workflow.title) {
          return;
        }

        const latestSnapshot = yield* snapshotQuery.getSnapshot();
        const latestWorkflow =
          latestSnapshot.planningWorkflows.find(
            (entry) => entry.id === item.workflowId && !isDeletedWorkflow(entry),
          ) ?? null;
        if (!latestWorkflow || latestWorkflow.title !== item.expectedCurrentTitle) {
          return;
        }

        const updatedAt = new Date().toISOString();
        yield* upsertWorkflow({
          ...latestWorkflow,
          title,
          updatedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.titleGenerationWorker failed", {
            workflowId: item.workflowId,
            cause,
          }),
        ),
      ),
  );

  const maybeSynthesizeProposedPlan = (input: {
    readonly thread: Pick<
      OrchestrationReadModel["threads"][number],
      "id" | "latestTurn" | "messages" | "session" | "proposedPlans" | "activities"
    >;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (hasProposedPlanForTurn(input.thread, input.turnId)) {
        return false;
      }

      const latestCompletedTurn = getFinishedConsumableLatestTurn(input.thread);
      const assistantPlanMarkdown =
        latestCompletedTurn?.turnId === input.turnId ? latestCompletedTurn.assistantText : null;
      const markdownFilePath = latestMarkdownFileChangePath(input.thread, input.turnId);
      const filePlanMarkdown =
        assistantPlanMarkdown === null && markdownFilePath
          ? yield* Effect.tryPromise({
              try: () => readFile(markdownFilePath, "utf8"),
              catch: () => null,
            }).pipe(
              Effect.map((contents) => {
                const trimmed = contents?.trim() ?? "";
                return trimmed.length > 0 ? trimmed : null;
              }),
            )
          : null;
      const planMarkdown = assistantPlanMarkdown ?? filePlanMarkdown;
      if (!planMarkdown) {
        return false;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: input.thread.id,
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe(crypto.randomUUID()),
          turnId: input.turnId,
          planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return true;
    });

  const maybeStartReviews = (
    workflow: PlanningWorkflow,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly proposedPlans: ReadonlyArray<{
          readonly planMarkdown: string;
        }>;
      }>;
    },
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        workflow.branchA.status !== "plan_saved" ||
        workflow.branchB.status !== "plan_saved" ||
        workflow.branchA.reviews.length > 0 ||
        workflow.branchB.reviews.length > 0
      ) {
        return;
      }

      const planA = snapshot.threads
        .find((thread) => thread.id === workflow.branchA.authorThreadId)
        ?.proposedPlans.at(-1)?.planMarkdown;
      const planB = snapshot.threads
        .find((thread) => thread.id === workflow.branchB.authorThreadId)
        ?.proposedPlans.at(-1)?.planMarkdown;
      if (!planA || !planB) {
        return;
      }

      const branchAReviews: Array<{
        slot: WorkflowReviewSlot;
        reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
        planMarkdown: string;
        threadId: ThreadId;
      }> = [
        {
          slot: "cross",
          reviewerSlot: workflow.branchB.authorSlot,
          planMarkdown: planA,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        },
      ];
      if (workflow.selfReviewEnabled) {
        branchAReviews.push({
          slot: "self",
          reviewerSlot: workflow.branchA.authorSlot,
          planMarkdown: planA,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        });
      }
      const branchBReviews: Array<{
        slot: WorkflowReviewSlot;
        reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
        planMarkdown: string;
        threadId: ThreadId;
      }> = [
        {
          slot: "cross",
          reviewerSlot: workflow.branchA.authorSlot,
          planMarkdown: planB,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        },
      ];
      if (workflow.selfReviewEnabled) {
        branchBReviews.push({
          slot: "self",
          reviewerSlot: workflow.branchB.authorSlot,
          planMarkdown: planB,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        });
      }

      yield* Effect.forEach(
        [
          ...branchAReviews.map((review) => ({
            ...review,
            reviewedBranchId: "a" as const,
          })),
          ...branchBReviews.map((review) => ({
            ...review,
            reviewedBranchId: "b" as const,
          })),
        ],
        (review) =>
          createReviewThread({
            orchestrationEngine,
            workflow,
            reviewerSlot: review.reviewerSlot,
            reviewedBranchId: review.reviewedBranchId,
            reviewSlot: review.slot,
            threadId: review.threadId,
            createdAt: updatedAt,
          }).pipe(
            Effect.flatMap(() =>
              startReviewTurn({
                orchestrationEngine,
                workflow,
                reviewerSlot: review.reviewerSlot,
                reviewThreadId: review.threadId,
                planMarkdown: review.planMarkdown,
                reviewKind: review.slot,
                createdAt: updatedAt,
              }),
            ),
          ),
        { discard: true },
      );

      yield* upsertWorkflow(
        markReviewsRequested(workflow, {
          branchAReviews: branchAReviews.map((review) => ({
            slot: review.slot,
            threadId: review.threadId,
          })),
          branchBReviews: branchBReviews.map((review) => ({
            slot: review.slot,
            threadId: review.threadId,
          })),
          updatedAt,
        }),
      );
    });

  const maybeStartRevisions = (
    workflow: PlanningWorkflow,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly latestTurn: { readonly assistantMessageId: string | null } | null;
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
          readonly reasoningText?: string | undefined;
          readonly streaming: boolean;
          readonly createdAt: string;
        }>;
      }>;
    },
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        workflow.branchA.status !== "reviews_saved" ||
        workflow.branchB.status !== "reviews_saved"
      ) {
        return;
      }

      const extractReviewFeedback = (
        review: PlanningWorkflow["branchA"]["reviews"][number],
      ): Effect.Effect<{ reviewerLabel: string; reviewMarkdown: string } | null> =>
        Effect.gen(function* () {
          const thread = snapshot.threads.find((entry) => entry.id === review.threadId);
          const reviewerLabel = `${review.slot} review`;
          const feedback = thread ? latestAssistantFeedback(thread) : null;
          if (!feedback) {
            yield* Effect.logWarning("review yielded empty feedback text", {
              threadId: review.threadId,
              reviewerLabel,
              reviewStatus: review.status,
            });
            return null;
          }
          if (feedback.source !== "text-only") {
            yield* Effect.logDebug("reviewer feedback included reasoning-channel content", {
              threadId: review.threadId,
              reviewerLabel,
              source: feedback.source,
            });
          }
          return { reviewerLabel, reviewMarkdown: feedback.text };
        });

      const branchAReviewTexts = (yield* Effect.forEach(
        workflow.branchA.reviews.toSorted((left, right) =>
          compareWorkflowReviewSlots(left.slot, right.slot),
        ),
        extractReviewFeedback,
      )).filter(
        (review): review is { reviewerLabel: string; reviewMarkdown: string } => review !== null,
      );
      const branchBReviewTexts = (yield* Effect.forEach(
        workflow.branchB.reviews.toSorted((left, right) =>
          compareWorkflowReviewSlots(left.slot, right.slot),
        ),
        extractReviewFeedback,
      )).filter(
        (review): review is { reviewerLabel: string; reviewMarkdown: string } => review !== null,
      );

      if (branchAReviewTexts.length === 0 || branchBReviewTexts.length === 0) {
        return;
      }

      yield* startRevisionTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchA,
        reviews: branchAReviewTexts,
        createdAt: updatedAt,
      });
      yield* startRevisionTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchB,
        reviews: branchBReviewTexts,
        createdAt: updatedAt,
      });

      yield* upsertWorkflow(
        markBranchRevising(markBranchRevising(workflow, "a", updatedAt), "b", updatedAt),
      );
    });

  const maybeStartMerge = (
    workflow: PlanningWorkflow,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly proposedPlans: ReadonlyArray<{
          readonly planMarkdown: string;
        }>;
      }>;
    },
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        workflow.branchA.status !== "revised" ||
        workflow.branchB.status !== "revised" ||
        workflow.merge.status !== "not_started"
      ) {
        return;
      }

      const planA = snapshot.threads
        .find((thread) => thread.id === workflow.branchA.authorThreadId)
        ?.proposedPlans.at(-1)?.planMarkdown;
      const planB = snapshot.threads
        .find((thread) => thread.id === workflow.branchB.authorThreadId)
        ?.proposedPlans.at(-1)?.planMarkdown;
      if (!planA || !planB) {
        return;
      }

      const mergeThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: mergeThreadId,
        projectId: workflow.projectId,
        title: "Merge",
        model: workflow.merge.mergeSlot.model,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: updatedAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: mergeThreadId,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: buildMergePrompt({
            workflow,
            planAMarkdown: planA,
            planBMarkdown: planB,
            modelA: workflow.branchA.authorSlot,
            modelB: workflow.branchB.authorSlot,
          }),
          attachments: [],
        },
        provider: workflow.merge.mergeSlot.provider,
        model: workflow.merge.mergeSlot.model,
        ...(workflow.merge.mergeSlot.modelOptions
          ? { modelOptions: workflow.merge.mergeSlot.modelOptions }
          : {}),
        titleSourceText: workflow.title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
        createdAt: updatedAt,
      });
      yield* upsertWorkflow(markMergeStarted(workflow, mergeThreadId, updatedAt));
    });

  const maybeContinuePlanningWorkflowLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      yield* maybeStartReviews(workflow, snapshot, updatedAt);
      yield* maybeStartRevisions(workflow, snapshot, updatedAt);
      yield* maybeStartMerge(workflow, snapshot, updatedAt);
    });

  const maybeAdvancePlanningWorkflowFromCompletedThread = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      if (!thread) {
        return workflow;
      }

      const authorBranchId =
        workflow.branchA.authorThreadId === threadId
          ? ("a" as const)
          : workflow.branchB.authorThreadId === threadId
            ? ("b" as const)
            : null;
      if (authorBranchId) {
        const branch = authorBranchId === "a" ? workflow.branchA : workflow.branchB;
        if (branch.status !== "authoring" && branch.status !== "revising") {
          return workflow;
        }

        const turnId = getFinishedLatestTurnId(thread);
        if (!turnId) {
          return workflow;
        }

        const hasPlan = hasProposedPlanForTurn(thread, turnId);
        if (!hasPlan) {
          const synthesized = yield* maybeSynthesizeProposedPlan({
            thread,
            turnId,
            createdAt: updatedAt,
          });
          if (!synthesized) {
            return workflow;
          }
        }

        const nextWorkflow =
          branch.status === "revising"
            ? markBranchRevised(workflow, authorBranchId, {
                turnId,
                updatedAt,
              })
            : markBranchPlanSaved(workflow, authorBranchId, {
                turnId,
                updatedAt,
              });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(nextWorkflow);
        }
        return nextWorkflow;
      }

      const reviewMatch = workflowForReviewThread([workflow], threadId);
      if (reviewMatch) {
        const branch = reviewMatch.branchId === "a" ? workflow.branchA : workflow.branchB;
        const review = branch.reviews.find((entry) => entry.threadId === threadId);
        if (review?.status !== "running" || !getFinishedConsumableLatestTurn(thread)) {
          return workflow;
        }

        const nextWorkflow = markReviewCompleted(
          workflow,
          reviewMatch.branchId,
          threadId,
          updatedAt,
        );
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(nextWorkflow);
        }
        return nextWorkflow;
      }

      if (workflow.merge.threadId !== threadId || workflow.merge.status !== "in_progress") {
        return workflow;
      }

      const turnId = getFinishedLatestTurnId(thread);
      if (!turnId) {
        return workflow;
      }

      const hasPlan = hasProposedPlanForTurn(thread, turnId);
      if (!hasPlan) {
        const synthesized = yield* maybeSynthesizeProposedPlan({
          thread,
          turnId,
          createdAt: updatedAt,
        });
        if (!synthesized) {
          return workflow;
        }
      }

      const latestReadModel = yield* orchestrationEngine.getReadModel();
      const latestMergeThread =
        latestReadModel.threads.find((entry) => entry.id === threadId) ?? thread;
      const mergedPlanId =
        latestMergeThread.proposedPlans.find((plan) => plan.turnId === turnId)?.id ?? null;
      const outputFilePath = latestMarkdownFileChangePath(latestMergeThread, turnId);
      const nextWorkflow = markMergeReadyForManualReview(workflow, {
        turnId,
        updatedAt,
        approvedPlanId: mergedPlanId,
        ...(outputFilePath ? { outputFilePath } : {}),
      });
      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(nextWorkflow);
      }
      return nextWorkflow;
    });

  const maybeStartCodeReviews = (
    workflow: PlanningWorkflow,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly proposedPlans: ReadonlyArray<{
          readonly id: typeof OrchestrationProposedPlanId.Type;
          readonly planMarkdown: string;
        }>;
      }>;
    },
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation || workflow.implementation.status !== "implemented") {
        return;
      }
      if (workflow.implementation.codeReviews.length > 0) {
        return;
      }
      if (!workflow.implementation.codeReviewEnabled) {
        yield* upsertWorkflow(markImplementationCompleted(workflow, null, updatedAt));
        return;
      }

      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      const mergedPlan = mergeThread ? resolveApprovedMergedPlan(workflow, mergeThread) : null;
      if (!mergedPlan?.planMarkdown) {
        yield* upsertWorkflow(
          markImplementationError(workflow, "Merged plan not found for code review.", updatedAt),
        );
        return;
      }

      const reviews = [
        {
          reviewerSlot: workflow.branchA.authorSlot,
          reviewerLabel: `Author A (${slotLabel(workflow.branchA.authorSlot)})`,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        },
        {
          reviewerSlot: workflow.branchB.authorSlot,
          reviewerLabel: `Author B (${slotLabel(workflow.branchB.authorSlot)})`,
          threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        },
      ] as const;

      yield* Effect.forEach(
        reviews,
        (review) =>
          createCodeReviewThread({
            orchestrationEngine,
            workflow,
            reviewerSlot: review.reviewerSlot,
            threadId: review.threadId,
            reviewerLabel: review.reviewerLabel,
            createdAt: updatedAt,
          }).pipe(
            Effect.flatMap(() =>
              startCodeReviewTurn({
                orchestrationEngine,
                workflow,
                reviewerSlot: review.reviewerSlot,
                reviewThreadId: review.threadId,
                mergedPlanMarkdown: mergedPlan.planMarkdown,
                reviewerLabel: review.reviewerLabel,
                createdAt: updatedAt,
              }),
            ),
          ),
        { discard: true },
      );

      yield* upsertWorkflow(markCodeReviewsRequested(workflow, reviews, updatedAt));
    });

  const maybeStartImplementationRevision = (
    workflow: PlanningWorkflow,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly latestTurn: { readonly assistantMessageId: string | null } | null;
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
          readonly reasoningText?: string | undefined;
          readonly streaming: boolean;
          readonly createdAt: string;
        }>;
      }>;
    },
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation || workflow.implementation.status !== "code_reviews_saved") {
        return;
      }
      if (!workflow.implementation.threadId) {
        return;
      }

      const reviewTexts = (yield* Effect.forEach(workflow.implementation.codeReviews, (review) =>
        Effect.gen(function* () {
          const thread = snapshot.threads.find((entry) => entry.id === review.threadId);
          const feedback = thread ? latestAssistantFeedback(thread) : null;
          if (!feedback) {
            yield* Effect.logWarning("review yielded empty feedback text", {
              threadId: review.threadId,
              reviewerLabel: review.reviewerLabel,
              reviewStatus: review.status,
            });
            return null;
          }
          if (feedback.source !== "text-only") {
            yield* Effect.logDebug("reviewer feedback included reasoning-channel content", {
              threadId: review.threadId,
              reviewerLabel: review.reviewerLabel,
              source: feedback.source,
            });
          }
          return { reviewerLabel: review.reviewerLabel, reviewMarkdown: feedback.text };
        }),
      )).filter(
        (review): review is { reviewerLabel: string; reviewMarkdown: string } => review !== null,
      );

      if (reviewTexts.length === 0) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: workflow.implementation.threadId,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: buildImplementationRevisionPrompt({ reviews: reviewTexts }),
          attachments: [],
        },
        provider: workflow.implementation.implementationSlot.provider,
        model: workflow.implementation.implementationSlot.model,
        ...(workflow.implementation.implementationSlot.modelOptions
          ? { modelOptions: workflow.implementation.implementationSlot.modelOptions }
          : {}),
        titleSourceText: workflow.title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: updatedAt,
      });

      yield* upsertWorkflow(markImplementationApplyingReviews(workflow, updatedAt));
    });

  const maybeAdvanceImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation) {
        return workflow;
      }

      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const completedTurn = getFinishedConsumableLatestTurn(thread);
      if (!completedTurn) {
        return workflow;
      }

      let nextWorkflow = workflow;
      if (threadId === workflow.implementation.threadId) {
        nextWorkflow =
          workflow.implementation.status === "implementing"
            ? markImplementationDone(workflow, completedTurn.turnId, updatedAt)
            : workflow.implementation.status === "applying_reviews"
              ? markImplementationCompleted(workflow, completedTurn.turnId, updatedAt)
              : workflow;
      } else {
        const review = workflow.implementation.codeReviews.find(
          (entry) => entry.threadId === threadId,
        );
        nextWorkflow =
          review?.status === "running"
            ? markCodeReviewCompleted(workflow, threadId, updatedAt)
            : workflow;
      }

      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(nextWorkflow);
      }

      return nextWorkflow;
    });

  const maybeContinueImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation) {
        return;
      }

      if (workflow.implementation.status === "implemented") {
        yield* maybeStartCodeReviews(workflow, snapshot, updatedAt);
        return;
      }

      if (workflow.implementation.status === "code_reviews_saved") {
        yield* maybeStartImplementationRevision(workflow, snapshot, updatedAt);
      }
    });

  const retryImplementationTurn = (input: {
    readonly workflow: PlanningWorkflow;
    readonly thread: OrchestrationReadModel["threads"][number];
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (!input.workflow.implementation) {
        return yield* Effect.die(new Error("Workflow implementation not found for retry."));
      }

      const latestUserMessage = input.thread.messages
        .toReversed()
        .find((message) => message.role === "user" && !message.streaming);
      if (!latestUserMessage) {
        return yield* Effect.die(
          new Error(`Implementation retry message not found for thread '${input.thread.id}'.`),
        );
      }

      return yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: input.thread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: latestUserMessage.text,
          attachments: latestUserMessage.attachments ?? [],
        },
        provider: input.workflow.implementation.implementationSlot.provider,
        model: input.workflow.implementation.implementationSlot.model,
        ...(input.workflow.implementation.implementationSlot.modelOptions
          ? { modelOptions: input.workflow.implementation.implementationSlot.modelOptions }
          : {}),
        titleSourceText: input.workflow.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: input.createdAt,
      });
    });

  const reconcileWorkflowImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
  ) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow) || !workflow.implementation) {
        return;
      }

      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow.implementation.threadId
        ? yield* maybeAdvanceImplementationLifecycle(
            workflow,
            snapshot,
            workflow.implementation.threadId,
            updatedAt,
          )
        : workflow;

      for (const review of reconciledWorkflow.implementation?.codeReviews ?? []) {
        if (review.status !== "running") {
          continue;
        }
        reconciledWorkflow = yield* maybeAdvanceImplementationLifecycle(
          reconciledWorkflow,
          snapshot,
          review.threadId,
          updatedAt,
        );
      }

      yield* maybeContinueImplementationLifecycle(reconciledWorkflow, snapshot, updatedAt);
    });

  const reconcileWorkflowImplementationLifecycles = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getSnapshot();
    yield* Effect.forEach(snapshot.planningWorkflows, (workflow) =>
      reconcileWorkflowImplementationLifecycle(workflow, snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.reconcileWorkflowImplementationLifecycle failed", {
            workflowId: workflow.id,
            cause,
          }),
        ),
      ),
    );
  });

  const reconcileStuckWorkflow = (workflow: PlanningWorkflow, snapshot: OrchestrationReadModel) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow) || isArchivedWorkflow(workflow)) {
        return;
      }

      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow;
      let latestSnapshot = snapshot;

      const refreshWorkflowFromSnapshot = Effect.gen(function* () {
        latestSnapshot = yield* snapshotQuery.getSnapshot();
        reconciledWorkflow =
          latestSnapshot.planningWorkflows.find((entry) => entry.id === workflow.id) ??
          reconciledWorkflow;
      });

      const reconcilePendingBranch = (branchId: "a" | "b") =>
        Effect.gen(function* () {
          const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
          if (branch.status !== "pending") {
            return;
          }

          const outcome = yield* startAuthoringTurn({
            orchestrationEngine,
            workflow: reconciledWorkflow,
            branch,
            createdAt: updatedAt,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error: String(error) }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );

          reconciledWorkflow = updateAuthoringBranch(
            reconciledWorkflow,
            branchId,
            updatedAt,
            outcome,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        });

      yield* reconcilePendingBranch("a");
      yield* reconcilePendingBranch("b");
      yield* refreshWorkflowFromSnapshot;

      const lifecycleThreadIds = [
        reconciledWorkflow.branchA.authorThreadId,
        reconciledWorkflow.branchB.authorThreadId,
        ...reconciledWorkflow.branchA.reviews.map((review) => review.threadId),
        ...reconciledWorkflow.branchB.reviews.map((review) => review.threadId),
        ...(reconciledWorkflow.merge.threadId ? [reconciledWorkflow.merge.threadId] : []),
      ];
      for (const threadId of lifecycleThreadIds) {
        const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
          reconciledWorkflow,
          latestSnapshot,
          threadId,
          updatedAt,
        );
        if (nextWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = nextWorkflow;
          yield* refreshWorkflowFromSnapshot;
        }
      }

      yield* maybeContinuePlanningWorkflowLifecycle(reconciledWorkflow, latestSnapshot, updatedAt);
      yield* refreshWorkflowFromSnapshot;

      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
        const baselineBranch = branchId === "a" ? workflow.branchA : workflow.branchB;
        const authorThread = latestSnapshot.threads.find(
          (thread) => thread.id === branch.authorThreadId,
        );
        const startedBranchThisPass =
          baselineBranch.status !== branch.status &&
          (branch.status === "authoring" || branch.status === "revising");
        if (
          (branch.status === "authoring" || branch.status === "revising") &&
          !startedBranchThisPass &&
          isSessionUnavailableForReconciliation(authorThread)
        ) {
          reconciledWorkflow = markBranchError(reconciledWorkflow, branchId, {
            error:
              branch.status === "revising"
                ? "Revision session was not running during reconciliation."
                : "Authoring session was not running during reconciliation.",
            updatedAt,
          });
          yield* upsertWorkflow(reconciledWorkflow);
          continue;
        }

        for (const review of branch.reviews) {
          if (review.status !== "running") {
            continue;
          }
          const baselineReview = baselineBranch.reviews.find(
            (entry) => entry.threadId === review.threadId,
          );
          const startedReviewThisPass =
            (baselineReview?.status ?? null) !== "running" && review.status === "running";
          const reviewThread = latestSnapshot.threads.find(
            (thread) => thread.id === review.threadId,
          );
          if (!startedReviewThisPass && isSessionUnavailableForReconciliation(reviewThread)) {
            reconciledWorkflow = markBranchError(reconciledWorkflow, branchId, {
              error: "Review session was not running during reconciliation.",
              updatedAt,
            });
            yield* upsertWorkflow(reconciledWorkflow);
            break;
          }
        }
      }

      const startedMergeThisPass =
        workflow.merge.status !== "in_progress" &&
        reconciledWorkflow.merge.status === "in_progress";
      if (reconciledWorkflow.merge.status === "in_progress" && !startedMergeThisPass) {
        const mergeThread = reconciledWorkflow.merge.threadId
          ? latestSnapshot.threads.find((thread) => thread.id === reconciledWorkflow.merge.threadId)
          : null;
        if (isSessionUnavailableForReconciliation(mergeThread)) {
          reconciledWorkflow = markMergeError(
            reconciledWorkflow,
            "Merge session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      if (
        reconciledWorkflow.implementation?.status === "implementing" ||
        reconciledWorkflow.implementation?.status === "applying_reviews"
      ) {
        const implementationThread = reconciledWorkflow.implementation.threadId
          ? latestSnapshot.threads.find(
              (thread) => thread.id === reconciledWorkflow.implementation?.threadId,
            )
          : null;
        if (
          isSessionUnavailableForReconciliation(implementationThread, {
            allowCompletedTurn: true,
          })
        ) {
          reconciledWorkflow = markImplementationError(
            reconciledWorkflow,
            reconciledWorkflow.implementation.status === "applying_reviews"
              ? "Implementation revision session was not running during reconciliation."
              : "Implementation session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      for (const review of reconciledWorkflow.implementation?.codeReviews ?? []) {
        if (review.status !== "running") {
          continue;
        }
        const codeReviewThread = latestSnapshot.threads.find(
          (thread) => thread.id === review.threadId,
        );
        if (
          isSessionUnavailableForReconciliation(codeReviewThread, {
            allowCompletedTurn: true,
          })
        ) {
          reconciledWorkflow = markCodeReviewError(
            reconciledWorkflow,
            review.threadId,
            "Code review session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
          break;
        }
      }
    });

  const reconcileStuckWorkflows = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getSnapshot();
    yield* Effect.forEach(snapshot.planningWorkflows, (workflow) =>
      reconcileStuckWorkflow(workflow, snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.reconcileStuckWorkflow failed", {
            workflowId: workflow.id,
            cause,
          }),
        ),
      ),
    );
  });

  const handleDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.proposed-plan-upserted": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const match = workflowForAuthorThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (!match) {
            const mergeWorkflow = readModel.planningWorkflows.find(
              (workflow) =>
                !isDeletedWorkflow(workflow) && workflow.merge.threadId === event.payload.threadId,
            );
            if (!mergeWorkflow) {
              return;
            }
            const mergeThread = readModel.threads.find(
              (thread) => thread.id === event.payload.threadId,
            );
            yield* upsertWorkflow(
              markMergeReadyForManualReview(mergeWorkflow, {
                turnId: event.payload.proposedPlan.turnId,
                updatedAt: event.occurredAt,
                approvedPlanId: event.payload.proposedPlan.id,
                ...(mergeThread && event.payload.proposedPlan.turnId
                  ? {
                      outputFilePath: latestMarkdownFileChangePath(
                        mergeThread,
                        event.payload.proposedPlan.turnId,
                      ),
                    }
                  : {}),
              }),
            );
            return;
          }
          const branch = match.branchId === "a" ? match.workflow.branchA : match.workflow.branchB;
          switch (branch.status) {
            case "revising":
            case "revised": {
              if (
                event.payload.proposedPlan.turnId === null ||
                event.payload.proposedPlan.turnId === branch.planTurnId
              ) {
                return;
              }
              const nextWorkflow =
                branch.status === "revised"
                  ? match.workflow
                  : markBranchRevised(match.workflow, match.branchId, {
                      turnId: event.payload.proposedPlan.turnId,
                      updatedAt: event.occurredAt,
                    });
              if (nextWorkflow !== match.workflow) {
                yield* upsertWorkflow(nextWorkflow);
              }
              yield* maybeStartMerge(nextWorkflow, readModel, event.occurredAt);
              return;
            }

            case "plan_saved": {
              yield* maybeStartReviews(match.workflow, readModel, event.occurredAt);
              return;
            }

            case "authoring": {
              const nextWorkflow = markBranchPlanSaved(match.workflow, match.branchId, {
                turnId: event.payload.proposedPlan.turnId,
                updatedAt: event.occurredAt,
              });
              yield* upsertWorkflow(nextWorkflow);
              yield* maybeStartReviews(nextWorkflow, readModel, event.occurredAt);
              return;
            }

            default: {
              if (branch.status === "reviews_requested" || branch.status === "reviews_saved") {
                yield* Effect.logInfo(
                  "discarding stale author proposed plan after reviews already started",
                  {
                    workflowId: match.workflow.id,
                    branchId: match.branchId,
                    branchStatus: branch.status,
                    threadId: event.payload.threadId,
                    proposedPlanTurnId: event.payload.proposedPlan.turnId,
                  },
                );
                return;
              }
              yield* Effect.logDebug("ignoring author proposed plan after branch advanced", {
                workflowId: match.workflow.id,
                branchId: match.branchId,
                branchStatus: branch.status,
                threadId: event.payload.threadId,
                proposedPlanTurnId: event.payload.proposedPlan.turnId,
              });
              return;
            }
          }
        }

        case "thread.turn-diff-completed": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const match = workflowForReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (match) {
            const nextWorkflow = markReviewCompleted(
              match.workflow,
              match.branchId,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* upsertWorkflow(nextWorkflow);
            yield* maybeStartRevisions(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const authorMatch = workflowForAuthorThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (authorMatch) {
            const authorThread = readModel.threads.find(
              (thread) => thread.id === event.payload.threadId,
            );
            const branch =
              authorMatch.branchId === "a"
                ? authorMatch.workflow.branchA
                : authorMatch.workflow.branchB;
            if (authorThread && (branch.status === "authoring" || branch.status === "revising")) {
              yield* maybeSynthesizeProposedPlan({
                thread: authorThread,
                turnId: event.payload.turnId,
                createdAt: event.occurredAt,
              });
            }
            return;
          }

          const mergeWorkflow = readModel.planningWorkflows.find(
            (workflow) =>
              !isDeletedWorkflow(workflow) &&
              workflow.merge.threadId === event.payload.threadId &&
              workflow.merge.status === "in_progress",
          );
          if (!mergeWorkflow) {
            return;
          }

          const mergeThread = readModel.threads.find(
            (thread) => thread.id === event.payload.threadId,
          );
          if (!mergeThread) {
            return;
          }

          yield* maybeSynthesizeProposedPlan({
            thread: mergeThread,
            turnId: event.payload.turnId,
            createdAt: event.occurredAt,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.role !== "assistant" || event.payload.streaming) {
            return;
          }

          const readModel = yield* orchestrationEngine.getReadModel();
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (implementationMatch?.workflow.implementation) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const implementationCodeReviewMatch = workflowForCodeReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (implementationCodeReviewMatch?.workflow.implementation) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationCodeReviewMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const planningWorkflow =
            workflowForAuthorThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForReviewThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForMergeThread(readModel.planningWorkflows, event.payload.threadId)?.workflow ??
            null;
          if (planningWorkflow) {
            const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              planningWorkflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            const lifecycleSnapshot =
              nextWorkflow !== planningWorkflow
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
            yield* maybeContinuePlanningWorkflowLifecycle(
              nextWorkflow,
              lifecycleSnapshot,
              event.occurredAt,
            );
            return;
          }

          return;
        }

        case "thread.session-set": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const applyTurnCost = (workflow: PlanningWorkflow) =>
            applyWorkflowTurnCost(workflow, event.payload.session.turnCostUsd, event.occurredAt);
          const reviewMatch = workflowForReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const authorMatch = workflowForAuthorThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const codeReviewMatch = workflowForCodeReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const mergeMatch = workflowForMergeThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );

          if (event.payload.session.status !== "error") {
            if (
              implementationMatch?.workflow.implementation &&
              event.payload.session.status === "ready"
            ) {
              const workflowWithCost = applyTurnCost(implementationMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              if (
                nextWorkflow === workflowWithCost &&
                workflowWithCost !== implementationMatch.workflow
              ) {
                yield* upsertWorkflow(workflowWithCost);
              }
              yield* maybeContinueImplementationLifecycle(
                nextWorkflow,
                readModel,
                event.occurredAt,
              );
              return;
            }

            if (
              codeReviewMatch?.workflow.implementation &&
              event.payload.session.status === "ready"
            ) {
              const workflowWithCost = applyTurnCost(codeReviewMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              if (
                nextWorkflow === workflowWithCost &&
                workflowWithCost !== codeReviewMatch.workflow
              ) {
                yield* upsertWorkflow(workflowWithCost);
              }
              yield* maybeContinueImplementationLifecycle(
                nextWorkflow,
                readModel,
                event.occurredAt,
              );
              return;
            }

            const planningWorkflow =
              reviewMatch?.workflow ?? authorMatch?.workflow ?? mergeMatch?.workflow;
            if (planningWorkflow) {
              const workflowWithCost = applyTurnCost(planningWorkflow);
              const nextWorkflow =
                event.payload.session.status === "ready"
                  ? yield* maybeAdvancePlanningWorkflowFromCompletedThread(
                      workflowWithCost,
                      readModel,
                      event.payload.threadId,
                      event.occurredAt,
                    )
                  : workflowWithCost;
              if (nextWorkflow === workflowWithCost && workflowWithCost !== planningWorkflow) {
                yield* upsertWorkflow(workflowWithCost);
              }
              if (event.payload.session.status === "ready") {
                const lifecycleSnapshot =
                  nextWorkflow !== workflowWithCost
                    ? yield* orchestrationEngine.getReadModel()
                    : readModel;
                yield* maybeContinuePlanningWorkflowLifecycle(
                  nextWorkflow,
                  lifecycleSnapshot,
                  event.occurredAt,
                );
              }
              return;
            }

            return;
          }
          if (reviewMatch) {
            yield* upsertWorkflow(
              markBranchError(applyTurnCost(reviewMatch.workflow), reviewMatch.branchId, {
                error: formatSessionError(event.payload.session, "Review failed."),
                updatedAt: event.occurredAt,
              }),
            );
            return;
          }

          if (authorMatch) {
            const baseWorkflow = applyTurnCost(authorMatch.workflow);
            const branch =
              authorMatch.branchId === "a" ? baseWorkflow.branchA : baseWorkflow.branchB;
            if (
              branch.status === "authoring" &&
              isRetryableSessionError(event.payload.session.lastError) &&
              branch.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const retryWorkflow = incrementBranchRetryCount(
                baseWorkflow,
                authorMatch.branchId,
                event.occurredAt,
              );
              const expectedRetryCount =
                authorMatch.branchId === "a"
                  ? retryWorkflow.branchA.retryCount
                  : retryWorkflow.branchB.retryCount;
              yield* upsertWorkflow(retryWorkflow);
              yield* forkAutoRetry({
                kind: "authoring",
                workflowId: retryWorkflow.id,
                threadId: event.payload.threadId,
                buildDispatch: ({ workflow, snapshot }) => {
                  const branch =
                    workflow.branchA.authorThreadId === event.payload.threadId
                      ? workflow.branchA
                      : workflow.branchB.authorThreadId === event.payload.threadId
                        ? workflow.branchB
                        : null;
                  const retryThread = snapshot.threads.find(
                    (thread) => thread.id === event.payload.threadId,
                  );
                  if (
                    !branch ||
                    !retryThread ||
                    branch.status !== "authoring" ||
                    branch.retryCount !== expectedRetryCount ||
                    hasActiveRunningTurn(retryThread)
                  ) {
                    return null;
                  }

                  return startAuthoringTurn({
                    orchestrationEngine,
                    workflow,
                    branch,
                    createdAt: new Date().toISOString(),
                  });
                },
              });
              return;
            }

            yield* upsertWorkflow(
              markBranchError(baseWorkflow, authorMatch.branchId, {
                error: formatSessionError(event.payload.session, "Authoring failed."),
                updatedAt: event.occurredAt,
              }),
            );
            return;
          }

          if (implementationMatch) {
            const baseWorkflow = applyTurnCost(implementationMatch.workflow);
            if (
              baseWorkflow.implementation &&
              (baseWorkflow.implementation.status === "implementing" ||
                baseWorkflow.implementation.status === "applying_reviews") &&
              isRetryableSessionError(event.payload.session.lastError) &&
              baseWorkflow.implementation.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const implementationThread = readModel.threads.find(
                (thread) => thread.id === event.payload.threadId,
              );
              if (implementationThread) {
                const retryWorkflow = incrementImplementationRetryCount(
                  baseWorkflow,
                  event.occurredAt,
                );
                const expectedRetryCount = retryWorkflow.implementation?.retryCount;
                if (expectedRetryCount === undefined) {
                  return;
                }
                yield* upsertWorkflow(retryWorkflow);
                yield* forkAutoRetry({
                  kind: "implementation",
                  workflowId: retryWorkflow.id,
                  threadId: event.payload.threadId,
                  buildDispatch: ({ workflow, snapshot }) => {
                    if (
                      !workflow.implementation ||
                      workflow.implementation.threadId !== event.payload.threadId
                    ) {
                      return null;
                    }

                    const retryThread = snapshot.threads.find(
                      (thread) => thread.id === event.payload.threadId,
                    );
                    if (
                      !retryThread ||
                      (workflow.implementation.status !== "implementing" &&
                        workflow.implementation.status !== "applying_reviews") ||
                      workflow.implementation.retryCount !== expectedRetryCount ||
                      hasActiveRunningTurn(retryThread)
                    ) {
                      return null;
                    }

                    return retryImplementationTurn({
                      workflow,
                      thread: retryThread,
                      createdAt: new Date().toISOString(),
                    });
                  },
                });
                return;
              }
            }

            yield* upsertWorkflow(
              markImplementationError(
                baseWorkflow,
                formatSessionError(event.payload.session, "Implementation failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          if (codeReviewMatch) {
            const baseWorkflow = applyTurnCost(codeReviewMatch.workflow);
            const review = baseWorkflow.implementation?.codeReviews.find(
              (entry) => entry.threadId === event.payload.threadId,
            );
            if (
              review?.status === "running" &&
              isRetryableSessionError(event.payload.session.lastError) &&
              review.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const mergeThread = readModel.threads.find(
                (thread) => thread.id === baseWorkflow.merge.threadId,
              );
              const mergedPlan = mergeThread
                ? resolveApprovedMergedPlan(baseWorkflow, mergeThread)
                : null;
              if (mergedPlan?.planMarkdown) {
                const retryWorkflow = incrementCodeReviewRetryCount(
                  baseWorkflow,
                  event.payload.threadId,
                  event.occurredAt,
                );
                const expectedRetryCount =
                  retryWorkflow.implementation?.codeReviews.find(
                    (entry) => entry.threadId === event.payload.threadId,
                  )?.retryCount ?? 0;
                yield* upsertWorkflow(retryWorkflow);
                yield* forkAutoRetry({
                  kind: "code_review",
                  workflowId: retryWorkflow.id,
                  threadId: event.payload.threadId,
                  buildDispatch: ({ workflow, snapshot }) => {
                    const retryReview = workflow.implementation?.codeReviews.find(
                      (entry) => entry.threadId === event.payload.threadId,
                    );
                    const retryThread = snapshot.threads.find(
                      (thread) => thread.id === event.payload.threadId,
                    );
                    const retryMergeThread = workflow.merge.threadId
                      ? snapshot.threads.find((thread) => thread.id === workflow.merge.threadId)
                      : null;
                    const retryMergedPlan = retryMergeThread
                      ? resolveApprovedMergedPlan(workflow, retryMergeThread)
                      : null;
                    if (
                      !workflow.implementation ||
                      !retryReview ||
                      !retryThread ||
                      retryReview.status !== "running" ||
                      retryReview.retryCount !== expectedRetryCount ||
                      hasActiveRunningTurn(retryThread) ||
                      !retryMergedPlan?.planMarkdown
                    ) {
                      return null;
                    }

                    return startCodeReviewTurn({
                      orchestrationEngine,
                      workflow,
                      reviewerSlot: retryReview.reviewerSlot,
                      reviewThreadId: retryReview.threadId,
                      mergedPlanMarkdown: retryMergedPlan.planMarkdown,
                      reviewerLabel: retryReview.reviewerLabel,
                      createdAt: new Date().toISOString(),
                    });
                  },
                });
                return;
              }
            }

            yield* upsertWorkflow(
              markCodeReviewError(
                baseWorkflow,
                event.payload.threadId,
                formatSessionError(event.payload.session, "Code review failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          if (mergeMatch) {
            yield* upsertWorkflow(
              markMergeError(
                applyTurnCost(mergeMatch.workflow),
                formatSessionError(event.payload.session, "Merge failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          return;
        }

        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.handleDomainEvent failed", {
          eventType: event.type,
          cause,
        }),
      ),
    );

  const start: WorkflowServiceShape["start"] = Effect.gen(function* () {
    yield* reconcileStuckWorkflows.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.reconcileStuckWorkflows failed", {
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    yield* reconcileWorkflowImplementationLifecycles.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.reconcileWorkflowImplementationLifecycles failed", {
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, handleDomainEvent).pipe(
      Effect.forkScoped,
      Effect.asVoid,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("WorkflowService.start failed", { cause }).pipe(
        Effect.asVoid,
        Effect.flatMap(() => Effect.failCause(cause)),
      ),
    ),
  );

  const createWorkflow: WorkflowServiceShape["createWorkflow"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getSnapshot();
      const existingSlugs = new Set(
        snapshot.planningWorkflows
          .filter(
            (workflow) => workflow.projectId === input.projectId && workflow.deletedAt === null,
          )
          .map((workflow) => workflow.slug),
      );
      const now = new Date().toISOString();
      const workflowId = PlanningWorkflowId.makeUnsafe(crypto.randomUUID());
      const authorThreadIdA = ThreadId.makeUnsafe(crypto.randomUUID());
      const authorThreadIdB = ThreadId.makeUnsafe(crypto.randomUUID());
      const titleSourceText = input.requirementPrompt;
      const initialTitle =
        input.title ??
        buildFallbackTitle({
          titleSourceText,
          attachments: [],
          defaultTitle: "New workflow",
        });
      const slug = nextWorkflowSlug(existingSlugs, initialTitle);
      const plansDirectory = input.plansDirectory?.trim() || "plans";
      const workflow = buildWorkflowRecord({
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        requirementPrompt: input.requirementPrompt,
        plansDirectory,
        selfReviewEnabled: input.selfReviewEnabled,
        authorThreadIdA,
        authorThreadIdB,
        branchA: input.branchA,
        branchB: input.branchB,
        merge: input.merge,
        createdAt: now,
      });

      yield* orchestrationEngine.dispatch({
        type: "project.workflow.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        requirementPrompt: input.requirementPrompt,
        plansDirectory,
        authorThreadIdA,
        authorThreadIdB,
        selfReviewEnabled: input.selfReviewEnabled,
        branchA: input.branchA,
        branchB: input.branchB,
        merge: input.merge,
        createdAt: now,
      });

      yield* Effect.all([
        createWorkflowThread({
          orchestrationEngine,
          input,
          threadId: authorThreadIdA,
          suffix: "Branch A",
          branch: "a",
          now,
        }),
        createWorkflowThread({
          orchestrationEngine,
          input,
          threadId: authorThreadIdB,
          suffix: "Branch B",
          branch: "b",
          now,
        }),
      ]).pipe(
        Effect.tapError(() =>
          dispatchWorkflowDeleteCompensation({
            orchestrationEngine,
            workflowId,
            projectId: input.projectId,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
      );

      const branchAOutcome = yield* startAuthoringTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchA,
        createdAt: new Date().toISOString(),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error: String(error) }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );
      const branchBOutcome = yield* startAuthoringTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchB,
        createdAt: new Date().toISOString(),
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error: String(error) }),
          onSuccess: () => ({ ok: true as const }),
        }),
      );

      const workflowWithAuthoring = updateAuthoringBranch(
        updateAuthoringBranch(workflow, "a", new Date().toISOString(), branchAOutcome),
        "b",
        new Date().toISOString(),
        branchBOutcome,
      );
      yield* upsertWorkflow(workflowWithAuthoring);
      if (input.title === undefined) {
        yield* titleGenerationWorker.enqueue({
          workflowId,
          titleSourceText,
          expectedCurrentTitle: initialTitle,
          titleGenerationModel: input.titleGenerationModel,
          defaultTitle: "New workflow",
        });
      }

      return workflowId;
    });

  const startImplementation: WorkflowServiceShape["startImplementation"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(snapshotQuery, input.workflowId).pipe(
        Effect.mapError((error) => new Error(`Failed to load workflow: ${String(error)}`)),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }
      if (workflow.merge.status !== "manual_review") {
        return yield* Effect.fail(new Error("Workflow merge is not ready for implementation."));
      }
      if (workflow.implementation !== null) {
        return yield* Effect.fail(
          new Error("Implementation has already been started for this workflow."),
        );
      }

      const snapshot = yield* snapshotQuery.getSnapshot();
      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      if (!mergeThread) {
        return yield* Effect.fail(new Error("Merge thread not found."));
      }

      const mergedPlan = resolveApprovedMergedPlan(workflow, mergeThread);
      if (!mergedPlan?.planMarkdown) {
        return yield* Effect.fail(new Error("Merged plan not found."));
      }

      const envMode = input.envMode ?? "local";
      const workspaceRoot =
        snapshot.projects.find(
          (project) => project.id === workflow.projectId && project.deletedAt === null,
        )?.workspaceRoot ?? null;

      let branch: string | null = null;
      let worktreePath: string | null = null;
      if (envMode === "worktree") {
        if (!input.baseBranch) {
          return yield* Effect.fail(
            new Error("A base branch is required when starting implementation in a new worktree."),
          );
        }
        if (!workspaceRoot) {
          return yield* Effect.fail(
            new Error("Project workspace root is unavailable; cannot create worktree."),
          );
        }
        const createdWorktree = yield* gitCore
          .createWorktree({
            cwd: workspaceRoot,
            branch: input.baseBranch,
            newBranch: buildTemporaryWorktreeBranchName(),
            path: null,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new Error(`Failed to create worktree for implementation: ${String(error)}`),
            ),
          );
        branch = createdWorktree.worktree.branch;
        worktreePath = createdWorktree.worktree.path;
      }

      const now = new Date().toISOString();
      const implementationThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
      const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
      const codeReviewEnabled = input.codeReviewEnabled ?? true;

      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: implementationThreadId,
        projectId: workflow.projectId,
        title: "Implementation",
        model: input.model,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch,
        worktreePath,
        threadReferences: [
          {
            relation: "source",
            threadId: mergeThread.id,
            createdAt: now,
          },
        ],
        createdAt: now,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: implementationThreadId,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: buildImplementationPrompt({
            workflow,
            mergedPlanMarkdown: mergedPlan.planMarkdown,
            provider: input.provider,
          }),
          attachments: [],
        },
        provider: input.provider,
        model: input.model,
        ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
        titleSourceText: workflow.title,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        sourceProposedPlan: {
          threadId: mergeThread.id,
          planId: mergedPlan.id,
        },
        createdAt: now,
      });

      yield* upsertWorkflow({
        ...workflow,
        implementation: {
          implementationSlot: {
            provider: input.provider,
            model: input.model,
            ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
          },
          threadId: implementationThreadId,
          implementationTurnId: null,
          revisionTurnId: null,
          codeReviewEnabled,
          codeReviews: [],
          status: "implementing",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        },
        updatedAt: now,
      });
    });

  const deleteWorkflow: WorkflowServiceShape["deleteWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(snapshotQuery, workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
      }

      yield* orchestrationEngine.dispatch({
        type: "project.workflow.delete",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        workflowId,
        projectId: workflow.projectId,
        createdAt: new Date().toISOString(),
      });
    });

  const archiveWorkflow: WorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(snapshotQuery, workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
      }
      if (isArchivedWorkflow(workflow)) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' is already archived.`));
      }

      const updatedAt = new Date().toISOString();
      yield* upsertWorkflow({
        ...workflow,
        archivedAt: updatedAt,
        updatedAt,
      });
    });

  const unarchiveWorkflow: WorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(snapshotQuery, workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
      }
      if (!isArchivedWorkflow(workflow)) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' is not archived.`));
      }

      const updatedAt = new Date().toISOString();
      yield* upsertWorkflow({
        ...workflow,
        archivedAt: null,
        updatedAt,
      });
    });

  const retryWorkflow: WorkflowServiceShape["retryWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(snapshotQuery, workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
      }

      const updatedAt = new Date().toISOString();
      const resetWorkflow = resetWorkflowForRetry(workflow, updatedAt);
      yield* upsertWorkflow(resetWorkflow);

      if (resetWorkflow.implementation?.status === "code_reviews_saved") {
        const snapshot = yield* snapshotQuery.getSnapshot();
        yield* maybeStartImplementationRevision(resetWorkflow, snapshot, updatedAt);
        return;
      }

      if (resetWorkflow.implementation?.status === "code_reviews_requested") {
        const snapshot = yield* snapshotQuery.getSnapshot();
        const mergeThread = snapshot.threads.find(
          (thread) => thread.id === resetWorkflow.merge.threadId,
        );
        const mergedPlan = mergeThread
          ? resolveApprovedMergedPlan(resetWorkflow, mergeThread)
          : null;
        if (!mergedPlan?.planMarkdown) {
          yield* upsertWorkflow(
            markImplementationError(
              resetWorkflow,
              "Merged plan not found for retried code review.",
              updatedAt,
            ),
          );
          return;
        }

        yield* Effect.forEach(
          resetWorkflow.implementation.codeReviews.filter((review) => review.status === "pending"),
          (review) =>
            startCodeReviewTurn({
              orchestrationEngine,
              workflow: resetWorkflow,
              reviewerSlot: review.reviewerSlot,
              reviewThreadId: review.threadId,
              mergedPlanMarkdown: mergedPlan.planMarkdown,
              reviewerLabel: review.reviewerLabel,
              createdAt: updatedAt,
            }),
          { discard: true },
        );

        yield* upsertWorkflow({
          ...resetWorkflow,
          implementation: {
            ...resetWorkflow.implementation,
            codeReviews: resetWorkflow.implementation.codeReviews.map((review) => {
              if (review.status !== "pending") {
                return review;
              }
              return Object.assign({}, review, {
                status: "running" as const,
                updatedAt,
              });
            }),
            updatedAt,
          },
          updatedAt,
        });
      }
    });

  const workflowForThread: WorkflowServiceShape["workflowForThread"] = (threadId) =>
    snapshotQuery.getSnapshot().pipe(
      Effect.map((snapshot) => {
        for (const workflow of snapshot.planningWorkflows) {
          if (isDeletedWorkflow(workflow)) {
            continue;
          }
          const match = labelForThread(workflow, threadId);
          if (match) {
            return match;
          }
        }
        return null;
      }),
      Effect.tapError((error) =>
        Effect.logWarning("WorkflowService.workflowForThread: snapshot lookup failed", {
          threadId,
          cause: error,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  return {
    start,
    drain: titleGenerationWorker.drain,
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    startImplementation,
    workflowForThread,
  } satisfies WorkflowServiceShape;
});

function createWorkflowThread({
  orchestrationEngine,
  input,
  threadId,
  suffix,
  branch,
  now,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  input: CreateWorkflowInput;
  threadId: ThreadId;
  suffix: string;
  branch: "a" | "b";
  now: string;
}) {
  const slot = branch === "a" ? input.branchA : input.branchB;
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    projectId: input.projectId,
    title: suffix,
    model: slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    branch,
    worktreePath: null,
    createdAt: now,
  });
}

function startAuthoringTurn({
  orchestrationEngine,
  workflow,
  branch,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  branch: PlanningWorkflow["branchA"];
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildAuthorPrompt({
        workflow,
        branch,
        provider: branch.authorSlot.provider,
      }),
      attachments: [],
    },
    provider: branch.authorSlot.provider,
    model: branch.authorSlot.model,
    ...(branch.authorSlot.modelOptions ? { modelOptions: branch.authorSlot.modelOptions } : {}),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    createdAt,
  });
}

function createReviewThread({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewedBranchId,
  reviewSlot,
  threadId,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  reviewedBranchId: "a" | "b";
  reviewSlot: WorkflowReviewSlot;
  threadId: ThreadId;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    projectId: workflow.projectId,
    title: `Review ${reviewedBranchId.toUpperCase()} ${reviewSlot === "cross" ? "Cross" : "Self"}`,
    model: reviewerSlot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  });
}

function startReviewTurn({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewThreadId,
  planMarkdown,
  reviewKind,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  reviewThreadId: ThreadId;
  planMarkdown: string;
  reviewKind: WorkflowReviewSlot;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildReviewPrompt({
        planMarkdown,
        reviewKind,
        provider: reviewerSlot.provider,
      }),
      attachments: [],
    },
    provider: reviewerSlot.provider,
    model: reviewerSlot.model,
    ...(reviewerSlot.modelOptions ? { modelOptions: reviewerSlot.modelOptions } : {}),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    createdAt,
  });
}

function startRevisionTurn({
  orchestrationEngine,
  workflow,
  branch,
  reviews,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  branch: PlanningWorkflow["branchA"];
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
  }>;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildRevisionPrompt({ reviews }),
      attachments: [],
    },
    provider: branch.authorSlot.provider,
    model: branch.authorSlot.model,
    ...(branch.authorSlot.modelOptions ? { modelOptions: branch.authorSlot.modelOptions } : {}),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    createdAt,
  });
}

function createCodeReviewThread({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  threadId,
  reviewerLabel,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  threadId: ThreadId;
  reviewerLabel: string;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    projectId: workflow.projectId,
    title: `Code Review (${reviewerLabel})`,
    model: reviewerSlot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  });
}

function startCodeReviewTurn({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewThreadId,
  mergedPlanMarkdown,
  reviewerLabel,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  reviewThreadId: ThreadId;
  mergedPlanMarkdown: string;
  reviewerLabel: string;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildCodeReviewPrompt({
        mergedPlanMarkdown,
        requirementPrompt: workflow.requirementPrompt,
        reviewerLabel,
        provider: reviewerSlot.provider,
      }),
      attachments: [],
    },
    provider: reviewerSlot.provider,
    model: reviewerSlot.model,
    ...(reviewerSlot.modelOptions ? { modelOptions: reviewerSlot.modelOptions } : {}),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt,
  });
}

function dispatchWorkflowDeleteCompensation({
  orchestrationEngine,
  workflowId,
  projectId,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflowId: PlanningWorkflowId;
  projectId: CreateWorkflowInput["projectId"];
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "project.workflow.delete",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    workflowId,
    projectId,
    createdAt,
  });
}

function readWorkflow(snapshotQuery: ProjectionSnapshotQueryShape, workflowId: PlanningWorkflowId) {
  return snapshotQuery
    .getSnapshot()
    .pipe(
      Effect.map(
        (snapshot) =>
          snapshot.planningWorkflows.find(
            (workflow) => workflow.id === workflowId && workflow.deletedAt === null,
          ) ?? null,
      ),
    );
}

export const WorkflowServiceLive = Layer.effect(WorkflowService, makeWorkflowService);
