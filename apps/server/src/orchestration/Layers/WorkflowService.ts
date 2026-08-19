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
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Cause, Duration, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import {
  extractProposedPlanMarkdown,
  stripProposedPlanBlockTags,
  validateProposedPlanOutput,
} from "@t3tools/shared/proposedPlan";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { truncatePatchAtFileBoundary } from "../../git/patchTruncation.ts";
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
  workflowArtifactFit,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "../workflowSharedUtils.ts";
import { applyWorkflowTurnCost, workflowBudgetError } from "../workflowBudget.ts";
import {
  resolveAvailableWorkflowModelSlot,
  workflowTurnProviderFields,
  withWorkflowModelSelectionGuard,
} from "../workflowModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import {
  assertWorkflowStageProviderSupported,
  LATEST_WORKFLOW_TEMPLATE_VERSION,
  resolveWorkflowBehavior,
  type UnsupportedWorkflowProviderError,
  UnsupportedWorkflowTemplateError,
  workflowTurnBehaviorFields,
} from "../workflowBehavior.ts";
import { buildPlanningWorkflowRecord } from "../workflowRecordBuilders.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";

const WORKFLOW_PLANNING_INTERACTION_MODE: ProviderInteractionMode = "plan";
const MAX_AUTO_RETRY_ATTEMPTS = 2;
const AUTO_RETRY_BACKOFF_MS = 5_000;

function workflowPromptInvariant(input: {
  readonly workflow: PlanningWorkflow;
  readonly prompt: string;
  readonly artifacts: ReadonlyArray<string>;
  readonly targetSlot: PlanningWorkflow["branchA"]["authorSlot"];
  readonly artifactLabel: string;
  readonly thread?: Pick<
    OrchestrationReadModel["threads"][number],
    "estimatedContextTokens"
  > | null;
}): OrchestrationCommandInvariantError | null {
  if (input.prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT) {
    return new OrchestrationCommandInvariantError({
      commandType: "workflow.turn.start",
      detail: `${input.artifactLabel} rendered prompt is ${input.prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`,
    });
  }
  const behavior = resolveWorkflowBehavior({
    runKind: "planning",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
  if (!behavior.loudAuthoritativeArtifactLimit) return null;
  const fit = workflowArtifactFit({
    artifacts: input.artifacts,
    targetSlot: input.targetSlot,
    ...(input.thread ? { thread: input.thread } : {}),
  });
  return fit.fits
    ? null
    : new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail: `${input.artifactLabel} requires an estimated ${fit.estimatedTokens} tokens; only ${fit.availableTokens} authoritative-artifact tokens are available.`,
      });
}

type WorkflowTitleGenerationWorkItem = {
  readonly workflowId: PlanningWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

function isRetryableSessionError(session: {
  readonly lastError: string | null;
  readonly lastErrorRetryability?: "retryable" | "non-retryable" | null | undefined;
}): boolean {
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
  turnId: TurnId,
  assistantMessageId: string,
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
          pinnedTurnId: turnId,
          pinnedAssistantMessageId: assistantMessageId,
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
          errorStage: null,
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

function markCodeReviewsRunning(workflow: PlanningWorkflow, updatedAt: string): PlanningWorkflow {
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
          errorStage: null,
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
          errorStage: null,
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
      errorStage: "reviewer",
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

function validateCapturedPlanForTurn(input: {
  readonly workflow: PlanningWorkflow;
  readonly provider: PlanningWorkflow["branchA"]["authorSlot"]["provider"];
  readonly thread: Pick<
    OrchestrationReadModel["threads"][number],
    "latestTurn" | "messages" | "session" | "proposedPlans"
  >;
  readonly turnId: TurnId;
}): { readonly valid: true } | { readonly valid: false; readonly error: string } {
  const plan = input.thread.proposedPlans.find((candidate) => candidate.turnId === input.turnId);
  const behavior = resolveWorkflowBehavior({
    runKind: "planning",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
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
  if (capture === "exit-plan-mode") {
    return { valid: true };
  }

  const finishedTurn = getFinishedConsumableLatestTurn(input.thread);
  const assistantText = finishedTurn?.turnId === input.turnId ? finishedTurn.assistantText : null;
  const validation = validateProposedPlanOutput(assistantText);
  if (!validation.valid) {
    return validation;
  }
  return { valid: true };
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
  const checkpointDiffQuery = yield* Effect.serviceOption(CheckpointDiffQuery);

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

  const deliveryForStage = (threadId: ThreadId, intentPersistedAt: string) =>
    providerTurnDeliveryWorker._tag === "Some"
      ? providerTurnDeliveryWorker.value
          .recheck(threadId)
          .pipe(
            Effect.map((delivery) =>
              delivery && delivery.createdAt >= intentPersistedAt ? delivery : null,
            ),
          )
      : Effect.succeed(null);

  const ensureDeliveryCanResume = (
    delivery: { readonly state: string; readonly errorDetail: string | null } | null,
    stage: string,
  ) => {
    if (delivery?.state === "rejected" || delivery?.state === "ambiguous") {
      return new Error(
        `${stage} delivery is '${delivery.state}' and cannot be sent again automatically: ${delivery.errorDetail ?? "delivery outcome requires manual review"}`,
      );
    }
    return null;
  };

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
        planTurnId: branch.planTurnId,
        reviewKind: review.slot,
        reviewedBranchId: input.branchId,
        createdAt: new Date().toISOString(),
        retry: { kind: "retry", reusedThread: true, priorFailure: input.originalError },
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
    workflowId: PlanningWorkflow["id"],
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
          const reviewerLabel = `${review.slot === "cross" ? "Cross" : "Self"} review`;
          const pinnedMessageMissing =
            review.pinnedAssistantMessageId != null &&
            !thread?.messages.some((message) => message.id === review.pinnedAssistantMessageId);
          const feedback =
            thread && !pinnedMessageMissing
              ? latestAssistantFeedback(thread, review.pinnedAssistantMessageId ?? null)
              : null;
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
          return {
            reviewerLabel,
            reviewMarkdown: feedback.text,
            source: {
              workflowId,
              stage: reviewerLabel,
              ...(review.pinnedTurnId ? { turnId: review.pinnedTurnId } : {}),
              ...(review.pinnedAssistantMessageId
                ? { messageId: review.pinnedAssistantMessageId }
                : {}),
            },
          };
        }),
    ).pipe(
      Effect.map((reviews) =>
        reviews.filter((review): review is NonNullable<typeof review> => review !== null),
      ),
    );

  const maybeSynthesizeProposedPlan = (input: {
    readonly workflow: PlanningWorkflow;
    readonly provider: PlanningWorkflow["branchA"]["authorSlot"]["provider"];
    readonly thread: Pick<
      OrchestrationReadModel["threads"][number],
      | "id"
      | "projectId"
      | "worktreePath"
      | "latestTurn"
      | "messages"
      | "session"
      | "proposedPlans"
      | "activities"
    >;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: input.workflow.templateId,
        templateVersion: input.workflow.templateVersion,
      });
      const existingCapture = validateCapturedPlanForTurn({
        workflow: input.workflow,
        provider: input.provider,
        thread: input.thread,
        turnId: input.turnId,
      });
      if (existingCapture.valid) {
        return false;
      }

      const latestCompletedTurn = getFinishedConsumableLatestTurn(input.thread);
      const assistantText =
        latestCompletedTurn?.turnId === input.turnId ? latestCompletedTurn.assistantText : null;
      if (behavior.strictPlanCapture) {
        const capture = behavior.planCaptureForProvider(input.provider);
        if (capture !== "line-wrapper") {
          yield* Effect.logWarning("workflow strict proposed-plan capture was missing", {
            workflowId: input.workflow.id,
            threadId: input.thread.id,
            turnId: input.turnId,
            provider: input.provider,
            validationError: existingCapture.error,
          });
          return false;
        }
        const validation = validateProposedPlanOutput(assistantText);
        if (!validation.valid) {
          yield* Effect.logWarning("workflow proposed-plan wrapper validation failed", {
            workflowId: input.workflow.id,
            threadId: input.thread.id,
            turnId: input.turnId,
            provider: input.provider,
            validationError: validation.error,
          });
          return false;
        }
        if (hasProposedPlanForTurn(input.thread, input.turnId)) {
          return false;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.proposed-plan.upsert",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: input.thread.id,
          proposedPlan: {
            id: OrchestrationProposedPlanId.makeUnsafe(crypto.randomUUID()),
            turnId: input.turnId,
            planMarkdown: validation.markdown,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
        return true;
      }

      if (hasProposedPlanForTurn(input.thread, input.turnId)) {
        return false;
      }
      const extractedPlanMarkdown = extractProposedPlanMarkdown(assistantText);
      const strippedAssistantText = assistantText
        ? stripProposedPlanBlockTags(assistantText)
        : null;
      const markdownFilePath = latestMarkdownFileChangePath(input.thread, input.turnId);
      const filePlanMarkdown = markdownFilePath
        ? yield* Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const project = snapshot.projects.find(
              (candidate) => candidate.id === input.thread.projectId,
            );
            if (!project) {
              return null;
            }

            const unresolvedRootPath = path.resolve(
              input.thread.worktreePath ?? project.workspaceRoot,
            );
            const unresolvedCandidatePath = path.resolve(unresolvedRootPath, markdownFilePath);
            const resolvedPaths = yield* Effect.tryPromise({
              try: async () => ({
                rootPath: await realpath(unresolvedRootPath),
                candidatePath: await realpath(unresolvedCandidatePath),
              }),
              catch: () => null,
            });
            if (!resolvedPaths) return null;
            const { rootPath, candidatePath } = resolvedPaths;
            const relativePath = path.relative(rootPath, candidatePath);
            if (
              relativePath === ".." ||
              relativePath.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relativePath)
            ) {
              yield* Effect.logWarning("workflow plan file path escaped its workspace", {
                threadId: input.thread.id,
                markdownFilePath,
                rootPath,
              });
              return null;
            }

            return yield* Effect.tryPromise({
              try: () => readFile(candidatePath, "utf8"),
              catch: () => null,
            }).pipe(
              Effect.map((contents) => {
                const trimmed = contents?.trim() ?? "";
                return trimmed.length > 0 ? trimmed : null;
              }),
            );
          })
        : null;
      const planMarkdown =
        extractedPlanMarkdown ??
        (filePlanMarkdown && filePlanMarkdown.length > (assistantText?.length ?? 0)
          ? filePlanMarkdown
          : strippedAssistantText || filePlanMarkdown);
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

  const retryOrFailInvalidPlanCapture = (input: {
    readonly workflow: PlanningWorkflow;
    readonly snapshot: OrchestrationReadModel;
    readonly thread: OrchestrationReadModel["threads"][number];
    readonly turnId: TurnId;
    readonly branchId?: "a" | "b";
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: input.workflow.templateId,
        templateVersion: input.workflow.templateVersion,
      });
      if (!behavior.strictPlanCapture) return;

      const branch = input.branchId
        ? input.branchId === "a"
          ? input.workflow.branchA
          : input.workflow.branchB
        : null;
      const provider = branch?.authorSlot.provider ?? input.workflow.merge.mergeSlot.provider;
      const validation = validateCapturedPlanForTurn({
        workflow: input.workflow,
        provider,
        thread: input.thread,
        turnId: input.turnId,
      });
      if (validation.valid) return;

      const error = `Invalid proposed-plan capture: ${validation.error}`;
      if (branch && input.branchId) {
        const stage = branch.status === "revising" ? ("revision" as const) : ("authoring" as const);
        const formatRepairAttempts =
          stage === "revision"
            ? (branch.revisionFormatRepairAttempts ?? 0)
            : (branch.authorFormatRepairAttempts ?? 0);
        if (formatRepairAttempts >= 1) {
          yield* upsertWorkflow(
            markBranchError(input.workflow, input.branchId, {
              error,
              stage,
              updatedAt: input.createdAt,
            }),
          );
          return;
        }

        const repairedBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          ...(stage === "revision"
            ? { revisionFormatRepairAttempts: formatRepairAttempts + 1 }
            : { authorFormatRepairAttempts: formatRepairAttempts + 1 }),
          updatedAt: input.createdAt,
        };
        const retryWorkflow: PlanningWorkflow = {
          ...input.workflow,
          branchA: input.branchId === "a" ? repairedBranch : input.workflow.branchA,
          branchB: input.branchId === "b" ? repairedBranch : input.workflow.branchB,
          updatedAt: input.createdAt,
        };
        const retryBranch = input.branchId === "a" ? retryWorkflow.branchA : retryWorkflow.branchB;
        yield* upsertWorkflow(retryWorkflow);
        const retry: WorkflowRetryContext = {
          kind: "retry",
          reusedThread: true,
          priorFailure: error,
        };
        if (stage === "authoring") {
          yield* startAuthoringTurn({
            orchestrationEngine,
            workflow: retryWorkflow,
            branch: retryBranch,
            createdAt: input.createdAt,
            retry,
          });
          return;
        }

        const originalPlan = completedProposedPlanForTurn(
          input.snapshot,
          branch.authorThreadId,
          branch.planTurnId,
        )?.planMarkdown;
        const reviews = yield* reviewFeedbackForBranch(input.workflow.id, branch, input.snapshot);
        if (!originalPlan || reviews.length === 0) {
          yield* upsertWorkflow(
            markBranchError(retryWorkflow, input.branchId, {
              error: `${error} Revision inputs could not be reconstructed.`,
              stage,
              updatedAt: input.createdAt,
            }),
          );
          return;
        }
        yield* startRevisionTurn({
          orchestrationEngine,
          workflow: retryWorkflow,
          branch: retryBranch,
          originalPlanMarkdown: originalPlan,
          reviews,
          thread: input.thread,
          createdAt: input.createdAt,
          retry,
        });
        return;
      }

      if ((input.workflow.merge.formatRepairAttempts ?? 0) >= 1 || !input.workflow.merge.threadId) {
        yield* upsertWorkflow(markMergeError(input.workflow, error, input.createdAt));
        return;
      }
      const planA = completedProposedPlanForTurn(
        input.snapshot,
        input.workflow.branchA.authorThreadId,
        input.workflow.branchA.revisionTurnId,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        input.snapshot,
        input.workflow.branchB.authorThreadId,
        input.workflow.branchB.revisionTurnId,
      )?.planMarkdown;
      if (!planA || !planB) {
        yield* upsertWorkflow(
          markMergeError(
            input.workflow,
            `${error} Merge inputs could not be reconstructed.`,
            input.createdAt,
          ),
        );
        return;
      }
      const retryWorkflow: PlanningWorkflow = {
        ...input.workflow,
        merge: {
          ...input.workflow.merge,
          status: "in_progress",
          error: null,
          formatRepairAttempts: (input.workflow.merge.formatRepairAttempts ?? 0) + 1,
          updatedAt: input.createdAt,
        },
        updatedAt: input.createdAt,
      };
      yield* upsertWorkflow(retryWorkflow);
      yield* startMergeTurn({
        orchestrationEngine,
        workflow: retryWorkflow,
        threadId: input.workflow.merge.threadId,
        planA,
        planB,
        reviews: [
          ...(yield* reviewFeedbackForBranch(
            input.workflow.id,
            input.workflow.branchA,
            input.snapshot,
          )),
          ...(yield* reviewFeedbackForBranch(
            input.workflow.id,
            input.workflow.branchB,
            input.snapshot,
          )),
        ],
        createdAt: input.createdAt,
        retry: { kind: "retry", reusedThread: true, priorFailure: error },
      });
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
    if (!thread) {
      return null;
    }
    const plan = thread.proposedPlans.find((candidate) => candidate.turnId === expectedTurnId);
    if (!plan) return null;

    if (thread.latestTurn?.turnId === expectedTurnId) {
      if (thread.latestTurn.state !== "completed") {
        return null;
      }
      if (thread.session?.status === "running" && thread.session.activeTurnId === expectedTurnId) {
        return null;
      }
    } else if (
      (thread.session?.status === "running" && thread.session.activeTurnId !== null) ||
      (thread.latestTurn && thread.latestTurn.requestedAt > plan.updatedAt)
    ) {
      // A newer author turn can supersede the pinned record. Do not fan out
      // from the older plan while that turn is live or while its capture is
      // still waiting to be projected; the repinning path handles it first.
      return null;
    }

    return plan;
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
                planTurnId:
                  review.reviewedBranchId === "a"
                    ? workflow.branchA.planTurnId
                    : workflow.branchB.planTurnId,
                reviewKind: review.slot,
                reviewedBranchId: review.reviewedBranchId,
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
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        workflow.branchA.status !== "reviews_saved" ||
        workflow.branchB.status !== "reviews_saved"
      ) {
        return;
      }

      const branchAReviewTexts = yield* reviewFeedbackForBranch(
        workflow.id,
        workflow.branchA,
        snapshot,
      );
      const branchBReviewTexts = yield* reviewFeedbackForBranch(
        workflow.id,
        workflow.branchB,
        snapshot,
      );
      const originalPlanA = completedProposedPlanForTurn(
        snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.planTurnId,
      )?.planMarkdown;
      const originalPlanB = completedProposedPlanForTurn(
        snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.planTurnId,
      )?.planMarkdown;
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });

      if (
        branchAReviewTexts.length === 0 ||
        branchBReviewTexts.length === 0 ||
        (behavior.templateVersion === 2 && (!originalPlanA || !originalPlanB))
      ) {
        return;
      }

      const branchAAuthorThread = snapshot.threads.find(
        (entry) => entry.id === workflow.branchA.authorThreadId,
      );
      const branchBAuthorThread = snapshot.threads.find(
        (entry) => entry.id === workflow.branchB.authorThreadId,
      );

      yield* startRevisionTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchA,
        originalPlanMarkdown: originalPlanA ?? "# Original plan unavailable (legacy workflow)",
        reviews: branchAReviewTexts,
        ...(branchAAuthorThread ? { thread: branchAAuthorThread } : {}),
        createdAt: updatedAt,
      });
      yield* startRevisionTurn({
        orchestrationEngine,
        workflow,
        branch: workflow.branchB,
        originalPlanMarkdown: originalPlanB ?? "# Original plan unavailable (legacy workflow)",
        reviews: branchBReviewTexts,
        ...(branchBAuthorThread ? { thread: branchBAuthorThread } : {}),
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
    retry?: WorkflowRetryContext,
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
      const mergeReviews = [
        ...(yield* reviewFeedbackForBranch(workflow.id, workflow.branchA, snapshot)),
        ...(yield* reviewFeedbackForBranch(workflow.id, workflow.branchB, snapshot)),
      ];
      yield* startMergeTurn({
        orchestrationEngine,
        workflow,
        threadId: mergeThreadId,
        planA,
        planB,
        reviews: mergeReviews,
        createdAt: updatedAt,
        ...(retry ? { retry } : {}),
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

          if (
            !validateCapturedPlanForTurn({
              workflow,
              provider: branch.authorSlot.provider,
              thread,
              turnId,
            }).valid
          ) {
            const synthesized = yield* maybeSynthesizeProposedPlan({
              workflow,
              provider: branch.authorSlot.provider,
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
            !validateCapturedPlanForTurn({
              workflow,
              provider: branch.authorSlot.provider,
              thread,
              turnId,
            }).valid
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

        const hasPlan = validateCapturedPlanForTurn({
          workflow,
          provider: branch.authorSlot.provider,
          thread,
          turnId,
        }).valid;
        if (!hasPlan) {
          const synthesized = yield* maybeSynthesizeProposedPlan({
            workflow,
            provider: branch.authorSlot.provider,
            thread,
            turnId,
            createdAt: updatedAt,
          });
          if (!synthesized) {
            yield* retryOrFailInvalidPlanCapture({
              workflow,
              snapshot,
              thread,
              turnId,
              branchId: authorBranchId,
              createdAt: updatedAt,
            });
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
          finishedTurn.turnId,
          finishedTurn.assistantMessageId,
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

      const hasPlan = validateCapturedPlanForTurn({
        workflow,
        provider: workflow.merge.mergeSlot.provider,
        thread,
        turnId,
      }).valid;
      if (!hasPlan) {
        const synthesized = yield* maybeSynthesizeProposedPlan({
          workflow,
          provider: workflow.merge.mergeSlot.provider,
          thread,
          turnId,
          createdAt: updatedAt,
        });
        if (!synthesized) {
          yield* retryOrFailInvalidPlanCapture({
            workflow,
            snapshot,
            thread,
            turnId,
            createdAt: updatedAt,
          });
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
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        !workflow.implementation ||
        (workflow.implementation.status !== "implemented" &&
          workflow.implementation.status !== "code_reviews_requested")
      ) {
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

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      let reviewWorkflow = workflow;
      let reviewArtifact = workflow.implementation.reviewArtifact;
      if (behavior.checkpointBackedImplementationReview && !reviewArtifact) {
        const implementationThreadId = workflow.implementation.threadId;
        const implementationTurnId = workflow.implementation.implementationTurnId;
        const implementationThread = snapshot.threads.find(
          (thread) => thread.id === implementationThreadId,
        );
        const checkpoint = implementationThread?.checkpoints.find(
          (candidate) => candidate.turnId === implementationTurnId,
        );
        if (!implementationThreadId || !implementationTurnId || !implementationThread) {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              "Implementation review setup could not resolve the completed implementation turn.",
              updatedAt,
              "review-setup",
            ),
          );
          return;
        }
        // Assistant completion can arrive before checkpoint capture. The
        // thread.turn-diff-completed event re-enters this state machine. Once
        // a terminal checkpoint record exists, fail loudly instead of leaving
        // the workflow indefinitely in `implemented`.
        if (!checkpoint) {
          if (implementationThread.latestTurn?.processingQuiescedAt) {
            yield* upsertWorkflow(
              markImplementationError(
                workflow,
                "Implementation review setup reached processing quiescence without a checkpoint artifact.",
                updatedAt,
                "review-setup",
              ),
            );
          }
          return;
        }
        if (checkpoint.status !== "ready") {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              `Implementation review setup checkpoint ended with status '${checkpoint.status}'.`,
              updatedAt,
              "review-setup",
            ),
          );
          return;
        }
        if (checkpointDiffQuery._tag === "None") {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              "Implementation review setup requires the checkpoint diff service.",
              updatedAt,
              "review-setup",
            ),
          );
          return;
        }
        const diffResult = yield* checkpointDiffQuery.value
          .getFullThreadDiff({
            threadId: implementationThreadId,
            toTurnCount: checkpoint.checkpointTurnCount,
          })
          .pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
        if (!diffResult.ok) {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              `Implementation review setup failed: ${String(diffResult.error)}`,
              updatedAt,
              "review-setup",
            ),
          );
          return;
        }
        const bounded = truncatePatchAtFileBoundary(diffResult.value.diff, false);
        reviewArtifact = {
          sourceThreadId: implementationThreadId,
          sourceTurnCount: checkpoint.checkpointTurnCount,
          patchText: bounded.patch,
          fullPatchHash: createHash("sha256").update(diffResult.value.diff).digest("hex"),
          truncated: bounded.truncated,
          truncationReason: bounded.reason,
          createdAt: updatedAt,
        };
        reviewWorkflow = {
          ...workflow,
          implementation: {
            ...workflow.implementation,
            reviewArtifact,
            error: null,
            errorStage: null,
            updatedAt,
          },
          updatedAt,
        };
        yield* upsertWorkflow(reviewWorkflow);
      }

      const promptArtifact = reviewArtifact
        ? {
            patchText: reviewArtifact.patchText,
            fullPatchHash: reviewArtifact.fullPatchHash,
            truncated: reviewArtifact.truncated,
            truncationReason: reviewArtifact.truncationReason,
            source: {
              workflowId: workflow.id,
              stage: "implementation",
              ...(workflow.implementation.implementationTurnId
                ? { turnId: workflow.implementation.implementationTurnId }
                : {}),
            },
          }
        : {
            patchText:
              "The implementation delta is in the current workspace. Inspect it with read-only Git commands, including committed, staged, unstaged, and untracked changes.",
            source: { workflowId: workflow.id, stage: "implementation" },
          };

      const reviewImplementation = reviewWorkflow.implementation;
      if (!reviewImplementation) return;
      const requestedReviews =
        reviewImplementation.codeReviews.length === 0
          ? [
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
            ]
          : reviewImplementation.codeReviews.map((review) => ({
              reviewerSlot: review.reviewerSlot,
              reviewerLabel: review.reviewerLabel,
              threadId: review.threadId,
            }));

      const pendingWorkflow: PlanningWorkflow =
        reviewImplementation.codeReviews.length === 0
          ? markCodeReviewsRequested(reviewWorkflow, requestedReviews, updatedAt)
          : {
              ...reviewWorkflow,
              implementation: {
                ...reviewImplementation,
                status: "code_reviews_requested" as const,
                error: null,
                errorStage: null,
                updatedAt,
              },
              updatedAt,
            };
      yield* upsertWorkflow(pendingWorkflow);

      const setupResult = yield* Effect.forEach(
        requestedReviews,
        (review) =>
          Effect.gen(function* () {
            const reviewState = pendingWorkflow.implementation?.codeReviews.find(
              (candidate) => candidate.threadId === review.threadId,
            );
            if (reviewState?.status !== "pending") return;
            let reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
            if (!reviewThread) {
              yield* createCodeReviewThread({
                orchestrationEngine,
                workflow: pendingWorkflow,
                reviewerSlot: review.reviewerSlot,
                threadId: review.threadId,
                reviewerLabel: review.reviewerLabel,
                createdAt: updatedAt,
              });
              const refreshed = yield* orchestrationEngine.getReadModel();
              reviewThread = refreshed.threads.find((thread) => thread.id === review.threadId);
            }
            const existingDelivery = behavior.idempotentStageSetup
              ? yield* deliveryForStage(
                  review.threadId,
                  reviewState?.updatedAt ?? pendingWorkflow.updatedAt,
                )
              : null;
            const deliveryError = ensureDeliveryCanResume(
              existingDelivery,
              `${review.reviewerLabel} implementation review`,
            );
            if (deliveryError) return yield* Effect.fail(deliveryError);
            if (!reviewThread?.latestTurn && !existingDelivery) {
              yield* startCodeReviewTurn({
                orchestrationEngine,
                workflow: pendingWorkflow,
                reviewerSlot: review.reviewerSlot,
                reviewThreadId: review.threadId,
                mergedPlanMarkdown: mergedPlan.planMarkdown,
                reviewerLabel: review.reviewerLabel,
                lensBranch:
                  pendingWorkflow.implementation?.codeReviews.at(0)?.threadId === review.threadId
                    ? "a"
                    : "b",
                reviewArtifact: promptArtifact,
                createdAt: updatedAt,
              });
            }
          }),
        { discard: true },
      ).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!setupResult.ok) {
        yield* upsertWorkflow(
          markImplementationError(
            pendingWorkflow,
            `Implementation review setup failed: ${String(setupResult.error)}`,
            updatedAt,
            "review-setup",
          ),
        );
        return;
      }

      yield* upsertWorkflow(markCodeReviewsRunning(pendingWorkflow, updatedAt));
    });

  const maybeStartImplementationRevision = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
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
          return {
            reviewerLabel: review.reviewerLabel,
            reviewMarkdown: feedback.text,
            source: {
              workflowId: workflow.id,
              stage: review.reviewerLabel,
              ...(thread?.latestTurn?.turnId ? { turnId: thread.latestTurn.turnId } : {}),
              ...(thread?.latestTurn?.assistantMessageId
                ? { messageId: thread.latestTurn.assistantMessageId }
                : {}),
            },
          };
        }),
      )).filter((review): review is NonNullable<typeof review> => review !== null);

      if (reviewTexts.length === 0) {
        return;
      }

      const budgetError = workflowBudgetError(workflow);
      if (budgetError) {
        yield* upsertWorkflow(markImplementationError(workflow, budgetError.message, updatedAt));
        return;
      }

      const prompt = buildImplementationRevisionPrompt({
        requirementPrompt: workflow.requirementPrompt,
        reviews: reviewTexts,
        targetSlot: workflow.implementation.implementationSlot,
      });
      const implementationThread = snapshot.threads.find(
        (entry) => entry.id === workflow.implementation?.threadId,
      );
      const promptError = workflowPromptInvariant({
        workflow,
        prompt,
        artifacts: reviewTexts.map((review) => review.reviewMarkdown),
        targetSlot: workflow.implementation.implementationSlot,
        artifactLabel: "Implementation review feedback",
        ...(implementationThread ? { thread: implementationThread } : {}),
      });
      if (promptError) {
        yield* upsertWorkflow(
          markImplementationError(workflow, promptError.message, updatedAt, "apply-feedback"),
        );
        return;
      }

      const applyingWorkflow = markImplementationApplyingReviews(workflow, updatedAt);
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const existingDelivery = behavior.idempotentStageSetup
        ? yield* deliveryForStage(
            workflow.implementation.threadId,
            workflow.implementation.updatedAt,
          )
        : null;
      const deliveryError = ensureDeliveryCanResume(existingDelivery, "Apply-feedback");
      if (deliveryError) {
        yield* upsertWorkflow(
          markImplementationError(workflow, deliveryError.message, updatedAt, "apply-feedback"),
        );
        return;
      }
      if (!existingDelivery) {
        const dispatchResult = yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            threadId: workflow.implementation.threadId,
            message: {
              messageId: MessageId.makeUnsafe(crypto.randomUUID()),
              role: "user",
              text: prompt,
              attachments: [],
            },
            ...workflowTurnProviderFields(workflow.implementation.implementationSlot),
            titleSourceText: workflow.title,
            runtimeMode: workflow.implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            ...workflowTurnBehaviorFields({
              runKind: "planning",
              templateId: workflow.templateId,
              templateVersion: workflow.templateVersion,
              stage: "apply-feedback",
            }),
            createdAt: updatedAt,
          })
          .pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
        if (!dispatchResult.ok) {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              `Apply-feedback setup failed: ${String(dispatchResult.error)}`,
              updatedAt,
              "apply-feedback",
            ),
          );
          return;
        }
      }

      yield* upsertWorkflow(applyingWorkflow);
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

      if (
        workflow.implementation.status === "not_started" ||
        (workflow.implementation.status === "error" &&
          workflow.implementation.errorStage === "implementation-start")
      ) {
        yield* resumeImplementationStart(workflow, snapshot, updatedAt);
        return;
      }

      if (
        workflow.implementation.status === "code_reviews_requested" ||
        (workflow.implementation.status === "error" &&
          workflow.implementation.errorStage === "review-setup")
      ) {
        const resumableWorkflow: PlanningWorkflow =
          workflow.implementation.status === "error"
            ? {
                ...workflow,
                implementation: {
                  ...workflow.implementation,
                  status: "implemented",
                  error: null,
                  errorStage: null,
                  updatedAt,
                },
                updatedAt,
              }
            : workflow;
        yield* maybeStartCodeReviews(resumableWorkflow, snapshot, updatedAt);
        return;
      }

      if (
        workflow.implementation.status === "error" &&
        workflow.implementation.errorStage === "apply-feedback"
      ) {
        const resumableWorkflow: PlanningWorkflow = {
          ...workflow,
          implementation: {
            ...workflow.implementation,
            status: "code_reviews_saved",
            error: null,
            errorStage: null,
            updatedAt,
          },
          updatedAt,
        };
        yield* maybeStartImplementationRevision(resumableWorkflow, snapshot, updatedAt);
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

  function resumeImplementationStart(
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) {
    return Effect.gen(function* () {
      const implementation = workflow.implementation;
      if (
        !implementation ||
        (implementation.status !== "not_started" &&
          !(
            implementation.status === "error" &&
            implementation.errorStage === "implementation-start"
          ))
      ) {
        return workflow;
      }
      if (!implementation.threadId) {
        return yield* Effect.fail(
          new Error("Implementation thread intent is missing its thread ID."),
        );
      }
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* budgetError;

      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      const mergedPlan = mergeThread ? resolveApprovedMergedPlan(workflow, mergeThread) : null;
      if (!mergeThread || !mergedPlan?.planMarkdown) {
        return yield* Effect.fail(
          new Error("Approved merged plan is unavailable for implementation."),
        );
      }

      const prompt = buildImplementationPrompt({
        workflow,
        mergedPlanMarkdown: mergedPlan.planMarkdown,
        implementationSlot: implementation.implementationSlot,
      });
      const promptError = workflowPromptInvariant({
        workflow,
        prompt,
        artifacts: [mergedPlan.planMarkdown],
        targetSlot: implementation.implementationSlot,
        artifactLabel: "Approved implementation plan",
      });
      if (promptError) return yield* promptError;

      let implementationThread = snapshot.threads.find(
        (thread) => thread.id === implementation.threadId,
      );
      if (!implementationThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: implementation.threadId,
          projectId: workflow.projectId,
          title: "Implementation",
          model: implementation.implementationSlot.model,
          runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: implementation.branch ?? null,
          worktreePath: implementation.worktreePath ?? null,
          threadReferences: [
            {
              relation: "source",
              threadId: mergeThread.id,
              createdAt: updatedAt,
            },
          ],
          createdAt: updatedAt,
        });
        const refreshed = yield* orchestrationEngine.getReadModel();
        implementationThread = refreshed.threads.find(
          (thread) => thread.id === implementation.threadId,
        );
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const existingDelivery = behavior.idempotentStageSetup
        ? yield* deliveryForStage(implementation.threadId, implementation.updatedAt)
        : null;
      const deliveryError = ensureDeliveryCanResume(existingDelivery, "Implementation");
      if (deliveryError) return yield* Effect.fail(deliveryError);

      if (!implementationThread?.latestTurn && !existingDelivery) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: implementation.threadId,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: prompt,
            attachments: [],
          },
          ...workflowTurnProviderFields(implementation.implementationSlot),
          titleSourceText: workflow.title,
          runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          sourceProposedPlan: {
            threadId: mergeThread.id,
            planId: mergedPlan.id,
          },
          createdAt: updatedAt,
        });
      }

      const startedWorkflow: PlanningWorkflow = {
        ...workflow,
        implementation: {
          ...implementation,
          status: "implementing",
          error: null,
          errorStage: null,
          updatedAt,
        },
        updatedAt,
      };
      yield* upsertWorkflow(startedWorkflow);
      return startedWorkflow;
    }).pipe(
      Effect.catchCause((cause) =>
        upsertWorkflow(
          markImplementationError(
            workflow,
            `Implementation setup failed: ${String(cause)}`,
            updatedAt,
            "implementation-start",
          ),
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
  }

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
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (
            implementationMatch?.workflow.implementation?.status === "implemented" &&
            implementationMatch.workflow.implementation.implementationTurnId ===
              event.payload.turnId
          ) {
            yield* maybeContinueImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.occurredAt,
            );
            return;
          }
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
                workflow: authorMatch.workflow,
                provider: branch.authorSlot.provider,
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
            workflow: mergeWorkflow,
            provider: mergeWorkflow.merge.mergeSlot.provider,
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
              isRetryableSessionError(event.payload.session) &&
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
              isRetryableSessionError(event.payload.session) &&
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
                    retry: {
                      kind: "retry",
                      reusedThread: true,
                      priorFailure: event.payload.session.lastError ?? undefined,
                    },
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
              isRetryableSessionError(event.payload.session) &&
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
              isRetryableSessionError(event.payload.session) &&
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
                      lensBranch:
                        workflow.implementation?.codeReviews.at(0)?.threadId ===
                        retryReview.threadId
                          ? "a"
                          : "b",
                      reviewArtifact: implementationReviewPromptArtifact(workflow),
                      createdAt: new Date().toISOString(),
                      retry: {
                        kind: "retry",
                        reusedThread: true,
                        priorFailure: event.payload.session.lastError ?? undefined,
                      },
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
      const behavior = yield* Effect.try({
        try: () =>
          resolveWorkflowBehavior({
            runKind: "planning",
            templateId: input.templateId,
            templateVersion: input.templateVersion ?? LATEST_WORKFLOW_TEMPLATE_VERSION,
          }),
        catch: () =>
          new UnsupportedWorkflowTemplateError(
            "planning",
            input.templateId ?? "builtin.planning.dual",
            input.templateVersion ?? 2,
          ),
      });
      yield* Effect.try({
        try: () => {
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "author",
            provider: input.branchA.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "author",
            provider: input.branchB.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "merge",
            provider: input.merge.provider,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
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
      const workflow = buildPlanningWorkflowRecord({
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
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
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
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

      const implementationPrompt = buildImplementationPrompt({
        workflow: implementationWorkflow,
        mergedPlanMarkdown: mergedPlan.planMarkdown,
        implementationSlot,
      });
      const implementationPromptError = workflowPromptInvariant({
        workflow: implementationWorkflow,
        prompt: implementationPrompt,
        artifacts: [mergedPlan.planMarkdown],
        targetSlot: implementationSlot,
        artifactLabel: "Approved implementation plan",
      });
      if (implementationPromptError) return yield* implementationPromptError;

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

      const pendingImplementationWorkflow: PlanningWorkflow = {
        ...implementationWorkflow,
        implementation: {
          implementationSlot: {
            provider: input.provider,
            model: input.model,
            ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          },
          threadId: implementationThreadId,
          branch,
          worktreePath,
          runtimeMode,
          implementationTurnId: null,
          revisionTurnId: null,
          codeReviewEnabled,
          codeReviews: [],
          status: "not_started",
          error: null,
          errorStage: null,
          reviewArtifact: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        },
        updatedAt: now,
      };
      yield* upsertWorkflow(pendingImplementationWorkflow);
      const latestSnapshot = yield* orchestrationEngine.getReadModel();
      yield* resumeImplementationStart(pendingImplementationWorkflow, latestSnapshot, now);
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
        } else if (
          workflow.implementation.errorStage !== "implementation-start" &&
          workflow.implementation.errorStage !== "apply-feedback" &&
          workflow.implementation.threadId
        ) {
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
          readonly source: Parameters<typeof buildRevisionPrompt>[0]["reviews"][number]["source"];
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
          const feedback = yield* reviewFeedbackForBranch(workflow.id, branch, snapshot);
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
      if (
        workflow.implementation?.status === "error" &&
        workflow.implementation.errorStage !== "implementation-start" &&
        workflow.implementation.errorStage !== "apply-feedback" &&
        failedCodeReviews.length === 0
      ) {
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
            planTurnId: originalBranch.planTurnId,
            reviewKind: review.slot,
            reviewedBranchId: branchId,
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              priorFailure: review.error ?? undefined,
            },
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
            retry: {
              kind: "retry",
              reusedThread: true,
              priorFailure: originalBranch.error ?? undefined,
            },
          });
        } else {
          const authorThread = snapshot.threads.find(
            (entry) => entry.id === originalBranch.authorThreadId,
          );
          yield* startRevisionTurn({
            orchestrationEngine,
            workflow: retriedWorkflow,
            branch: originalBranch,
            originalPlanMarkdown:
              completedProposedPlanForTurn(
                snapshot,
                originalBranch.authorThreadId,
                originalBranch.planTurnId,
              )?.planMarkdown ?? "# Original plan unavailable",
            reviews: revisionFeedback.get(branchId)!,
            ...(authorThread ? { thread: authorThread } : {}),
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              priorFailure: originalBranch.error ?? undefined,
            },
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
          yield* maybeStartMerge(mergeRetryWorkflow, snapshot, updatedAt, {
            kind: "retry",
            reusedThread: false,
            priorFailure: retriedWorkflow.merge.error ?? undefined,
          });
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
            retriedWorkflow;
        }
      }

      if (retriedWorkflow.implementation?.status === "error") {
        if (retriedWorkflow.implementation.errorStage === "implementation-start") {
          retriedWorkflow = yield* resumeImplementationStart(retriedWorkflow, snapshot, updatedAt);
        } else if (retriedWorkflow.implementation.errorStage === "review-setup") {
          const resumedWorkflow: PlanningWorkflow = {
            ...retriedWorkflow,
            implementation: {
              ...retriedWorkflow.implementation,
              status: "implemented",
              error: null,
              errorStage: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(resumedWorkflow);
          yield* maybeStartCodeReviews(resumedWorkflow, snapshot, updatedAt);
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === resumedWorkflow.id) ??
            resumedWorkflow;
        } else if (retriedWorkflow.implementation.errorStage === "apply-feedback") {
          const resumedWorkflow: PlanningWorkflow = {
            ...retriedWorkflow,
            implementation: {
              ...retriedWorkflow.implementation,
              status: "code_reviews_saved",
              error: null,
              errorStage: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(resumedWorkflow);
          yield* maybeStartImplementationRevision(resumedWorkflow, snapshot, updatedAt);
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === resumedWorkflow.id) ??
            resumedWorkflow;
        } else {
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
                  lensBranch:
                    retriedWorkflow.implementation?.codeReviews.at(0)?.threadId === review.threadId
                      ? "a"
                      : "b",
                  reviewArtifact: implementationReviewPromptArtifact(retriedWorkflow),
                  createdAt: updatedAt,
                  retry: {
                    kind: "retry",
                    reusedThread: true,
                    priorFailure: review.error ?? undefined,
                  },
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
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  branch: PlanningWorkflow["branchA"];
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildAuthorPrompt({
    workflow,
    branch,
    authorSlot: branch.authorSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [workflow.requirementPrompt],
    targetSlot: branch.authorSlot,
    artifactLabel: "Author requirement",
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(branch.authorSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "author",
    }),
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
  planTurnId,
  reviewKind,
  reviewedBranchId,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  reviewThreadId: ThreadId;
  planMarkdown: string;
  planTurnId: string | null;
  reviewKind: WorkflowReviewSlot;
  reviewedBranchId: "a" | "b";
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildReviewPrompt({
    requirementPrompt: workflow.requirementPrompt,
    planMarkdown,
    planSource: {
      workflowId: workflow.id,
      stage: "author",
      ...(planTurnId ? { turnId: planTurnId } : {}),
    },
    reviewKind,
    lensBranch: reviewedBranchId,
    reviewerSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [planMarkdown],
    targetSlot: reviewerSlot,
    artifactLabel: "Plan under review",
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(reviewerSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "plan-review",
    }),
    createdAt,
  });
}

function startRevisionTurn({
  orchestrationEngine,
  workflow,
  branch,
  originalPlanMarkdown,
  reviews,
  thread,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  branch: PlanningWorkflow["branchA"];
  originalPlanMarkdown: string;
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
    readonly source: Parameters<typeof buildRevisionPrompt>[0]["reviews"][number]["source"];
  }>;
  thread?: Pick<OrchestrationReadModel["threads"][number], "estimatedContextTokens">;
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildRevisionPrompt({
    requirementPrompt: workflow.requirementPrompt,
    originalPlan: {
      markdown: originalPlanMarkdown,
      source: {
        workflowId: workflow.id,
        stage: `author-${branch.branchId}`,
        ...(branch.planTurnId ? { turnId: branch.planTurnId } : {}),
      },
    },
    reviews: reviews ?? [],
    targetSlot: branch.authorSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [originalPlanMarkdown, ...reviews.map((review) => review.reviewMarkdown)],
    targetSlot: branch.authorSlot,
    artifactLabel: "Revision inputs",
    ...(thread ? { thread } : {}),
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(branch.authorSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "revision",
    }),
    createdAt,
  });
}

function startMergeTurn({
  orchestrationEngine,
  workflow,
  threadId,
  planA,
  planB,
  reviews,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  threadId: ThreadId;
  planA: string;
  planB: string;
  reviews: Parameters<typeof buildMergePrompt>[0]["reviews"];
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildMergePrompt({
    workflow,
    planA: {
      markdown: planA,
      source: {
        workflowId: workflow.id,
        stage: "revision-a",
        ...(workflow.branchA.revisionTurnId ? { turnId: workflow.branchA.revisionTurnId } : {}),
      },
    },
    planB: {
      markdown: planB,
      source: {
        workflowId: workflow.id,
        stage: "revision-b",
        ...(workflow.branchB.revisionTurnId ? { turnId: workflow.branchB.revisionTurnId } : {}),
      },
    },
    modelA: workflow.branchA.authorSlot,
    modelB: workflow.branchB.authorSlot,
    reviews,
    mergeSlot: workflow.merge.mergeSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [planA, planB, ...(reviews ?? []).map((review) => review.reviewMarkdown)],
    targetSlot: workflow.merge.mergeSlot,
    artifactLabel: "Merge inputs",
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(workflow.merge.mergeSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "merge",
    }),
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

function implementationReviewPromptArtifact(
  workflow: PlanningWorkflow,
): Parameters<typeof buildCodeReviewPrompt>[0]["reviewArtifact"] {
  const artifact = workflow.implementation?.reviewArtifact;
  return artifact
    ? {
        patchText: artifact.patchText,
        fullPatchHash: artifact.fullPatchHash,
        truncated: artifact.truncated,
        truncationReason: artifact.truncationReason,
        source: {
          workflowId: workflow.id,
          stage: "implementation",
          ...(workflow.implementation?.implementationTurnId
            ? { turnId: workflow.implementation.implementationTurnId }
            : {}),
        },
      }
    : {
        patchText:
          "The implementation delta is in the current workspace. Inspect it with read-only Git commands, including committed, staged, unstaged, and untracked changes.",
        source: { workflowId: workflow.id, stage: "implementation" },
      };
}

function startCodeReviewTurn({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewThreadId,
  mergedPlanMarkdown,
  reviewerLabel,
  lensBranch,
  reviewArtifact,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: PlanningWorkflow["branchA"]["authorSlot"];
  reviewThreadId: ThreadId;
  mergedPlanMarkdown: string;
  reviewerLabel: string;
  lensBranch: "a" | "b";
  reviewArtifact: Parameters<typeof buildCodeReviewPrompt>[0]["reviewArtifact"];
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildCodeReviewPrompt({
    mergedPlanMarkdown,
    requirementPrompt: workflow.requirementPrompt,
    reviewArtifact,
    reviewerLabel,
    lensBranch,
    reviewerSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [mergedPlanMarkdown, reviewArtifact.patchText],
    targetSlot: reviewerSlot,
    artifactLabel: "Implementation review inputs",
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(reviewerSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "implementation-review",
    }),
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
