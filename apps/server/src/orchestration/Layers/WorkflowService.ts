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
import { Cause, Duration, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { resolveDefaultWorktreePath } from "../../git/worktreePaths.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
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
import { applyWorkflowTurnCost, workflowBudgetError } from "../workflowBudget.ts";
import {
  resolveAvailableWorkflowModelSlot,
  workflowTurnProviderFields,
  withWorkflowModelSelectionGuard,
} from "../workflowModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";

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
  maxCostUsd?: number | undefined;
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
      errorStage: null,
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
      errorStage: null,
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
    maxCostUsd: input.maxCostUsd ?? null,
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
          errorStage: outcome.ok ? null : ("authoring" as const),
          updatedAt: now,
        }
      : {
          ...workflow.branchB,
          status: outcome.ok ? ("authoring" as const) : ("error" as const),
          error: outcome.ok ? null : outcome.error,
          errorStage: outcome.ok ? null : ("authoring" as const),
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
          errorStage: null,
          updatedAt: input.updatedAt,
        }
      : {
          ...workflow.branchB,
          status: "plan_saved" as const,
          planTurnId: input.turnId ?? workflow.branchB.planTurnId,
          error: null,
          errorStage: null,
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
    readonly stage: "authoring" | "revision";
    readonly updatedAt: string;
  },
): PlanningWorkflow {
  const nextBranch =
    branchId === "a"
      ? {
          ...workflow.branchA,
          status: "error" as const,
          error: input.error,
          errorStage: input.stage,
          updatedAt: input.updatedAt,
        }
      : {
          ...workflow.branchB,
          status: "error" as const,
          error: input.error,
          errorStage: input.stage,
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
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: input.updatedAt,
      })),
      status: "reviews_requested",
      error: null,
      errorStage: null,
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
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: input.updatedAt,
      })),
      status: "reviews_requested",
      error: null,
      errorStage: null,
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
  const reviewedBranch = branchId === "a" ? workflow.branchA : workflow.branchB;
  const review = reviewedBranch.reviews.find((entry) => entry.threadId === threadId);
  if (
    (reviewedBranch.status !== "reviews_requested" &&
      planningWorkflowBranchFailureStage(reviewedBranch) !== "reviews") ||
    (review?.status !== "running" && review?.status !== "error")
  ) {
    return workflow;
  }

  const completeReview = (review: PlanningWorkflow["branchA"]["reviews"][number]) =>
    review.threadId === threadId
      ? {
          ...review,
          status: "completed" as const,
          error: null,
          updatedAt,
        }
      : review;

  const completeBranch = (branch: PlanningWorkflow["branchA"]): PlanningWorkflow["branchA"] => {
    const reviews = branch.reviews.map(completeReview);
    const complete = reviews.length > 0 && reviews.every((entry) => entry.status === "completed");
    return {
      ...branch,
      reviews,
      status: complete ? "reviews_saved" : "reviews_requested",
      error: null,
      errorStage: null,
      updatedAt,
    };
  };

  return {
    ...workflow,
    branchA: branchId === "a" ? completeBranch(workflow.branchA) : workflow.branchA,
    branchB: branchId === "b" ? completeBranch(workflow.branchB) : workflow.branchB,
    updatedAt,
  };
}

function markPlanningReviewError(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  threadId: ThreadId,
  error: string,
  updatedAt: string,
): PlanningWorkflow {
  const branch = branchId === "a" ? workflow.branchA : workflow.branchB;
  const review = branch.reviews.find((entry) => entry.threadId === threadId);
  if (branch.status !== "reviews_requested" || review?.status !== "running") {
    return workflow;
  }

  const updatedBranch: PlanningWorkflow["branchA"] = {
    ...branch,
    reviews: branch.reviews.map((review) =>
      review.threadId === threadId
        ? {
            ...review,
            status: "error" as const,
            error,
            updatedAt,
          }
        : review,
    ),
    status: "reviews_requested",
    error: null,
    errorStage: null,
    updatedAt,
  };

  return {
    ...workflow,
    branchA: branchId === "a" ? updatedBranch : workflow.branchA,
    branchB: branchId === "b" ? updatedBranch : workflow.branchB,
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
            errorStage: null,
            updatedAt,
          }
        : workflow.branchA,
    branchB:
      branchId === "b"
        ? {
            ...workflow.branchB,
            status: "revising",
            error: null,
            errorStage: null,
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
            errorStage: null,
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
            errorStage: null,
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

function repinManualReviewApprovedPlan(
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

function incrementPlanningReviewRetryCount(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  threadId: ThreadId,
  updatedAt: string,
): PlanningWorkflow {
  const updateBranch = (branch: PlanningWorkflow["branchA"]): PlanningWorkflow["branchA"] => ({
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

  return {
    ...workflow,
    branchA: branchId === "a" ? updateBranch(workflow.branchA) : workflow.branchA,
    branchB: branchId === "b" ? updateBranch(workflow.branchB) : workflow.branchB,
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

// `mergeThread.proposedPlans` comes from the retention-capped read model
// (MAX_THREAD_PROPOSED_PLANS). This is safe because a "Merge" thread is an
// ephemeral, single-purpose workflow thread that produces on the order of one
// proposed plan, far below the cap, so the pinned `approvedPlanId` is always
// retained. The `.at(-1)` fallback additionally returns the most recent plan
// (the merge plan) if the pinned id is ever absent.
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

function resolveMergedPlanForImplementation(
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

export const makeWorkflowService = Effect.gen(function* () {
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const gitCore = yield* GitCore;
  const serverConfig = yield* ServerConfig;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);

  const getWorkflowProviders =
    providerRegistry._tag === "Some" ? providerRegistry.value.getProviders : Effect.succeed([]);
  const orchestrationEngine = withWorkflowModelSelectionGuard(
    baseOrchestrationEngine,
    getWorkflowProviders,
  );

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
    }) => Effect.Effect<unknown, OrchestrationDispatchError | Error> | null;
  }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(AUTO_RETRY_BACKOFF_MS));
      const snapshot = yield* orchestrationEngine.getReadModel();
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

  const forkPlanningReviewAutoRetry = (input: {
    readonly workflowId: PlanningWorkflowId;
    readonly branchId: "a" | "b";
    readonly threadId: ThreadId;
    readonly expectedRetryCount: number;
    readonly originalError: string;
  }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(AUTO_RETRY_BACKOFF_MS));
      const snapshot = yield* orchestrationEngine.getReadModel();
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

      const branch = input.branchId === "a" ? workflow.branchA : workflow.branchB;
      const review = branch.reviews.find((entry) => entry.threadId === input.threadId);
      if (
        branch.status !== "reviews_requested" ||
        review?.status !== "running" ||
        review.retryCount !== input.expectedRetryCount
      ) {
        return;
      }

      const retryThread = snapshot.threads.find((thread) => thread.id === input.threadId);
      if (hasActiveRunningTurn(retryThread)) {
        return;
      }
      if (!retryThread) {
        return yield* Effect.fail(new Error("Review thread not found for automatic retry."));
      }
      const planMarkdown = completedProposedPlanForTurn(
        snapshot,
        branch.authorThreadId,
        branch.planTurnId,
      )?.planMarkdown;
      if (!planMarkdown) {
        return yield* Effect.fail(new Error("Saved plan not found for automatic review retry."));
      }
      const reviewerSlot =
        review.slot === "self"
          ? branch.authorSlot
          : input.branchId === "a"
            ? workflow.branchB.authorSlot
            : workflow.branchA.authorSlot;
      yield* startReviewTurn({
        orchestrationEngine,
        workflow,
        reviewerSlot,
        reviewThreadId: review.threadId,
        planMarkdown,
        reviewKind: review.slot,
        createdAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("WorkflowService.autoRetryDispatch failed", {
            kind: "planning_review",
            workflowId: input.workflowId,
            threadId: input.threadId,
            cause,
          });
          const snapshot = yield* orchestrationEngine.getReadModel();
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
          const branch = input.branchId === "a" ? workflow.branchA : workflow.branchB;
          const review = branch.reviews.find((entry) => entry.threadId === input.threadId);
          if (
            branch.status !== "reviews_requested" ||
            review?.status !== "running" ||
            review.retryCount !== input.expectedRetryCount
          ) {
            return;
          }
          const failedAt = new Date().toISOString();
          yield* upsertWorkflow(
            markPlanningReviewError(
              workflow,
              input.branchId,
              input.threadId,
              `${input.originalError} | Automatic retry failed: ${Cause.pretty(cause)}`,
              failedAt,
            ),
          );
        }),
      ),
      Effect.forkScoped,
    );

  const titleGenerationWorker = yield* makeDrainableWorker(
    (item: WorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
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

        const latestSnapshot = yield* orchestrationEngine.getReadModel();
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

  const reviewFeedbackForBranch = (
    branch: PlanningWorkflow["branchA"],
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
  ) =>
    Effect.forEach(
      branch.reviews.toSorted((left, right) => compareWorkflowReviewSlots(left.slot, right.slot)),
      (review) =>
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
        }),
    ).pipe(
      Effect.map((reviews) =>
        reviews.filter(
          (review): review is { reviewerLabel: string; reviewMarkdown: string } => review !== null,
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

  const completedProposedPlanForTurn = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    expectedTurnId: string | null,
  ): { readonly planMarkdown: string } | null => {
    if (!expectedTurnId) {
      return null;
    }

    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread?.latestTurn || thread.latestTurn.turnId !== expectedTurnId) {
      return null;
    }
    if (thread.latestTurn.state !== "completed") {
      return null;
    }
    if (thread.session?.status === "running" && thread.session.activeTurnId === expectedTurnId) {
      return null;
    }

    return thread.proposedPlans.find((plan) => plan.turnId === expectedTurnId) ?? null;
  };

  const maybeStartReviews = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
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

      const planA = completedProposedPlanForTurn(
        snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.planTurnId,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.planTurnId,
      )?.planMarkdown;
      if (!planA || !planB) {
        return;
      }

      const budgetError = workflowBudgetError(workflow);
      if (budgetError) {
        yield* upsertWorkflow(markMergeError(workflow, budgetError.message, updatedAt));
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

      const branchAReviewTexts = yield* reviewFeedbackForBranch(workflow.branchA, snapshot);
      const branchBReviewTexts = yield* reviewFeedbackForBranch(workflow.branchB, snapshot);

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
    snapshot: OrchestrationReadModel,
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

      const planA = completedProposedPlanForTurn(
        snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.revisionTurnId,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.revisionTurnId,
      )?.planMarkdown;
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
        ...workflowTurnProviderFields(workflow.merge.mergeSlot),
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
    options?: {
      readonly expectedTurnId?: TurnId | null;
    },
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
        const turnId = getFinishedLatestTurnId(thread);
        if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId)) {
          return workflow;
        }
        if (branch.status === "revised") {
          if (
            workflow.merge.status !== "not_started" ||
            turnId === branch.revisionTurnId ||
            !thread.latestTurn ||
            thread.latestTurn.requestedAt <= branch.updatedAt
          ) {
            return workflow;
          }

          if (!hasProposedPlanForTurn(thread, turnId)) {
            const synthesized = yield* maybeSynthesizeProposedPlan({
              thread,
              turnId,
              createdAt: updatedAt,
            });
            if (!synthesized) {
              return workflow;
            }
          }

          const nextWorkflow = markBranchRevised(workflow, authorBranchId, {
            turnId,
            updatedAt,
          });
          yield* Effect.logInfo("workflow revised branch repinned to newer completed turn", {
            workflowId: workflow.id,
            branchId: authorBranchId,
            previousTurnId: branch.revisionTurnId,
            replacementTurnId: turnId,
          });
          yield* upsertWorkflow(nextWorkflow);
          return nextWorkflow;
        }
        if (branch.status === "plan_saved") {
          if (
            branch.reviews.length > 0 ||
            workflow.merge.status !== "not_started" ||
            turnId === branch.planTurnId ||
            !thread.latestTurn ||
            thread.latestTurn.requestedAt < branch.updatedAt ||
            !hasProposedPlanForTurn(thread, turnId)
          ) {
            return workflow;
          }

          const nextWorkflow = markBranchPlanSaved(workflow, authorBranchId, {
            turnId,
            updatedAt,
          });
          if (nextWorkflow !== workflow) {
            yield* upsertWorkflow(nextWorkflow);
          }
          return nextWorkflow;
        }
        const failureStage = planningWorkflowBranchFailureStage(branch);
        const isRevisionCompletion = branch.status === "revising" || failureStage === "revision";
        const isAuthoringCompletion = branch.status === "authoring" || failureStage === "authoring";
        if (!isAuthoringCompletion && !isRevisionCompletion) {
          return workflow;
        }
        if (isRevisionCompletion && turnId === branch.planTurnId) {
          return workflow;
        }
        const completionEvidenceAt =
          thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? null;
        if (!completionEvidenceAt || completionEvidenceAt < branch.updatedAt) {
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

        const nextWorkflow = isRevisionCompletion
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
        const finishedTurn = getFinishedConsumableLatestTurn(thread);
        if (
          (review?.status !== "running" && review?.status !== "error") ||
          !finishedTurn ||
          (review.status === "error" &&
            (thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? "") <
              review.updatedAt)
        ) {
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

      if (
        workflow.merge.threadId !== threadId ||
        (workflow.merge.status !== "in_progress" && workflow.merge.status !== "error")
      ) {
        return workflow;
      }

      const turnId = getFinishedLatestTurnId(thread);
      if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId)) {
        return workflow;
      }
      const mergeCompletionEvidenceAt =
        thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? null;
      if (
        workflow.merge.status === "error" &&
        (!mergeCompletionEvidenceAt || mergeCompletionEvidenceAt < workflow.merge.updatedAt)
      ) {
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

      const budgetError = workflowBudgetError(workflow);
      if (budgetError) {
        yield* upsertWorkflow(markImplementationError(workflow, budgetError.message, updatedAt));
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
        ...workflowTurnProviderFields(workflow.implementation.implementationSlot),
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
        const failedCodeReviews = workflow.implementation.codeReviews.some(
          (review) => review.status === "error",
        );
        const completionEvidenceAt =
          thread?.latestTurn?.completedAt ?? thread?.latestTurn?.requestedAt ?? null;
        const recoveredStatus =
          workflow.implementation.status === "error" &&
          !failedCodeReviews &&
          completionEvidenceAt &&
          completionEvidenceAt >= workflow.implementation.updatedAt
            ? workflow.implementation.codeReviews.length > 0 &&
              workflow.implementation.codeReviews.every((review) => review.status === "completed")
              ? "applying_reviews"
              : "implementing"
            : workflow.implementation.status;
        nextWorkflow =
          recoveredStatus === "implementing"
            ? markImplementationDone(workflow, completedTurn.turnId, updatedAt)
            : recoveredStatus === "applying_reviews"
              ? markImplementationCompleted(workflow, completedTurn.turnId, updatedAt)
              : workflow;
      } else {
        const review = workflow.implementation.codeReviews.find(
          (entry) => entry.threadId === threadId,
        );
        const completionEvidenceAt =
          thread?.latestTurn?.completedAt ?? thread?.latestTurn?.requestedAt ?? null;
        nextWorkflow =
          review?.status === "running" ||
          (review?.status === "error" &&
            completionEvidenceAt !== null &&
            completionEvidenceAt >= review.updatedAt)
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
      const budgetError = workflowBudgetError(input.workflow);
      if (budgetError) return yield* Effect.fail(new Error(budgetError.message));

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
        ...workflowTurnProviderFields(input.workflow.implementation.implementationSlot),
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
    const snapshot = yield* orchestrationEngine.getReadModel();
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
      const legacyReviewErrors = new Map<"a" | "b", string>();

      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
        if (branch.status !== "error" || branch.errorStage !== null) {
          continue;
        }
        const legacyStage = planningWorkflowBranchFailureStage(branch);
        if (legacyStage === "reviews" && branch.error) {
          legacyReviewErrors.set(branchId, branch.error);
          continue;
        }
        const repairedBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          errorStage: legacyStage === "revision" ? "revision" : "authoring",
          updatedAt,
        };
        reconciledWorkflow = {
          ...reconciledWorkflow,
          branchA: branchId === "a" ? repairedBranch : reconciledWorkflow.branchA,
          branchB: branchId === "b" ? repairedBranch : reconciledWorkflow.branchB,
          updatedAt,
        };
      }
      if (reconciledWorkflow !== workflow) {
        yield* upsertWorkflow(reconciledWorkflow);
      }

      const refreshWorkflowFromSnapshot = Effect.gen(function* () {
        latestSnapshot = yield* orchestrationEngine.getReadModel();
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

      for (const [branchId, legacyError] of legacyReviewErrors) {
        const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
        if (branch.reviews.length === 0) {
          const repairedBranch: PlanningWorkflow["branchA"] = {
            ...branch,
            status: "plan_saved",
            error: null,
            errorStage: null,
            updatedAt,
          };
          reconciledWorkflow = {
            ...reconciledWorkflow,
            branchA: branchId === "a" ? repairedBranch : reconciledWorkflow.branchA,
            branchB: branchId === "b" ? repairedBranch : reconciledWorkflow.branchB,
            updatedAt,
          };
          continue;
        }
        if (branch.reviews.every((review) => review.status === "completed")) {
          continue;
        }
        const repairedBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          reviews: branch.reviews.map((review) => {
            if (review.status === "completed") {
              return review;
            }
            const reviewThread = latestSnapshot.threads.find(
              (thread) => thread.id === review.threadId,
            );
            const sessionError = reviewThread?.session?.lastError
              ? formatSessionError(reviewThread.session, "Review failed.")
              : null;
            return {
              ...review,
              status: "error" as const,
              error: review.error ?? sessionError ?? legacyError,
              updatedAt,
            };
          }),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        reconciledWorkflow = {
          ...reconciledWorkflow,
          branchA: branchId === "a" ? repairedBranch : reconciledWorkflow.branchA,
          branchB: branchId === "b" ? repairedBranch : reconciledWorkflow.branchB,
          updatedAt,
        };
        yield* upsertWorkflow(reconciledWorkflow);
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
              branch.error ??
              (authorThread?.session?.lastError
                ? formatSessionError(
                    authorThread.session,
                    branch.status === "revising"
                      ? "Revision session was not running during reconciliation."
                      : "Authoring session was not running during reconciliation.",
                  )
                : branch.status === "revising"
                  ? "Revision session was not running during reconciliation."
                  : "Authoring session was not running during reconciliation."),
            stage: branch.status === "revising" ? "revision" : "authoring",
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
            const error =
              review.error ??
              (reviewThread?.session?.lastError
                ? formatSessionError(
                    reviewThread.session,
                    "Review session was not running during reconciliation.",
                  )
                : (legacyReviewErrors.get(branchId) ??
                  "Review session was not running during reconciliation."));
            reconciledWorkflow = markPlanningReviewError(
              reconciledWorkflow,
              branchId,
              review.threadId,
              error,
              updatedAt,
            );
            yield* upsertWorkflow(reconciledWorkflow);
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
    const snapshot = yield* orchestrationEngine.getReadModel();
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
          const planningWorkflow =
            workflowForAuthorThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForMergeThread(readModel.planningWorkflows, event.payload.threadId)?.workflow ??
            null;
          if (!planningWorkflow) {
            return;
          }

          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            planningWorkflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.proposedPlan.turnId },
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
          if (
            nextWorkflow.merge.threadId === event.payload.threadId &&
            nextWorkflow.merge.status === "manual_review" &&
            nextWorkflow.implementation === null &&
            event.payload.proposedPlan.implementedAt === null
          ) {
            yield* upsertWorkflow(
              repinManualReviewApprovedPlan(nextWorkflow, {
                proposedPlanId: event.payload.proposedPlan.id,
                turnId: event.payload.proposedPlan.turnId,
                updatedAt: event.occurredAt,
              }),
            );
          }
          return;
        }

        case "thread.turn-diff-completed": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const match = workflowForReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (match) {
            const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              match.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            const lifecycleSnapshot =
              nextWorkflow !== match.workflow
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
            yield* maybeContinuePlanningWorkflowLifecycle(
              nextWorkflow,
              lifecycleSnapshot,
              event.occurredAt,
            );
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
            const canAdvanceAuthor =
              branch.status === "authoring" ||
              branch.status === "revising" ||
              (branch.status === "revised" && authorMatch.workflow.merge.status === "not_started");
            if (authorThread && canAdvanceAuthor) {
              const synthesized = yield* maybeSynthesizeProposedPlan({
                thread: authorThread,
                turnId: event.payload.turnId,
                createdAt: event.occurredAt,
              });
              const nextReadModel = synthesized
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
              const nextAuthorMatch =
                workflowForAuthorThread(nextReadModel.planningWorkflows, event.payload.threadId) ??
                authorMatch;
              const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
                nextAuthorMatch.workflow,
                nextReadModel,
                event.payload.threadId,
                event.occurredAt,
                { expectedTurnId: event.payload.turnId },
              );
              const lifecycleSnapshot =
                nextWorkflow !== nextAuthorMatch.workflow
                  ? yield* orchestrationEngine.getReadModel()
                  : nextReadModel;
              yield* maybeContinuePlanningWorkflowLifecycle(
                nextWorkflow,
                lifecycleSnapshot,
                event.occurredAt,
              );
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

          const synthesized = yield* maybeSynthesizeProposedPlan({
            thread: mergeThread,
            turnId: event.payload.turnId,
            createdAt: event.occurredAt,
          });
          const nextReadModel = synthesized ? yield* orchestrationEngine.getReadModel() : readModel;
          const nextMergeWorkflow =
            workflowForMergeThread(nextReadModel.planningWorkflows, event.payload.threadId)
              ?.workflow ?? mergeWorkflow;
          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            nextMergeWorkflow,
            nextReadModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.turnId },
          );
          const lifecycleSnapshot =
            nextWorkflow !== nextMergeWorkflow
              ? yield* orchestrationEngine.getReadModel()
              : nextReadModel;
          yield* maybeContinuePlanningWorkflowLifecycle(
            nextWorkflow,
            lifecycleSnapshot,
            event.occurredAt,
          );
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
            const baseWorkflow = applyTurnCost(reviewMatch.workflow);
            const reviewedBranch =
              reviewMatch.branchId === "a" ? baseWorkflow.branchA : baseWorkflow.branchB;
            const review = reviewedBranch.reviews.find(
              (entry) => entry.threadId === event.payload.threadId,
            );
            const reviewThread = readModel.threads.find(
              (thread) => thread.id === event.payload.threadId,
            );
            const acceptedFailedTurn =
              reviewThread?.latestTurn?.state === "error" &&
              reviewThread.latestTurn.requestedAt >= (review?.updatedAt ?? event.occurredAt);
            if (
              reviewedBranch.status === "reviews_requested" &&
              review?.status === "running" &&
              acceptedFailedTurn &&
              isRetryableSessionError(event.payload.session.lastError) &&
              review.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const retryWorkflow = incrementPlanningReviewRetryCount(
                baseWorkflow,
                reviewMatch.branchId,
                event.payload.threadId,
                event.occurredAt,
              );
              const expectedRetryCount =
                (reviewMatch.branchId === "a"
                  ? retryWorkflow.branchA
                  : retryWorkflow.branchB
                ).reviews.find((entry) => entry.threadId === event.payload.threadId)?.retryCount ??
                0;
              yield* upsertWorkflow(retryWorkflow);
              yield* forkPlanningReviewAutoRetry({
                workflowId: retryWorkflow.id,
                branchId: reviewMatch.branchId,
                threadId: event.payload.threadId,
                expectedRetryCount,
                originalError: formatSessionError(event.payload.session, "Review failed."),
              });
              return;
            }

            yield* upsertWorkflow(
              markPlanningReviewError(
                baseWorkflow,
                reviewMatch.branchId,
                event.payload.threadId,
                formatSessionError(event.payload.session, "Review failed."),
                event.occurredAt,
              ),
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
                stage: branch.status === "revising" ? "revision" : "authoring",
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

  const createWorkflow: WorkflowServiceShape["createWorkflow"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const input: CreateWorkflowInput = {
        ...rawInput,
        branchA: resolveAvailableWorkflowModelSlot(rawInput.branchA, providers),
        branchB: resolveAvailableWorkflowModelSlot(rawInput.branchB, providers),
        merge: resolveAvailableWorkflowModelSlot(rawInput.merge, providers),
      };
      const snapshot = yield* orchestrationEngine.getReadModel();
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
        maxCostUsd: input.maxCostUsd,
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
        maxCostUsd: input.maxCostUsd ?? null,
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

  const startImplementation: WorkflowServiceShape["startImplementation"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const implementationSlot = resolveAvailableWorkflowModelSlot(
        {
          provider: rawInput.provider,
          model: rawInput.model,
          ...(rawInput.modelOptions ? { modelOptions: rawInput.modelOptions } : {}),
          ...(rawInput.providerOptions ? { providerOptions: rawInput.providerOptions } : {}),
        },
        providers,
      );
      const input = {
        ...rawInput,
        provider: implementationSlot.provider,
        model: implementationSlot.model,
        ...(implementationSlot.modelOptions
          ? { modelOptions: implementationSlot.modelOptions }
          : { modelOptions: undefined }),
        ...(implementationSlot.providerOptions
          ? { providerOptions: implementationSlot.providerOptions }
          : { providerOptions: undefined }),
      };
      const workflow = yield* readWorkflow(orchestrationEngine, input.workflowId).pipe(
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
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* budgetError;

      const snapshot = yield* orchestrationEngine.getReadModel();
      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      if (!mergeThread) {
        return yield* Effect.fail(new Error("Merge thread not found."));
      }

      const now = new Date().toISOString();
      const {
        workflow: implementationWorkflow,
        mergedPlan,
        repinned,
      } = resolveMergedPlanForImplementation(workflow, mergeThread, now);
      if (!mergedPlan?.planMarkdown) {
        return yield* Effect.fail(new Error("Merged plan not found."));
      }
      if (repinned) {
        yield* upsertWorkflow(implementationWorkflow);
      }

      const envMode = input.envMode ?? "local";
      const workspaceRoot =
        snapshot.projects.find(
          (project) =>
            project.id === implementationWorkflow.projectId && project.deletedAt === null,
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
        const newBranch = buildTemporaryWorktreeBranchName();
        const createdWorktree = yield* gitCore
          .createWorktree({
            cwd: workspaceRoot,
            branch: input.baseBranch,
            newBranch,
            path: resolveDefaultWorktreePath({
              worktreesDir: serverConfig.worktreesDir,
              cwd: workspaceRoot,
              branch: newBranch,
            }),
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

      const implementationThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
      const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
      const codeReviewEnabled = input.codeReviewEnabled ?? true;

      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: implementationThreadId,
        projectId: implementationWorkflow.projectId,
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
            workflow: implementationWorkflow,
            mergedPlanMarkdown: mergedPlan.planMarkdown,
            provider: input.provider,
          }),
          attachments: [],
        },
        ...workflowTurnProviderFields(implementationSlot),
        titleSourceText: implementationWorkflow.title,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        sourceProposedPlan: {
          threadId: mergeThread.id,
          planId: mergedPlan.id,
        },
        createdAt: now,
      });

      yield* upsertWorkflow({
        ...implementationWorkflow,
        implementation: {
          implementationSlot: {
            provider: input.provider,
            model: input.model,
            ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
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
      const workflow = yield* readWorkflow(orchestrationEngine, workflowId).pipe(
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
      const workflow = yield* readWorkflow(orchestrationEngine, workflowId).pipe(
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
      const workflow = yield* readWorkflow(orchestrationEngine, workflowId).pipe(
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

  const retryWorkflow: WorkflowServiceShape["retryWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(orchestrationEngine, input.workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }

      const updatedAt = new Date().toISOString();
      const failedThreadIds = new Set<ThreadId>();
      for (const branch of [workflow.branchA, workflow.branchB]) {
        const stage = planningWorkflowBranchFailureStage(branch);
        if (stage === "authoring" || stage === "revision") {
          failedThreadIds.add(branch.authorThreadId);
        }
        for (const review of branch.reviews) {
          if (review.status === "error" || (stage === "reviews" && review.status !== "completed")) {
            failedThreadIds.add(review.threadId);
          }
        }
      }
      if (workflow.merge.status === "error" && workflow.merge.threadId) {
        failedThreadIds.add(workflow.merge.threadId);
      }
      if (workflow.implementation?.status === "error") {
        const failedCodeReviews = workflow.implementation.codeReviews.filter(
          (review) => review.status === "error",
        );
        if (failedCodeReviews.length > 0) {
          for (const review of failedCodeReviews) {
            failedThreadIds.add(review.threadId);
          }
        } else if (workflow.implementation.threadId) {
          failedThreadIds.add(workflow.implementation.threadId);
        }
      }

      const deliveryStateByThread = new Map<
        ThreadId,
        "pending" | "sending" | "accepted" | "rejected" | "ambiguous"
      >();
      let ambiguousThreadIds: ThreadId[] = [];
      if (providerTurnDeliveryWorker._tag === "Some") {
        const deliveries = yield* Effect.forEach([...failedThreadIds], (threadId) =>
          providerTurnDeliveryWorker.value.recheck(threadId).pipe(
            Effect.map((delivery) => ({ threadId, delivery })),
            Effect.mapError(
              (error) =>
                new Error(
                  `Could not verify provider delivery for thread '${threadId}'. Retry after the provider reconnects.`,
                  { cause: error },
                ),
            ),
          ),
        );
        ambiguousThreadIds = deliveries
          .filter(({ delivery }) => delivery?.state === "ambiguous")
          .map(({ threadId }) => threadId);

        for (const { threadId, delivery } of deliveries) {
          if (
            delivery?.state === "pending" ||
            delivery?.state === "sending" ||
            delivery?.state === "accepted" ||
            delivery?.state === "rejected" ||
            delivery?.state === "ambiguous"
          ) {
            deliveryStateByThread.set(threadId, delivery.state);
          }
        }
      }

      const snapshot = yield* orchestrationEngine.getReadModel();
      const deliveryMode = (
        threadId: ThreadId | null,
      ): "fresh" | "accepted" | "queued" | "retry" => {
        if (!threadId) return "fresh";
        switch (deliveryStateByThread.get(threadId)) {
          case "accepted":
            return "accepted";
          case "pending":
          case "sending":
            return "queued";
          case "rejected":
          case "ambiguous":
            return "retry";
          default:
            return "fresh";
        }
      };
      let retriedWorkflow = workflow;
      const handledAcceptedThreadIds = new Set<ThreadId>();
      const setReviewRunning = (
        current: PlanningWorkflow,
        branchId: "a" | "b",
        threadId: ThreadId,
      ): PlanningWorkflow => {
        const branch = branchId === "a" ? current.branchA : current.branchB;
        const nextBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          reviews: branch.reviews.map((review) =>
            review.threadId === threadId
              ? {
                  ...review,
                  status: "running" as const,
                  error: null,
                  retryCount: 0,
                  lastRetryAt: null,
                  updatedAt,
                }
              : review,
          ),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        return {
          ...current,
          branchA: branchId === "a" ? nextBranch : current.branchA,
          branchB: branchId === "b" ? nextBranch : current.branchB,
          updatedAt,
        };
      };
      const setCodeReviewRunning = (
        current: PlanningWorkflow,
        threadId: ThreadId,
      ): PlanningWorkflow => {
        if (!current.implementation) return current;
        const reviews = current.implementation.codeReviews.map((review) =>
          review.threadId === threadId
            ? {
                ...review,
                status: "running" as const,
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt,
              }
            : review,
        );
        const hasErrors = reviews.some((review) => review.status === "error");
        return {
          ...current,
          implementation: {
            ...current.implementation,
            codeReviews: reviews,
            status: hasErrors ? "error" : "code_reviews_requested",
            error: hasErrors ? current.implementation.error : null,
            updatedAt,
          },
          updatedAt,
        };
      };

      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? workflow.branchA : workflow.branchB;
        const stage = planningWorkflowBranchFailureStage(branch);
        for (const review of branch.reviews) {
          if (
            deliveryMode(review.threadId) !== "accepted" ||
            (review.status !== "error" && !(stage === "reviews" && review.status !== "completed"))
          ) {
            continue;
          }
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            review.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            retriedWorkflow = setReviewRunning(retriedWorkflow, branchId, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(review.threadId);
        }

        if (
          (stage === "authoring" || stage === "revision") &&
          deliveryMode(branch.authorThreadId) === "accepted"
        ) {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            branch.authorThreadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            const currentBranch =
              branchId === "a" ? retriedWorkflow.branchA : retriedWorkflow.branchB;
            const nextBranch: PlanningWorkflow["branchA"] = {
              ...currentBranch,
              status: stage === "revision" ? "revising" : "authoring",
              error: null,
              errorStage: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt,
            };
            retriedWorkflow = {
              ...retriedWorkflow,
              branchA: branchId === "a" ? nextBranch : retriedWorkflow.branchA,
              branchB: branchId === "b" ? nextBranch : retriedWorkflow.branchB,
              updatedAt,
            };
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(branch.authorThreadId);
        }
      }

      if (
        workflow.merge.status === "error" &&
        workflow.merge.threadId &&
        deliveryMode(workflow.merge.threadId) === "accepted"
      ) {
        const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
          retriedWorkflow,
          snapshot,
          workflow.merge.threadId,
          updatedAt,
        );
        if (completedWorkflow === retriedWorkflow) {
          retriedWorkflow = markMergeStarted(retriedWorkflow, workflow.merge.threadId, updatedAt);
          yield* upsertWorkflow(retriedWorkflow);
        } else {
          retriedWorkflow = completedWorkflow;
        }
        handledAcceptedThreadIds.add(workflow.merge.threadId);
      }

      if (workflow.implementation?.status === "error") {
        const failedReviews = workflow.implementation.codeReviews.filter(
          (review) => review.status === "error",
        );
        for (const review of failedReviews) {
          if (deliveryMode(review.threadId) !== "accepted") {
            continue;
          }
          const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
            retriedWorkflow,
            snapshot,
            review.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            retriedWorkflow = setCodeReviewRunning(retriedWorkflow, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(review.threadId);
        }

        if (
          failedReviews.length === 0 &&
          workflow.implementation.threadId &&
          deliveryMode(workflow.implementation.threadId) === "accepted"
        ) {
          const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
            retriedWorkflow,
            snapshot,
            workflow.implementation.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow && retriedWorkflow.implementation) {
            const implementation = retriedWorkflow.implementation;
            const retryStatus =
              implementation.codeReviews.length > 0 &&
              implementation.codeReviews.every((review) => review.status === "completed")
                ? "applying_reviews"
                : "implementing";
            retriedWorkflow = {
              ...retriedWorkflow,
              implementation: {
                ...implementation,
                status: retryStatus,
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt,
              },
              updatedAt,
            };
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(workflow.implementation.threadId);
        }
      }
      if (ambiguousThreadIds.length > 0 && !input.allowPossibleDuplicate) {
        return {
          status: "confirmation_required" as const,
          threadIds: ambiguousThreadIds,
        };
      }
      const retriesLegacyReviewSetup = [workflow.branchA, workflow.branchB].some(
        (branch) =>
          planningWorkflowBranchFailureStage(branch) === "reviews" && branch.reviews.length === 0,
      );

      const willSpend =
        [...failedThreadIds].some((threadId) => {
          const mode = deliveryMode(threadId);
          return mode === "fresh" || mode === "retry";
        }) ||
        retriesLegacyReviewSetup ||
        (workflow.merge.status === "error" &&
          (!workflow.merge.threadId || deliveryMode(workflow.merge.threadId) === "fresh"));
      if (willSpend) {
        const budgetError = workflowBudgetError(workflow);
        if (budgetError) {
          return yield* Effect.fail(new Error(budgetError.message));
        }
      }

      const planForBranch = (branch: PlanningWorkflow["branchA"]) =>
        completedProposedPlanForTurn(snapshot, branch.authorThreadId, branch.planTurnId)
          ?.planMarkdown ?? null;

      if (retriesLegacyReviewSetup) {
        const prospectiveStatuses = [workflow.branchA, workflow.branchB].map((branch) =>
          planningWorkflowBranchFailureStage(branch) === "reviews" && branch.reviews.length === 0
            ? "plan_saved"
            : branch.status,
        );
        if (prospectiveStatuses.some((status) => status !== "plan_saved")) {
          return yield* Effect.fail(
            new Error("Review setup cannot be retried until both branch plans are saved."),
          );
        }
        if (!planForBranch(workflow.branchA) || !planForBranch(workflow.branchB)) {
          return yield* Effect.fail(new Error("Saved branch plans not found for review retry."));
        }
      }

      const reviewPlans = new Map<ThreadId, string>();
      const revisionFeedback = new Map<
        "a" | "b",
        ReadonlyArray<{
          readonly reviewerLabel: string;
          readonly reviewMarkdown: string;
        }>
      >();

      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? workflow.branchA : workflow.branchB;
        const stage = planningWorkflowBranchFailureStage(branch);
        for (const review of branch.reviews) {
          if (
            review.status !== "error" &&
            !(stage === "reviews" && review.status !== "completed")
          ) {
            continue;
          }
          if (deliveryMode(review.threadId) !== "fresh") {
            continue;
          }
          const planMarkdown = planForBranch(branch);
          if (!planMarkdown) {
            return yield* Effect.fail(
              new Error(`Saved plan not found for Branch ${branchId.toUpperCase()} review retry.`),
            );
          }
          reviewPlans.set(review.threadId, planMarkdown);
        }

        if (stage === "revision" && deliveryMode(branch.authorThreadId) === "fresh") {
          const feedback = yield* reviewFeedbackForBranch(branch, snapshot);
          if (feedback.length === 0) {
            return yield* Effect.fail(
              new Error(`Review feedback not found for Branch ${branchId.toUpperCase()} revision.`),
            );
          }
          revisionFeedback.set(branchId, feedback);
        }
      }

      if (workflow.merge.status === "error" && deliveryMode(workflow.merge.threadId) === "fresh") {
        const planA = completedProposedPlanForTurn(
          snapshot,
          workflow.branchA.authorThreadId,
          workflow.branchA.revisionTurnId,
        )?.planMarkdown;
        const planB = completedProposedPlanForTurn(
          snapshot,
          workflow.branchB.authorThreadId,
          workflow.branchB.revisionTurnId,
        )?.planMarkdown;
        if (!planA || !planB) {
          return yield* Effect.fail(new Error("Revised plans not found for merge retry."));
        }
      }

      let mergedPlanMarkdown: string | null = null;
      const failedCodeReviews =
        workflow.implementation?.status === "error"
          ? workflow.implementation.codeReviews.filter((review) => review.status === "error")
          : [];
      if (failedCodeReviews.some((review) => deliveryMode(review.threadId) === "fresh")) {
        const mergeThread = snapshot.threads.find(
          (thread) => thread.id === workflow.merge.threadId,
        );
        mergedPlanMarkdown = mergeThread
          ? (resolveApprovedMergedPlan(workflow, mergeThread)?.planMarkdown ?? null)
          : null;
        if (!mergedPlanMarkdown) {
          return yield* Effect.fail(new Error("Merged plan not found for code review retry."));
        }
      }

      let implementationThread: OrchestrationReadModel["threads"][number] | null = null;
      if (workflow.implementation?.status === "error" && failedCodeReviews.length === 0) {
        if (!workflow.implementation.threadId) {
          return yield* Effect.fail(new Error("Implementation thread not found for retry."));
        }
        if (deliveryMode(workflow.implementation.threadId) === "fresh") {
          implementationThread =
            snapshot.threads.find((thread) => thread.id === workflow.implementation?.threadId) ??
            null;
          if (!implementationThread) {
            return yield* Effect.fail(new Error("Implementation thread not found for retry."));
          }
          const latestUserMessage = implementationThread.messages
            .toReversed()
            .find((message) => message.role === "user" && !message.streaming);
          if (!latestUserMessage) {
            return yield* Effect.fail(
              new Error(
                `Implementation retry message not found for thread '${implementationThread.id}'.`,
              ),
            );
          }
        }
      }

      if (providerTurnDeliveryWorker._tag === "Some") {
        yield* Effect.forEach(
          [...failedThreadIds].filter((threadId) => deliveryMode(threadId) === "retry"),
          (threadId) =>
            providerTurnDeliveryWorker.value.retry({
              threadId,
              allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
            }),
          { discard: true },
        );
      }

      const preserveLegacyReviewError = (
        current: PlanningWorkflow,
        branchId: "a" | "b",
        threadId: ThreadId,
        legacyError: string,
      ): PlanningWorkflow => {
        const branch = branchId === "a" ? current.branchA : current.branchB;
        const nextBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          reviews: branch.reviews.map((review) =>
            review.threadId === threadId && review.status !== "completed"
              ? { ...review, status: "error" as const, error: review.error ?? legacyError }
              : review,
          ),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        return {
          ...current,
          branchA: branchId === "a" ? nextBranch : current.branchA,
          branchB: branchId === "b" ? nextBranch : current.branchB,
          updatedAt,
        };
      };

      for (const branchId of ["a", "b"] as const) {
        const originalBranch = branchId === "a" ? workflow.branchA : workflow.branchB;
        const originalStage = planningWorkflowBranchFailureStage(originalBranch);
        if (originalStage === "reviews" && originalBranch.reviews.length === 0) {
          const repairedBranch: PlanningWorkflow["branchA"] = {
            ...(branchId === "a" ? retriedWorkflow.branchA : retriedWorkflow.branchB),
            status: "plan_saved",
            error: null,
            errorStage: null,
            updatedAt,
          };
          retriedWorkflow = {
            ...retriedWorkflow,
            branchA: branchId === "a" ? repairedBranch : retriedWorkflow.branchA,
            branchB: branchId === "b" ? repairedBranch : retriedWorkflow.branchB,
            updatedAt,
          };
        }
        for (const review of originalBranch.reviews) {
          if (
            review.status !== "error" &&
            !(originalStage === "reviews" && review.status !== "completed")
          ) {
            continue;
          }
          if (handledAcceptedThreadIds.has(review.threadId)) {
            continue;
          }
          const mode = deliveryMode(review.threadId);
          if (mode === "queued" || mode === "retry") {
            if (originalStage === "reviews" && originalBranch.error) {
              retriedWorkflow = preserveLegacyReviewError(
                retriedWorkflow,
                branchId,
                review.threadId,
                originalBranch.error,
              );
              yield* upsertWorkflow(retriedWorkflow);
            }
            continue;
          }
          if (mode === "accepted") {
            const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              retriedWorkflow,
              snapshot,
              review.threadId,
              updatedAt,
            );
            if (completedWorkflow !== retriedWorkflow) {
              retriedWorkflow = completedWorkflow;
              continue;
            }
            retriedWorkflow = setReviewRunning(retriedWorkflow, branchId, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
            continue;
          }
          const branch = branchId === "a" ? retriedWorkflow.branchA : retriedWorkflow.branchB;
          const reviewerSlot =
            review.slot === "self"
              ? branch.authorSlot
              : branchId === "a"
                ? retriedWorkflow.branchB.authorSlot
                : retriedWorkflow.branchA.authorSlot;
          yield* startReviewTurn({
            orchestrationEngine,
            workflow: retriedWorkflow,
            reviewerSlot,
            reviewThreadId: review.threadId,
            planMarkdown: reviewPlans.get(review.threadId)!,
            reviewKind: review.slot,
            createdAt: updatedAt,
          });
          retriedWorkflow = setReviewRunning(retriedWorkflow, branchId, review.threadId);
          yield* upsertWorkflow(retriedWorkflow);
        }

        if (originalStage !== "authoring" && originalStage !== "revision") {
          continue;
        }
        if (handledAcceptedThreadIds.has(originalBranch.authorThreadId)) {
          continue;
        }
        const mode = deliveryMode(originalBranch.authorThreadId);
        if (mode === "queued" || mode === "retry") {
          continue;
        }
        if (mode === "accepted") {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            originalBranch.authorThreadId,
            updatedAt,
          );
          if (completedWorkflow !== retriedWorkflow) {
            retriedWorkflow = completedWorkflow;
            continue;
          }
        }
        const nextBranch: PlanningWorkflow["branchA"] = {
          ...(branchId === "a" ? retriedWorkflow.branchA : retriedWorkflow.branchB),
          status: originalStage === "revision" ? "revising" : "authoring",
          error: null,
          errorStage: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt,
        };
        if (mode === "accepted") {
          retriedWorkflow = {
            ...retriedWorkflow,
            branchA: branchId === "a" ? nextBranch : retriedWorkflow.branchA,
            branchB: branchId === "b" ? nextBranch : retriedWorkflow.branchB,
            updatedAt,
          };
          yield* upsertWorkflow(retriedWorkflow);
          continue;
        }
        if (originalStage === "authoring") {
          yield* startAuthoringTurn({
            orchestrationEngine,
            workflow: retriedWorkflow,
            branch: originalBranch,
            createdAt: updatedAt,
          });
        } else {
          yield* startRevisionTurn({
            orchestrationEngine,
            workflow: retriedWorkflow,
            branch: originalBranch,
            reviews: revisionFeedback.get(branchId)!,
            createdAt: updatedAt,
          });
        }
        retriedWorkflow = {
          ...retriedWorkflow,
          branchA: branchId === "a" ? nextBranch : retriedWorkflow.branchA,
          branchB: branchId === "b" ? nextBranch : retriedWorkflow.branchB,
          updatedAt,
        };
        yield* upsertWorkflow(retriedWorkflow);
      }

      if (retriesLegacyReviewSetup) {
        yield* maybeStartReviews(retriedWorkflow, snapshot, updatedAt);
        const refreshed = yield* orchestrationEngine.getReadModel();
        retriedWorkflow =
          refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
          retriedWorkflow;
      }

      if (retriedWorkflow.merge.status === "error") {
        const mode = deliveryMode(retriedWorkflow.merge.threadId);
        if (mode === "accepted" && retriedWorkflow.merge.threadId) {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            retriedWorkflow.merge.threadId,
            updatedAt,
          );
          if (completedWorkflow !== retriedWorkflow) {
            retriedWorkflow = completedWorkflow;
          } else {
            retriedWorkflow = markMergeStarted(
              retriedWorkflow,
              retriedWorkflow.merge.threadId,
              updatedAt,
            );
            yield* upsertWorkflow(retriedWorkflow);
          }
        } else if (mode === "fresh") {
          const mergeRetryWorkflow: PlanningWorkflow = {
            ...retriedWorkflow,
            merge: {
              ...retriedWorkflow.merge,
              threadId: null,
              turnId: null,
              outputFilePath: null,
              approvedPlanId: null,
              status: "not_started",
              error: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* maybeStartMerge(mergeRetryWorkflow, snapshot, updatedAt);
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
            retriedWorkflow;
        }
      }

      if (retriedWorkflow.implementation?.status === "error") {
        const failedReviews = retriedWorkflow.implementation.codeReviews.filter(
          (review) => review.status === "error",
        );
        if (failedReviews.length > 0) {
          for (const review of failedReviews) {
            const mode = deliveryMode(review.threadId);
            if (mode === "queued" || mode === "retry") {
              continue;
            }
            if (mode === "accepted") {
              const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
                retriedWorkflow,
                snapshot,
                review.threadId,
                updatedAt,
              );
              if (completedWorkflow !== retriedWorkflow) {
                retriedWorkflow = completedWorkflow;
                continue;
              }
            } else {
              yield* startCodeReviewTurn({
                orchestrationEngine,
                workflow: retriedWorkflow,
                reviewerSlot: review.reviewerSlot,
                reviewThreadId: review.threadId,
                mergedPlanMarkdown: mergedPlanMarkdown!,
                reviewerLabel: review.reviewerLabel,
                createdAt: updatedAt,
              });
            }
            retriedWorkflow = setCodeReviewRunning(retriedWorkflow, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
          }
        } else {
          const implementation = retriedWorkflow.implementation;
          if (!implementation.threadId) {
            return yield* Effect.fail(new Error("Implementation thread not found for retry."));
          }
          const mode = deliveryMode(implementation.threadId);
          if (mode !== "queued" && mode !== "retry") {
            if (mode === "accepted") {
              const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
                retriedWorkflow,
                snapshot,
                implementation.threadId,
                updatedAt,
              );
              if (completedWorkflow !== retriedWorkflow) {
                retriedWorkflow = completedWorkflow;
              } else {
                const retryStatus =
                  implementation.codeReviews.length > 0 &&
                  implementation.codeReviews.every((review) => review.status === "completed")
                    ? "applying_reviews"
                    : "implementing";
                retriedWorkflow = {
                  ...retriedWorkflow,
                  implementation: {
                    ...implementation,
                    status: retryStatus,
                    error: null,
                    retryCount: 0,
                    lastRetryAt: null,
                    updatedAt,
                  },
                  updatedAt,
                };
                yield* upsertWorkflow(retriedWorkflow);
              }
            } else {
              yield* retryImplementationTurn({
                workflow: retriedWorkflow,
                thread: implementationThread!,
                createdAt: updatedAt,
              });
              const retryStatus =
                implementation.codeReviews.length > 0 &&
                implementation.codeReviews.every((review) => review.status === "completed")
                  ? "applying_reviews"
                  : "implementing";
              retriedWorkflow = {
                ...retriedWorkflow,
                implementation: {
                  ...implementation,
                  status: retryStatus,
                  error: null,
                  retryCount: 0,
                  lastRetryAt: null,
                  updatedAt,
                },
                updatedAt,
              };
              yield* upsertWorkflow(retriedWorkflow);
            }
          }
        }
      }

      const latestSnapshot = yield* orchestrationEngine.getReadModel();
      retriedWorkflow =
        latestSnapshot.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
        retriedWorkflow;
      yield* maybeContinuePlanningWorkflowLifecycle(retriedWorkflow, latestSnapshot, updatedAt);
      yield* maybeContinueImplementationLifecycle(retriedWorkflow, latestSnapshot, updatedAt);

      return { status: "started" as const };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error(error === null ? "Workflow retry failed." : String(error)),
      ),
    );

  const workflowForThread: WorkflowServiceShape["workflowForThread"] = (threadId) =>
    orchestrationEngine.getReadModel().pipe(
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
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
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
    ...workflowTurnProviderFields(branch.authorSlot),
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
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
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
    ...workflowTurnProviderFields(reviewerSlot),
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
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
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
    ...workflowTurnProviderFields(branch.authorSlot),
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
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
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
    ...workflowTurnProviderFields(reviewerSlot),
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

function readWorkflow(
  orchestrationEngine: OrchestrationEngineShape,
  workflowId: PlanningWorkflowId,
) {
  return orchestrationEngine
    .getReadModel()
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
