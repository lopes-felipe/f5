import { timeOrderedUuid } from "@t3tools/shared/ids";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import {
  makeWorkflowStageDispatchResolver,
  makeWorkflowStageThreadResolver,
  makeWorkflowPromptReader,
  makeWorkflowPinnedOutputHydrator,
  makeWorkflowDeliveryOriginResolver,
} from "../workflowStageDispatch.ts";
import { dispatchWorkflowTurn, structuredReviewPrompt } from "../workflowBenchmarkDispatch.ts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { makeWorkflowArchiveLifecycle } from "../workflowArchiveLifecycle.ts";
import {
  CommandId,
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationRetryWorkflowResult,
  type OrchestrationThread,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  type PlanningWorkflow,
  type ProviderInteractionMode,
  ThreadId,
  type ThreadTurnStartCommand,
  TurnId,
  type WorkflowReviewSlot,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import { Cause, Clock, Duration, Effect, Layer, Option, Scope, Stream } from "effect";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";
import {
  defaultDocumentReaderSlot,
  documentWorkflowForThread,
  isDocumentWorkflow,
  planningWorkflowDocumentType,
  validateDocumentArtifact,
  type DocumentValidationResult,
} from "@t3tools/shared/documentWorkflow";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { readToolActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import {
  extractProposedPlanMarkdown,
  stripProposedPlanBlockTags,
  validateProposedPlanOutput,
} from "@t3tools/shared/proposedPlan";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import {
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
} from "@t3tools/shared/worktree";

import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { truncatePatchAtFileBoundary } from "../../git/patchTruncation.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
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
  buildDocumentAuthorPrompt,
  buildDocumentReviewPrompt,
  buildDocumentRevisionPrompt,
  buildDocumentMergePrompt,
  buildDocumentReaderReviewPrompt,
  buildDocumentPolishPrompt,
} from "../documentWorkflowPrompts.ts";
import {
  markDocumentMergeDrafted,
  markReaderRunning,
  markReaderSaved,
  markPolishRequested,
  markPolishCompleted,
  markReaderPassError,
  markReaderPassSkipped,
} from "../documentReaderPass.ts";
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
  getFinishedConsumableTurn,
  formatAssistantFeedback,
  getFinishedWorkflowReport,
  nextWorkflowSlug,
  reviewFeedbackForPinnedTurn,
  slotLabel,
  type WorkflowFitThread,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
  workflowContextTarget,
  workflowPromptFitError,
  workflowPromptFit,
} from "../workflowSharedUtils.ts";
import {
  applyWorkflowTurnCost,
  workflowBudgetError,
  workflowSessionTurnCost,
} from "../workflowBudget.ts";
import {
  resolveAvailableWorkflowModelSlot,
  workflowTurnProviderFields,
  withWorkflowModelSelectionGuard,
} from "../workflowModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import {
  CompactionService,
  type WorkflowCompactionOutcome,
} from "../Services/CompactionService.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { makeOperationGate } from "../../provider/operationGate.ts";
import { STARTUP_DISPATCH_RECHECK_TIMEOUT } from "../workflowStageDispatch.ts";
import { isProviderResumeFailureText } from "../../provider/resumeFailure.ts";
import {
  assertWorkflowStageProviderSupported,
  latestWorkflowTemplateVersion,
  documentWorkflowCreateInvariant,
  resolveWorkflowBehavior,
  type UnsupportedWorkflowProviderError,
  UnsupportedWorkflowTemplateError,
  workflowTurnBehaviorFields,
} from "../workflowBehavior.ts";
import { buildPlanningWorkflowRecord } from "../workflowRecordBuilders.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";
import {
  prepareCodeReviewPrompt,
  type PreparedImplementationReviewPrompt,
} from "../workflowReviewPrompt.ts";

const WORKFLOW_PLANNING_INTERACTION_MODE: ProviderInteractionMode = "plan";
const MAX_AUTO_RETRY_ATTEMPTS = 2;
const AUTO_RETRY_BACKOFF_MS = 5_000;
// An automatic retry dispatches only after the thread's session looks settled
// on two observations this far apart, the last one at the end of the backoff.
// A session that is still restarting after the failure would otherwise turn
// the retry into an ambiguous delivery.
const AUTO_RETRY_SETTLE_INTERVAL_MS = 1_000;
const AUTO_RETRY_SETTLE_TIMEOUT_MS = 120_000;

function stableWorkflowUuid(namespace: string, ...parts: ReadonlyArray<string | number | null>) {
  const digest = createHash("sha256")
    .update([namespace, ...parts.map(String)].join("\0"))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function stableWorkflowCommandId(
  namespace: string,
  ...parts: ReadonlyArray<string | number | null>
): CommandId {
  return CommandId.makeUnsafe(`workflow:${namespace}:${stableWorkflowUuid(namespace, ...parts)}`);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function workflowPromptInvariant(input: {
  readonly workflow: PlanningWorkflow;
  readonly prompt: string;
  readonly artifacts: ReadonlyArray<string>;
  readonly targetSlot: PlanningWorkflow["branchA"]["authorSlot"];
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

function isSessionSettledForAutoRetry(
  thread: Pick<OrchestrationReadModel["threads"][number], "session"> | null | undefined,
): boolean {
  if (!thread) return false;
  const status = thread.session?.status ?? null;
  return status !== "starting" && !hasActiveRunningTurn(thread);
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
  if (
    workflow.readerPass?.readerThreadId === threadId ||
    workflow.readerPass?.previousReaderThreadIds?.includes(threadId)
  )
    return { workflow, label: "Reader review" };
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
  assistantMessageId: string | null,
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
  turn: NonNullable<ReturnType<typeof getFinishedWorkflowReport>>,
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
          pinnedTurnId: turn.turnId,
          pinnedAssistantMessageId: turn.assistantMessageId,
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

function hasMisattributedRevision(workflow: PlanningWorkflow): boolean {
  const implementation = workflow.implementation;
  return (
    implementation?.status === "completed" &&
    implementation.revisionTurnId !== null &&
    implementation.revisionTurnId === implementation.implementationTurnId
  );
}

function isApplyReviewsLifecycle(workflow: PlanningWorkflow): boolean {
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

// Review thread ids are derived from the draft turn they reviewed, so the
// reviewed draft stays recoverable even if `planTurnId` was later overwritten.
function reviewedPlanTurnIdForBranch(
  workflow: PlanningWorkflow,
  branchId: "a" | "b",
  branch: PlanningWorkflow["branchA"],
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
        (review) =>
          review.threadId ===
          stableWorkflowUuid("plan-review-thread", workflow.id, branchId, review.slot, turnId),
      )
    )
      return turnId;
  }
  return null;
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
  const sources = yield* makeShutdownSourceScope("planning-workflows-sources");
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const gitCore = yield* GitCore;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);
  const providerTurnDeliveryRepository = yield* Effect.serviceOption(
    ProviderTurnDeliveryRepository,
  );
  const checkpointDiffQuery = yield* Effect.serviceOption(CheckpointDiffQuery);
  const commandReceipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository);
  const turnRepository = yield* Effect.serviceOption(ProjectionTurnRepository);
  const resolveStageDispatch = yield* makeWorkflowStageDispatchResolver;
  const withWorkflowGate = makeOperationGate<PlanningWorkflowId>();
  const withWorkflowRetryGate = makeOperationGate<PlanningWorkflowId>();
  const compactionService = yield* Effect.serviceOption(CompactionService);
  const activeRevisionCompactions = new Set<CommandId>();
  const resolveStageThread = yield* makeWorkflowStageThreadResolver;
  const hydratePinnedOutputs = yield* makeWorkflowPinnedOutputHydrator;
  const resolveDeliveryOrigin = yield* makeWorkflowDeliveryOriginResolver;
  const readWorkflowPrompt = yield* makeWorkflowPromptReader;
  const stageThread = (
    workflow: PlanningWorkflow,
    taskId: string,
    thread: OrchestrationReadModel["threads"][number] | undefined,
  ) =>
    !thread
      ? Effect.succeed(undefined)
      : resolveStageDispatch(null, thread.id, {
          runKind: "planning",
          workflowId: workflow.id,
          taskId,
        }).pipe(Effect.flatMap((dispatch) => resolveStageThread(thread, dispatch)));

  const getWorkflowProviders =
    providerRegistry._tag === "Some" ? providerRegistry.value.getProviders : Effect.succeed([]);
  const orchestrationEngine = withWorkflowModelSelectionGuard(
    baseOrchestrationEngine,
    getWorkflowProviders,
  );

  const writeWorkflow = (workflow: PlanningWorkflow) =>
    orchestrationEngine.dispatch({
      type: "project.workflow.upsert",
      commandId: CommandId.makeUnsafe(timeOrderedUuid()),
      projectId: workflow.projectId,
      workflow,
      createdAt: workflow.updatedAt,
    });

  const upsertWorkflow = (workflow: PlanningWorkflow) =>
    withWorkflowGate(
      workflow.id,
      Effect.gen(function* () {
        const current = yield* readWorkflow(orchestrationEngine, workflow.id);
        if (!current) return yield* writeWorkflow(workflow);
        const applying = current.implementation && isApplyReviewsLifecycle(current);
        // Stale writers must not reopen a finished revision or replace its pin.
        // A writer that has observed the finished revision may update it.
        const preserveImplementation =
          applying &&
          (current.implementation?.status !== "completed" ||
            workflow.implementation?.status !== "completed" ||
            workflow.implementation.revisionTurnId !== current.implementation.revisionTurnId);
        return yield* writeWorkflow({
          ...workflow,
          ...(preserveImplementation ? { implementation: current.implementation } : {}),
          ...(applying
            ? { archivedAt: current.archivedAt, archiveRestorations: current.archiveRestorations }
            : {}),
          totalCostUsd: Math.max(workflow.totalCostUsd, current.totalCostUsd),
          updatedAt:
            current.updatedAt > workflow.updatedAt ? current.updatedAt : workflow.updatedAt,
        });
      }),
    );

  /**
   * Fail one branch's revision visibly (error with Retry), unless the branch moved
   * on since `input.workflow` was read. The sibling branch is left alone.
   */
  const rejectRevision = (
    input: Pick<Parameters<typeof prepareRevisionTurn>[0], "workflow" | "branch" | "createdAt">,
    error: string,
  ) => {
    const branchKey = input.branch.branchId === "a" ? "branchA" : "branchB";
    const expected = input.workflow[branchKey];
    return withWorkflowGate(
      input.workflow.id,
      Effect.gen(function* () {
        const current = yield* readWorkflow(orchestrationEngine, input.workflow.id);
        if (!current) return input.workflow;
        const branch = current[branchKey];
        if (
          isArchivedWorkflow(current) ||
          branch.status !== expected.status ||
          branch.updatedAt !== expected.updatedAt ||
          branch.planTurnId !== expected.planTurnId
        ) {
          return current;
        }
        const failed = markBranchError(current, input.branch.branchId, {
          error,
          stage: "revision",
          updatedAt: input.createdAt,
        });
        const next = {
          ...failed,
          updatedAt: current.updatedAt > failed.updatedAt ? current.updatedAt : failed.updatedAt,
        };
        yield* writeWorkflow(next);
        return next;
      }),
    );
  };

  const dispatchRevisionTurn = (
    input: Parameters<typeof prepareRevisionTurn>[0],
    priorFailure?: string,
  ) =>
    Effect.gen(function* () {
      // Size and send the prompt for the model dispatch will actually use: the
      // model-selection guard swaps an unavailable saved model at dispatch.
      const authorSlot = resolveAvailableWorkflowModelSlot(
        input.branch.authorSlot,
        yield* getWorkflowProviders,
      );
      const prepared = prepareRevisionTurn({ ...input, branch: { ...input.branch, authorSlot } });
      if ("rejection" in prepared) {
        const workflow = yield* rejectRevision(
          input,
          priorFailure ? `${priorFailure} ${prepared.rejection}` : prepared.rejection,
        );
        return { workflow, started: false };
      }
      // The slot was resolved against this catalog read and the prompt sized for it.
      // Dispatching through the guard would read the catalog again and could swap in
      // a smaller model than the one that passed the fit check.
      yield* dispatchWorkflowTurn(
        baseOrchestrationEngine,
        "planning",
        input.workflow.id,
        `revision-${input.branch.branchId}`,
        prepared.command,
      );
      return { workflow: input.workflow, started: true };
    });

  const recordWorkflowTurnCost = (
    workflow: PlanningWorkflow,
    turnCostUsd: number | undefined,
    occurredAt: string,
  ) =>
    turnCostUsd === undefined || !Number.isFinite(turnCostUsd) || turnCostUsd <= 0
      ? Effect.succeed(workflow)
      : withWorkflowGate(
          workflow.id,
          Effect.gen(function* () {
            const current = yield* readWorkflow(orchestrationEngine, workflow.id);
            if (!current || isDeletedWorkflow(current)) return workflow;
            const costed = applyWorkflowTurnCost(
              current,
              turnCostUsd,
              current.updatedAt > occurredAt ? current.updatedAt : occurredAt,
            );
            yield* writeWorkflow(costed);
            return costed;
          }),
        );

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

  const hasDeliveryInFlight = (threadId: ThreadId) =>
    providerTurnDeliveryRepository._tag === "Some"
      ? providerTurnDeliveryRepository.value.getLatestByThread(threadId).pipe(
          Effect.map((delivery) => delivery?.state === "pending" || delivery?.state === "sending"),
          // An unreadable delivery state is not proof that nothing is in
          // flight. Keep waiting; the settle timeout bounds a lasting failure.
          Effect.catchCause((cause) =>
            Effect.logWarning("auto-retry could not read the thread's delivery state", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(true)),
          ),
        )
      : Effect.succeed(false);

  const isThreadSettledForAutoRetry = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      return isSessionSettledForAutoRetry(thread) && !(yield* hasDeliveryInFlight(threadId));
    });

  /**
   * Sleeps for the retry backoff, then keeps waiting until the thread's session
   * has looked settled on two consecutive observations. Fails when the session
   * never settles, so the caller records an error instead of a blind send.
   */
  const awaitAutoRetrySettled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(AUTO_RETRY_BACKOFF_MS - AUTO_RETRY_SETTLE_INTERVAL_MS));
      // Wall-clock deadline, so slow state reads cannot stretch the bound.
      const deadline = (yield* Clock.currentTimeMillis) + AUTO_RETRY_SETTLE_TIMEOUT_MS;
      let previousSettled = yield* isThreadSettledForAutoRetry(threadId);
      while (true) {
        yield* Effect.sleep(Duration.millis(AUTO_RETRY_SETTLE_INTERVAL_MS));
        const settled = yield* isThreadSettledForAutoRetry(threadId);
        if (settled && previousSettled) return;
        previousSettled = settled;
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.fail(
            new Error("The provider session did not become ready for an automatic retry."),
          );
        }
      }
    });

  const forkAutoRetry = (input: {
    readonly kind: "authoring" | "implementation" | "code_review" | "document_reader";
    readonly workflowId: PlanningWorkflowId;
    readonly threadId: ThreadId;
    readonly buildDispatch: (input: {
      readonly workflow: PlanningWorkflow;
      readonly snapshot: OrchestrationReadModel;
    }) => Effect.Effect<unknown, OrchestrationDispatchError | Error> | null;
    /** Records a visible error when the retry cannot be dispatched. */
    readonly markFailed?: (input: {
      readonly workflow: PlanningWorkflow;
      readonly detail: string;
      readonly failedAt: string;
    }) => PlanningWorkflow | null;
  }) =>
    Effect.gen(function* () {
      yield* awaitAutoRetrySettled(input.threadId);
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
        Effect.gen(function* () {
          yield* Effect.logError("WorkflowService.autoRetryDispatch failed", {
            kind: input.kind,
            workflowId: input.workflowId,
            threadId: input.threadId,
            cause,
          });
          if (!input.markFailed || Cause.hasInterruptsOnly(cause)) return;
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow =
            snapshot.planningWorkflows.find(
              (entry) =>
                entry.id === input.workflowId &&
                !isDeletedWorkflow(entry) &&
                !isArchivedWorkflow(entry),
            ) ?? null;
          if (!workflow) return;
          const squashed = Cause.squash(cause);
          const failed = input.markFailed({
            workflow,
            detail: squashed instanceof Error ? squashed.message : Cause.pretty(cause),
            failedAt: new Date().toISOString(),
          });
          if (failed) yield* upsertWorkflow(failed);
        }).pipe(
          Effect.catchCause((markCause) =>
            Effect.logError("WorkflowService.autoRetryDispatch failure could not be recorded", {
              kind: input.kind,
              workflowId: input.workflowId,
              threadId: input.threadId,
              cause: markCause,
            }),
          ),
        ),
      ),
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope),
    );

  const forkPlanningReviewAutoRetry = (input: {
    readonly workflowId: PlanningWorkflowId;
    readonly branchId: "a" | "b";
    readonly threadId: ThreadId;
    readonly expectedRetryCount: number;
    readonly originalError: string;
  }) =>
    Effect.gen(function* () {
      yield* awaitAutoRetrySettled(input.threadId);
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
        branch.updatedAt,
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
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope),
    );

  const titleGenerationWorker = yield* makeBackgroundWorker(
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
    { name: "WorkflowService", key: (item) => String(item.workflowId) },
  );

  const reviewFeedbackForBranch = (
    workflowId: PlanningWorkflow["id"],
    branch: PlanningWorkflow["branchA"],
    snapshot: OrchestrationReadModel,
  ) =>
    Effect.gen(function* () {
      const workflow = snapshot.planningWorkflows.find((entry) => entry.id === workflowId);
      const hydrated = workflow ? yield* hydratePinnedOutputs(workflow, snapshot) : snapshot;
      return yield* Effect.forEach(
        branch.reviews.toSorted((left, right) => compareWorkflowReviewSlots(left.slot, right.slot)),
        (review) =>
          Effect.gen(function* () {
            const thread = hydrated.threads.find((entry) => entry.id === review.threadId);
            const reviewerLabel = `${review.slot === "cross" ? "Cross" : "Self"} review`;
            const pinnedMessageMissing =
              review.pinnedAssistantMessageId != null &&
              !thread?.messages.some((message) => message.id === review.pinnedAssistantMessageId);
            const feedback =
              thread &&
              (!pinnedMessageMissing ||
                thread.proposedPlans?.some((plan) => plan.turnId === review.pinnedTurnId))
                ? reviewFeedbackForPinnedTurn(
                    thread,
                    review.pinnedTurnId ?? null,
                    review.pinnedAssistantMessageId ?? null,
                  )
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
    });

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
    readonly validate?: (markdown: string) => DocumentValidationResult;
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
      const finalMessage = input.thread.messages.find(
        (message) =>
          message.id === latestCompletedTurn?.assistantMessageId &&
          message.turnId === input.turnId &&
          message.role === "assistant" &&
          !message.streaming,
      );
      const assistantText = finalMessage?.text || null;
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
        // Reasoning is useful review feedback, but it is not a submitted plan.
        const validation = validateProposedPlanOutput(finalMessage?.text);
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
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
      let planMarkdown = extractedPlanMarkdown ?? strippedAssistantText;
      if (!planMarkdown) return false;
      const documentType = planningWorkflowDocumentType(input.workflow);
      if (documentType) {
        const validation =
          input.validate?.(planMarkdown) ??
          validateDocumentArtifact(planMarkdown, documentType, "capture");
        if (!validation.valid) return false;
        planMarkdown = validation.markdown;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
      let workflow = input.workflow;
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      if (!behavior.strictPlanCapture && !isDocumentWorkflow(workflow)) return;

      let branch = input.branchId
        ? input.branchId === "a"
          ? workflow.branchA
          : workflow.branchB
        : null;
      // Format repair may create a new turn only for a currently running stage.
      if (
        branch
          ? branch.status !== "authoring" && branch.status !== "revising"
          : workflow.merge.status !== "in_progress"
      )
        return;
      // A turn this stage already rejected has its repair outstanding. A later
      // evaluation of it (a session update while the repair turn starts, with
      // the same logical timestamp) must neither repair nor fail it again.
      if (
        input.turnId ===
        (branch ? branch.rejectedDocumentTurnId : workflow.merge.rejectedDocumentTurnId)
      )
        return;
      const provider = branch?.authorSlot.provider ?? workflow.merge.mergeSlot.provider;
      const validation = validateCapturedPlanForTurn({
        workflow: workflow,
        provider,
        thread: input.thread,
        turnId: input.turnId,
      });
      if (validation.valid) return;
      // Every workflow kind records the rejected turn, so the stage evaluates it once. Planning
      // workflows record it only once the repair turn was dispatched: until then a repeated
      // evaluation must still be able to fail the stage visibly (dispatch failure, restart),
      // instead of skipping the turn with no repair running. Events are handled one at a
      // time, so the record lands before any event the dispatch itself causes.
      const deferRejection = !isDocumentWorkflow(workflow);
      const beforeRejection = { workflow, branch };
      // A repair turn that cannot be dispatched fails its stage visibly (with Retry) instead
      // of leaving it running with no turn. Returns whether the turn was dispatched.
      const dispatchRepair = <A, E, R>(
        start: Effect.Effect<A, E, R>,
        failed: (message: string) => PlanningWorkflow,
      ) =>
        start.pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("workflow format repair turn could not be dispatched", {
                  workflowId: workflow.id,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    upsertWorkflow(failed("The format repair turn could not be started.")),
                  ),
                  Effect.as(Option.none()),
                ),
          ),
        );
      if (branch && input.branchId) {
        branch = { ...branch, rejectedDocumentTurnId: input.turnId };
        workflow = { ...workflow, [input.branchId === "a" ? "branchA" : "branchB"]: branch };
      } else {
        workflow = {
          ...workflow,
          merge: { ...workflow.merge, rejectedDocumentTurnId: input.turnId },
        };
      }

      const error = `${isDocumentWorkflow(workflow) ? "Invalid document" : "Invalid proposed-plan capture"}: ${validation.error}`;
      const branchStage = branch?.status === "revising" ? "revision" : "authoring";
      const budgetError = workflowBudgetError(workflow);
      if (
        budgetError &&
        (branch
          ? branchStage === "revision"
            ? (branch.revisionFormatRepairAttempts ?? 0)
            : (branch.authorFormatRepairAttempts ?? 0)
          : (workflow.merge.formatRepairAttempts ?? 0)) < 1
      ) {
        yield* upsertWorkflow(
          branch && input.branchId
            ? markBranchError(workflow, input.branchId, {
                error: budgetError.message,
                stage: branchStage,
                updatedAt: input.createdAt,
              })
            : markMergeError(workflow, budgetError.message, input.createdAt),
        );
        return;
      }
      if (branch && input.branchId) {
        const stage = branchStage;
        const formatRepairAttempts =
          stage === "revision"
            ? (branch.revisionFormatRepairAttempts ?? 0)
            : (branch.authorFormatRepairAttempts ?? 0);
        if (formatRepairAttempts >= 1) {
          yield* upsertWorkflow(
            markBranchError(workflow, input.branchId, {
              error,
              stage,
              updatedAt: input.createdAt,
            }),
          );
          return;
        }

        const retryBase = deferRejection ? beforeRejection : { workflow, branch };
        const repairedBranch: PlanningWorkflow["branchA"] = {
          ...retryBase.branch!,
          ...(stage === "revision"
            ? { revisionFormatRepairAttempts: formatRepairAttempts + 1 }
            : { authorFormatRepairAttempts: formatRepairAttempts + 1 }),
          updatedAt: input.createdAt,
        };
        const retryWorkflow: PlanningWorkflow = {
          ...retryBase.workflow,
          branchA: input.branchId === "a" ? repairedBranch : retryBase.workflow.branchA,
          branchB: input.branchId === "b" ? repairedBranch : retryBase.workflow.branchB,
          updatedAt: input.createdAt,
        };
        const retryBranch = input.branchId === "a" ? retryWorkflow.branchA : retryWorkflow.branchB;
        yield* upsertWorkflow(retryWorkflow);
        const retry: WorkflowRetryContext = {
          kind: "retry",
          formatRepair: true,
          reusedThread: true,
          priorFailure: error,
        };
        const branchId = input.branchId;
        const failBranch = (message: string) =>
          markBranchError(retryWorkflow, branchId, {
            error: `${error} ${message}`,
            stage,
            updatedAt: input.createdAt,
          });
        if (stage === "authoring") {
          const started = yield* dispatchRepair(
            startAuthoringTurn({
              orchestrationEngine,
              workflow: retryWorkflow,
              branch: retryBranch,
              createdAt: input.createdAt,
              retry,
            }),
            failBranch,
          );
          if (Option.isSome(started) && deferRejection)
            yield* recordRejectedPlanTurn(workflow.id, branchId, input.turnId);
          return;
        }

        const originalPlan = completedProposedPlanForTurn(
          input.snapshot,
          branch.authorThreadId,
          branch.planTurnId,
          branch.updatedAt,
        )?.planMarkdown;
        const reviews = yield* reviewFeedbackForBranch(workflow.id, branch, input.snapshot);
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
        const started = yield* dispatchRepair(
          dispatchRevisionTurn(
            {
              workflow: retryWorkflow,
              branch: retryBranch,
              originalPlanMarkdown: originalPlan,
              reviews,
              thread: input.thread,
              createdAt: input.createdAt,
              retry,
            },
            error,
          ),
          failBranch,
        );
        if (Option.isSome(started) && started.value.started && deferRejection)
          yield* recordRejectedPlanTurn(workflow.id, branchId, input.turnId);
        return;
      }

      if ((workflow.merge.formatRepairAttempts ?? 0) >= 1 || !workflow.merge.threadId) {
        yield* upsertWorkflow(markMergeError(workflow, error, input.createdAt));
        return;
      }
      const planA = completedProposedPlanForTurn(
        input.snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.revisionTurnId,
        workflow.branchA.updatedAt,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        input.snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.revisionTurnId,
        workflow.branchB.updatedAt,
      )?.planMarkdown;
      if (!planA || !planB) {
        yield* upsertWorkflow(
          markMergeError(
            workflow,
            `${error} Merge inputs could not be reconstructed.`,
            input.createdAt,
          ),
        );
        return;
      }
      const mergeBase = deferRejection ? beforeRejection.workflow : workflow;
      const retryWorkflow: PlanningWorkflow = {
        ...mergeBase,
        merge: {
          ...mergeBase.merge,
          status: "in_progress",
          error: null,
          formatRepairAttempts: (mergeBase.merge.formatRepairAttempts ?? 0) + 1,
          updatedAt: input.createdAt,
        },
        updatedAt: input.createdAt,
      };
      yield* upsertWorkflow(retryWorkflow);
      const reviews = [
        ...(yield* reviewFeedbackForBranch(workflow.id, workflow.branchA, input.snapshot)),
        ...(yield* reviewFeedbackForBranch(workflow.id, workflow.branchB, input.snapshot)),
      ];
      const started = yield* dispatchRepair(
        startMergeTurn({
          orchestrationEngine,
          workflow: retryWorkflow,
          threadId: workflow.merge.threadId,
          planA,
          planB,
          reviews,
          createdAt: input.createdAt,
          retry: { kind: "retry", formatRepair: true, reusedThread: true, priorFailure: error },
        }),
        (message) => markMergeError(retryWorkflow, `${error} ${message}`, input.createdAt),
      );
      if (Option.isSome(started) && deferRejection)
        yield* recordRejectedPlanTurn(workflow.id, undefined, input.turnId);
    });

  /**
   * Records a planning stage's rejected turn once its repair turn was dispatched, on the
   * workflow as it is now: dispatching may itself have updated it.
   */
  const recordRejectedPlanTurn = (
    workflowId: PlanningWorkflow["id"],
    branchId: "a" | "b" | undefined,
    turnId: TurnId,
  ) =>
    Effect.gen(function* () {
      const current = (yield* orchestrationEngine.getReadModel()).planningWorkflows.find(
        (entry) => entry.id === workflowId,
      );
      if (!current) return;
      if (branchId) {
        const key = branchId === "a" ? "branchA" : "branchB";
        const branch = current[key];
        if (
          (branch.status !== "authoring" && branch.status !== "revising") ||
          branch.rejectedDocumentTurnId === turnId
        )
          return;
        yield* upsertWorkflow({ ...current, [key]: { ...branch, rejectedDocumentTurnId: turnId } });
        return;
      }
      if (current.merge.status !== "in_progress" || current.merge.rejectedDocumentTurnId === turnId)
        return;
      yield* upsertWorkflow({
        ...current,
        merge: { ...current.merge, rejectedDocumentTurnId: turnId },
      });
    });

  const resolvePinnedAuthorPlan = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    pinnedTurnId: string | null,
    replacementNotBefore?: string,
  ):
    | { readonly status: "missing" | "waiting" }
    | {
        readonly status: "ready";
        readonly plan: OrchestrationReadModel["threads"][number]["proposedPlans"][number];
      } => {
    if (!pinnedTurnId) {
      return { status: "missing" };
    }

    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return { status: "missing" };
    }
    const latestTurn = thread.latestTurn;
    const pinnedPlan = thread.proposedPlans.find((candidate) => candidate.turnId === pinnedTurnId);
    if (!pinnedPlan) {
      if (!latestTurn) {
        return { status: "missing" };
      }
      const latestTurnStillSettling =
        (thread.session?.status === "running" && thread.session.activeTurnId !== null) ||
        latestTurn.state === "running" ||
        latestTurn.completedAt === null ||
        latestTurn.processingQuiescedAt === null;
      if (latestTurnStillSettling) {
        return { status: "waiting" };
      }
      const replacementPlan = thread.proposedPlans.find(
        (candidate) => candidate.turnId === latestTurn.turnId,
      );
      if (
        latestTurn.state === "completed" &&
        replacementPlan &&
        (replacementNotBefore === undefined || latestTurn.requestedAt > replacementNotBefore)
      ) {
        return { status: "ready", plan: replacementPlan };
      }
      return { status: "missing" };
    }

    if (thread.latestTurn?.turnId === pinnedTurnId) {
      if (thread.latestTurn.state !== "completed") {
        return { status: "waiting" };
      }
      if (thread.session?.status === "running" && thread.session.activeTurnId === pinnedTurnId) {
        return { status: "waiting" };
      }
      return { status: "ready", plan: pinnedPlan };
    }

    if (
      !latestTurn ||
      latestTurn.requestedAt <= pinnedPlan.updatedAt ||
      (replacementNotBefore !== undefined && latestTurn.requestedAt < replacementNotBefore)
    ) {
      return { status: "ready", plan: pinnedPlan };
    }

    const newerTurnStillSettling =
      (thread.session?.status === "running" && thread.session.activeTurnId !== null) ||
      latestTurn.state === "running" ||
      latestTurn.completedAt === null ||
      latestTurn.processingQuiescedAt === null;
    if (newerTurnStillSettling) {
      return { status: "waiting" };
    }

    const replacementPlan = thread.proposedPlans.find(
      (candidate) => candidate.turnId === latestTurn.turnId,
    );
    if (latestTurn.state === "completed" && replacementPlan) {
      return { status: "ready", plan: replacementPlan };
    }

    return { status: "ready", plan: pinnedPlan };
  };

  const completedProposedPlanForTurn = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    expectedTurnId: string | null,
    replacementNotBefore?: string,
  ): { readonly planMarkdown: string } | null => {
    const resolution = resolvePinnedAuthorPlan(
      snapshot,
      threadId,
      expectedTurnId,
      replacementNotBefore,
    );
    return resolution.status === "ready" && resolution.plan.turnId === expectedTurnId
      ? resolution.plan
      : null;
  };

  const maybeStartReviews = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      const startsFresh =
        workflow.branchA.status === "plan_saved" &&
        workflow.branchB.status === "plan_saved" &&
        workflow.branchA.reviews.length === 0 &&
        workflow.branchB.reviews.length === 0;
      const resumesPersistedIntent =
        workflow.branchA.status === "reviews_requested" &&
        workflow.branchB.status === "reviews_requested" &&
        workflow.branchA.reviews.length > 0 &&
        workflow.branchB.reviews.length > 0;
      if (!startsFresh && !resumesPersistedIntent) {
        return;
      }

      const planA = completedProposedPlanForTurn(
        snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.planTurnId,
        workflow.branchA.updatedAt,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.planTurnId,
        workflow.branchB.updatedAt,
      )?.planMarkdown;
      if (!planA || !planB) {
        return;
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      let intentWorkflow = workflow;
      if (startsFresh) {
        const budgetError = workflowBudgetError(workflow);
        if (budgetError) {
          yield* upsertWorkflow(markMergeError(workflow, budgetError.message, updatedAt));
          return;
        }
        const branchAReviews = [
          {
            slot: "cross" as const,
            threadId: ThreadId.makeUnsafe(
              stableWorkflowUuid(
                "plan-review-thread",
                workflow.id,
                "a",
                "cross",
                workflow.branchA.planTurnId,
              ),
            ),
          },
          ...(workflow.selfReviewEnabled
            ? [
                {
                  slot: "self" as const,
                  threadId: ThreadId.makeUnsafe(
                    stableWorkflowUuid(
                      "plan-review-thread",
                      workflow.id,
                      "a",
                      "self",
                      workflow.branchA.planTurnId,
                    ),
                  ),
                },
              ]
            : []),
        ];
        const branchBReviews = [
          {
            slot: "cross" as const,
            threadId: ThreadId.makeUnsafe(
              stableWorkflowUuid(
                "plan-review-thread",
                workflow.id,
                "b",
                "cross",
                workflow.branchB.planTurnId,
              ),
            ),
          },
          ...(workflow.selfReviewEnabled
            ? [
                {
                  slot: "self" as const,
                  threadId: ThreadId.makeUnsafe(
                    stableWorkflowUuid(
                      "plan-review-thread",
                      workflow.id,
                      "b",
                      "self",
                      workflow.branchB.planTurnId,
                    ),
                  ),
                },
              ]
            : []),
        ];
        intentWorkflow = markReviewsRequested(workflow, {
          branchAReviews,
          branchBReviews,
          updatedAt,
        });
        yield* upsertWorkflow(intentWorkflow);
      }

      const reviews = [
        ...intentWorkflow.branchA.reviews.map((review) => ({
          review,
          reviewedBranchId: "a" as const,
          reviewerSlot:
            review.slot === "cross"
              ? intentWorkflow.branchB.authorSlot
              : intentWorkflow.branchA.authorSlot,
          planMarkdown: planA,
          planTurnId: intentWorkflow.branchA.planTurnId,
        })),
        ...intentWorkflow.branchB.reviews.map((review) => ({
          review,
          reviewedBranchId: "b" as const,
          reviewerSlot:
            review.slot === "cross"
              ? intentWorkflow.branchA.authorSlot
              : intentWorkflow.branchB.authorSlot,
          planMarkdown: planB,
          planTurnId: intentWorkflow.branchB.planTurnId,
        })),
      ];

      yield* Effect.forEach(
        reviews,
        ({ review, reviewedBranchId, reviewerSlot, planMarkdown, planTurnId }) =>
          Effect.gen(function* () {
            const reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
            if (!reviewThread) {
              yield* createReviewThread({
                orchestrationEngine,
                workflow: intentWorkflow,
                reviewerSlot,
                reviewedBranchId,
                reviewSlot: review.slot,
                threadId: review.threadId,
                createdAt: updatedAt,
              });
            }
            const existingDelivery = behavior.idempotentStageSetup
              ? yield* deliveryForStage(review.threadId, review.updatedAt)
              : null;
            const deliveryError = ensureDeliveryCanResume(
              existingDelivery,
              `${review.slot} plan review`,
            );
            if (deliveryError) return yield* Effect.fail(deliveryError);
            const alreadyStarted =
              reviewThread?.latestTurn !== null && reviewThread?.latestTurn !== undefined;
            if (!existingDelivery && !alreadyStarted) {
              yield* startReviewTurn({
                orchestrationEngine,
                workflow: intentWorkflow,
                reviewerSlot,
                reviewThreadId: review.threadId,
                planMarkdown,
                planTurnId,
                reviewKind: review.slot,
                reviewedBranchId,
                createdAt: updatedAt,
                attempt: review.retryCount,
              });
            }
          }),
        { discard: true },
      );
    });

  const maybeStartRevisions = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    handledThreads?: ReadonlySet<ThreadId>,
  ) =>
    Effect.gen(function* () {
      const startsFresh =
        workflow.branchA.status === "reviews_saved" && workflow.branchB.status === "reviews_saved";
      const branches = [workflow.branchA, workflow.branchB];
      const candidates = startsFresh
        ? branches
        : branches.filter(
            (branch) => branch.status === "revising" && !handledThreads?.has(branch.authorThreadId),
          );
      if (candidates.length === 0) return;

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });

      // Every candidate is judged against this captured record: a sibling's rejection
      // rereads and rewrites the workflow, and must not become the baseline another
      // branch's stale failure is compared with.
      const current = startsFresh
        ? markBranchRevising(markBranchRevising(workflow, "a", updatedAt), "b", updatedAt)
        : workflow;

      const inputs = yield* Effect.forEach(candidates, (candidate) =>
        Effect.gen(function* () {
          const branch = candidate.branchId === "a" ? current.branchA : current.branchB;
          const thread = snapshot.threads.find((entry) => entry.id === branch.authorThreadId);
          const originalPlanMarkdown = thread?.proposedPlans.find(
            (plan) => plan.turnId === branch.planTurnId,
          )?.planMarkdown;
          const reviews = yield* reviewFeedbackForBranch(workflow.id, branch, snapshot);
          if (!reviews.length || (behavior.templateVersion === 2 && !originalPlanMarkdown)) {
            return null;
          }
          return {
            branch,
            thread,
            originalPlanMarkdown:
              originalPlanMarkdown ?? "# Original plan unavailable (legacy workflow)",
            reviews,
          };
        }),
      );
      if (startsFresh) {
        if (inputs.some((input) => input === null)) return;
        yield* upsertWorkflow(current);
      }

      // Each branch settles on its own: a delivery that can't resume, or a start that
      // fails, marks only that branch failed (with Retry), and the caller always learns
      // which branches did start so the startup audit leaves them alone.
      const dispatched = new Set<ThreadId>();
      yield* Effect.forEach(
        inputs,
        (input) =>
          Effect.gen(function* () {
            if (!input) return;
            const { branch, thread } = input;
            const existingDelivery = behavior.idempotentStageSetup
              ? yield* deliveryForStage(branch.authorThreadId, branch.updatedAt)
              : null;
            const deliveryError = ensureDeliveryCanResume(existingDelivery, "Plan revision");
            if (deliveryError) {
              yield* rejectRevision(
                { workflow: current, branch, createdAt: updatedAt },
                deliveryError.message,
              );
              return;
            }
            if (
              existingDelivery ||
              (thread?.latestTurn &&
                thread.latestTurn.turnId !== branch.planTurnId &&
                thread.latestTurn.requestedAt >= branch.updatedAt)
            ) {
              return;
            }
            const outcome = yield* dispatchRevisionTurn({
              ...input,
              workflow: current,
              createdAt: updatedAt,
            });
            if (outcome.started) dispatched.add(branch.authorThreadId);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("workflow revision start failed", {
                    workflowId: workflow.id,
                    branchId: input?.branch.branchId,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.andThen(
                      input
                        ? rejectRevision(
                            { workflow: current, branch: input.branch, createdAt: updatedAt },
                            `Plan revision could not be started: ${errorMessage(Cause.squash(cause))}`,
                          ).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            ),
          ),
        { discard: true },
      );
      return dispatched;
    });

  const maybeStartMerge = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    retry?: WorkflowRetryContext,
  ) =>
    Effect.gen(function* () {
      const startsFresh =
        workflow.branchA.status === "revised" &&
        workflow.branchB.status === "revised" &&
        workflow.merge.status === "not_started";
      const resumesPersistedIntent =
        workflow.branchA.status === "revised" &&
        workflow.branchB.status === "revised" &&
        workflow.merge.status === "in_progress" &&
        workflow.merge.threadId !== null;
      if (!startsFresh && !resumesPersistedIntent) {
        return;
      }

      const planA = completedProposedPlanForTurn(
        snapshot,
        workflow.branchA.authorThreadId,
        workflow.branchA.revisionTurnId,
        workflow.branchA.updatedAt,
      )?.planMarkdown;
      const planB = completedProposedPlanForTurn(
        snapshot,
        workflow.branchB.authorThreadId,
        workflow.branchB.revisionTurnId,
        workflow.branchB.updatedAt,
      )?.planMarkdown;
      if (!planA || !planB) {
        return;
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const mergeThreadId =
        workflow.merge.threadId ??
        ThreadId.makeUnsafe(
          stableWorkflowUuid(
            "plan-merge-thread",
            workflow.id,
            workflow.branchA.revisionTurnId,
            workflow.branchB.revisionTurnId,
            workflow.merge.updatedAt,
          ),
        );
      const intentWorkflow = startsFresh
        ? markMergeStarted(workflow, mergeThreadId, updatedAt)
        : workflow;
      if (startsFresh) {
        yield* upsertWorkflow(intentWorkflow);
      }

      const mergeThread = snapshot.threads.find((thread) => thread.id === mergeThreadId);
      if (!mergeThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: stableWorkflowCommandId("create-plan-merge-thread", mergeThreadId),
          threadId: mergeThreadId,
          projectId: intentWorkflow.projectId,
          title: "Merge",
          model: intentWorkflow.merge.mergeSlot.model,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: updatedAt,
        });
      }
      const existingDelivery = behavior.idempotentStageSetup
        ? yield* deliveryForStage(mergeThreadId, intentWorkflow.merge.updatedAt)
        : null;
      const deliveryError = ensureDeliveryCanResume(existingDelivery, "Plan merge");
      if (deliveryError) return yield* Effect.fail(deliveryError);
      const alreadyStarted =
        mergeThread?.latestTurn !== null &&
        mergeThread?.latestTurn !== undefined &&
        mergeThread.latestTurn.requestedAt >= intentWorkflow.merge.updatedAt;
      if (existingDelivery || alreadyStarted) {
        return;
      }
      const mergeReviews = [
        ...(yield* reviewFeedbackForBranch(intentWorkflow.id, intentWorkflow.branchA, snapshot)),
        ...(yield* reviewFeedbackForBranch(intentWorkflow.id, intentWorkflow.branchB, snapshot)),
      ];
      yield* startMergeTurn({
        orchestrationEngine,
        workflow: intentWorkflow,
        threadId: mergeThreadId,
        planA,
        planB,
        reviews: mergeReviews,
        createdAt: updatedAt,
        ...(retry ? { retry } : {}),
      });
    });

  const dispatchDocumentReaderStage = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    stage: "reader" | "polish",
    createdAt: string,
    retry?: WorkflowRetryContext,
  ) =>
    Effect.gen(function* () {
      const pass = workflow.readerPass!;
      const slot = stage === "reader" ? workflow.readerSlot! : workflow.merge.mergeSlot;
      const threadId = stage === "reader" ? pass.readerThreadId : workflow.merge.threadId!;
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const draft = snapshot.threads
        .find((entry) => entry.id === workflow.merge.threadId)
        ?.proposedPlans.find((plan) => plan.id === pass.draftPlanId);
      if (!draft) return yield* Effect.fail(new Error("Merged document not found."));
      const readerSnapshot =
        stage === "polish" ? yield* hydratePinnedOutputs(workflow, snapshot) : snapshot;
      const reportThread = readerSnapshot.threads.find((entry) => entry.id === pass.readerThreadId);
      const report = reportThread
        ? reviewFeedbackForPinnedTurn(
            reportThread,
            pass.pinnedTurnId,
            pass.pinnedAssistantMessageId,
          )?.text
        : null;
      if (stage === "polish" && !report?.trim())
        return yield* Effect.fail(new Error("Reader review produced no report."));
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* Effect.fail(budgetError);
      const source = {
        workflowId: workflow.id,
        stage: stage === "reader" ? "merge" : "reader-review",
        turnId: stage === "reader" ? pass.draftTurnId : (pass.pinnedTurnId ?? undefined),
      };
      const prompt =
        stage === "reader"
          ? structuredReviewPrompt(
              buildDocumentReaderReviewPrompt({ workflow, markdown: draft.planMarkdown, source }),
              true,
            )
          : buildDocumentPolishPrompt({
              workflow,
              report: report!,
              source,
              ...(retry ? { retry } : {}),
            });
      const promptError = workflowPromptInvariant({
        workflow,
        prompt,
        artifacts: [stage === "reader" ? draft.planMarkdown : report!],
        targetSlot: slot,
        artifactLabel: stage === "reader" ? "Merged document" : "Reader report",
        ...(thread ? { thread } : {}),
      });
      if (promptError) return yield* Effect.fail(promptError);
      yield* dispatchWorkflowTurn(
        orchestrationEngine,
        "planning",
        workflow.id,
        stage === "reader" ? "reader-review" : "polish",
        {
          type: "thread.turn.start",
          commandId: stableWorkflowCommandId(`document-${stage}`, workflow.id, threadId, createdAt),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(
              stableWorkflowUuid(`document-${stage}-message`, workflow.id, threadId, createdAt),
            ),
            role: "user",
            text: prompt,
            attachments: [],
          },
          ...workflowTurnProviderFields(slot),
          titleSourceText: workflow.title,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          ...workflowTurnBehaviorFields({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
            stage: stage === "reader" ? "plan-review" : "merge",
          }),
          createdAt,
        },
        stage === "reader"
          ? {
              label: "Merged draft",
              ...(workflow.merge.threadId ? { threadId: workflow.merge.threadId } : {}),
              turnId: pass.draftTurnId,
              planId: pass.draftPlanId,
            }
          : undefined,
      );
    });

  const maybeContinueDocumentReaderPass = (
    workflow: PlanningWorkflow,
  ): Effect.Effect<void, OrchestrationDispatchError | Error> =>
    Effect.gen(function* () {
      if (
        !isDocumentWorkflow(workflow) ||
        workflow.merge.status !== "merged" ||
        !workflow.readerPass
      )
        return;
      let current = workflow;
      const snapshot = yield* orchestrationEngine.getReadModel();
      const persisted = snapshot.planningWorkflows.find((entry) => entry.id === workflow.id);
      if (persisted) current = persisted;
      if (isArchivedWorkflow(current)) return;
      const pass = current.readerPass;
      if (!pass || current.merge.status !== "merged") return;
      const stage =
        pass.status === "reader_requested"
          ? "reader"
          : pass.status === "reader_saved" || pass.status === "polishing"
            ? "polish"
            : null;
      if (!stage) return;
      yield* Effect.gen(function* () {
        const budgetError = pass.status === "polishing" ? null : workflowBudgetError(current);
        if (budgetError) return yield* Effect.fail(budgetError);
        if (
          stage === "reader" &&
          !snapshot.threads.some((thread) => thread.id === pass.readerThreadId)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: stableWorkflowCommandId(
              "create-document-reader",
              current.id,
              pass.readerThreadId,
            ),
            threadId: pass.readerThreadId,
            projectId: current.projectId,
            title: "Reader review",
            model: current.readerSlot!.model,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt: pass.updatedAt,
          });
        }
        if (pass.status === "reader_saved") {
          current = markPolishRequested(current, new Date().toISOString());
          yield* upsertWorkflow(current);
        }
        const intentAt =
          stage === "reader" ? pass.updatedAt : current.readerPass!.polishRequestedAt!;
        const threadId = stage === "reader" ? pass.readerThreadId : current.merge.threadId!;
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        const alreadyStarted = !!thread?.latestTurn && thread.latestTurn.requestedAt >= intentAt;
        if (
          alreadyStarted &&
          (hasActiveRunningTurn(thread) || thread?.latestTurn?.state === "running")
        ) {
          if (stage === "reader") yield* upsertWorkflow(markReaderRunning(current, intentAt));
          return;
        }
        const delivery = yield* deliveryForStage(threadId, intentAt);
        const deliveryError = ensureDeliveryCanResume(
          delivery,
          stage === "reader" ? "Reader review" : "Polish",
        );
        if (deliveryError) return yield* Effect.fail(deliveryError);
        if (!delivery && !alreadyStarted)
          yield* dispatchDocumentReaderStage(current, snapshot, stage, intentAt);
        if (stage === "reader") {
          current = markReaderRunning(current, intentAt);
          yield* upsertWorkflow(current);
          // Dispatch may have completed before the running state was persisted (including
          // across a restart). Consume that completion without sending another turn.
          const latest = yield* orchestrationEngine.getReadModel();
          const advanced = yield* maybeAdvanceDocumentReaderPass(
            current,
            latest,
            threadId,
            new Date().toISOString(),
          );
          if (advanced !== current) yield* maybeContinueDocumentReaderPass(advanced);
        }
      }).pipe(
        Effect.catch((error) =>
          upsertWorkflow(
            markReaderPassError(current, stage, String(error), new Date().toISOString()),
          ).pipe(Effect.asVoid),
        ),
      );
    });

  const maybeAdvanceDocumentReaderPass = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
    expectedTurnId?: TurnId | null,
  ): Effect.Effect<PlanningWorkflow, OrchestrationDispatchError | Error | null> =>
    Effect.gen(function* () {
      const pass = workflow.readerPass;
      const rawThread = snapshot.threads.find((entry) => entry.id === threadId);
      const thread = pass
        ? yield* stageThread(
            workflow,
            threadId === pass.readerThreadId ? "reader-review" : "polish",
            rawThread,
          )
        : rawThread;
      if (!thread) return workflow;
      if (!pass) {
        const plan = thread.proposedPlans.find((entry) => entry.turnId === workflow.merge.turnId);
        if (threadId !== workflow.merge.threadId || !plan) return workflow;
        const healed = markMergeReadyForManualReview(
          { ...workflow, merge: { ...workflow.merge, approvedPlanId: null } },
          {
            turnId: plan.turnId!,
            approvedPlanId: plan.id,
            updatedAt,
          },
        );
        yield* upsertWorkflow(healed);
        return healed;
      }
      const completedTurnId = getFinishedLatestTurnId(thread);
      const finished =
        (threadId === pass.readerThreadId
          ? getFinishedWorkflowReport(thread)
          : getFinishedConsumableLatestTurn(thread)) ??
        (completedTurnId
          ? {
              turnId: completedTurnId,
              assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
              assistantText: "",
            }
          : null);
      if (!finished || (expectedTurnId && finished.turnId !== expectedTurnId)) return workflow;
      if (pass.status === "error" && (thread.latestTurn?.completedAt ?? "") < pass.updatedAt)
        return workflow;
      let next = workflow;
      if (
        threadId === pass.readerThreadId &&
        (pass.status === "reader_running" ||
          (pass.status === "error" && pass.errorStage === "reader")) &&
        pass.readerStartedAt &&
        thread.latestTurn!.requestedAt >= pass.readerStartedAt
      ) {
        next = markReaderSaved(workflow, {
          turnId: finished.turnId,
          messageId: finished.assistantMessageId,
          updatedAt,
        });
        if (
          !reviewFeedbackForPinnedTurn(
            thread,
            finished.turnId,
            finished.assistantMessageId,
          )?.text.trim()
        )
          next = markReaderPassError(
            next,
            "reader",
            "Reader review produced no report.",
            updatedAt,
          );
      } else if (
        threadId === workflow.merge.threadId &&
        (pass.status === "polishing" ||
          (pass.status === "error" && pass.errorStage === "polish")) &&
        finished.turnId !== pass.draftTurnId &&
        pass.polishRequestedAt &&
        thread.latestTurn!.requestedAt >= pass.polishRequestedAt
      ) {
        const validate = (markdown: string) =>
          validateDocumentArtifact(
            markdown,
            planningWorkflowDocumentType(workflow)!,
            "replacement",
          );
        let plan = thread.proposedPlans.find((entry) => entry.turnId === finished.turnId);
        if (!plan) {
          yield* maybeSynthesizeProposedPlan({
            workflow,
            provider: workflow.merge.mergeSlot.provider,
            thread,
            turnId: finished.turnId,
            createdAt: updatedAt,
            validate,
          });
          const refreshed = yield* orchestrationEngine.getReadModel();
          plan = refreshed.threads
            .find((entry) => entry.id === threadId)
            ?.proposedPlans.find((entry) => entry.turnId === finished.turnId);
        }
        const validation = validate(plan?.planMarkdown ?? finished.assistantText ?? "");
        if (plan && validation.valid)
          next = markPolishCompleted(workflow, {
            turnId: finished.turnId,
            planId: plan.id,
            updatedAt,
          });
        else {
          const reason = validation.valid
            ? "No complete document was captured."
            : validation.reason;
          if (pass.polishFormatRepairAttempts >= 1)
            next = markReaderPassError(
              workflow,
              "polish",
              `Invalid document: ${reason}`,
              updatedAt,
            );
          else {
            next = markPolishRequested(
              {
                ...workflow,
                readerPass: {
                  ...pass,
                  polishFormatRepairAttempts: pass.polishFormatRepairAttempts + 1,
                },
              },
              updatedAt,
            );
            yield* upsertWorkflow(next);
            yield* dispatchDocumentReaderStage(next, snapshot, "polish", updatedAt, {
              kind: "retry",
              reusedThread: true,
              formatRepair: true,
              priorFailure: reason,
            }).pipe(
              Effect.catch((error) =>
                upsertWorkflow(markReaderPassError(next, "polish", String(error), updatedAt)).pipe(
                  Effect.asVoid,
                ),
              ),
            );
            return next;
          }
        }
      }
      if (next !== workflow) yield* upsertWorkflow(next);
      return next;
    });

  const maybeContinuePlanningWorkflowLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    handledRevisionThreads?: ReadonlySet<ThreadId>,
  ) =>
    Effect.gen(function* () {
      if (isArchivedWorkflow(workflow)) return;
      yield* maybeStartReviews(workflow, snapshot, updatedAt);
      const dispatchedRevisions = yield* maybeStartRevisions(
        workflow,
        snapshot,
        updatedAt,
        handledRevisionThreads,
      );
      yield* maybeStartMerge(workflow, snapshot, updatedAt);
      yield* maybeContinueDocumentReaderPass(workflow);
      return dispatchedRevisions;
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
      const rawThread = snapshot.threads.find((entry) => entry.id === threadId);
      let thread = rawThread;
      if (!thread) {
        return workflow;
      }

      if (isDocumentWorkflow(workflow) && workflow.merge.status === "merged")
        return yield* maybeAdvanceDocumentReaderPass(
          workflow,
          snapshot,
          threadId,
          updatedAt,
          options?.expectedTurnId,
        );

      const authorBranchId =
        workflow.branchA.authorThreadId === threadId
          ? ("a" as const)
          : workflow.branchB.authorThreadId === threadId
            ? ("b" as const)
            : null;
      if (authorBranchId) {
        const branch = authorBranchId === "a" ? workflow.branchA : workflow.branchB;
        if (branch.status === "plan_saved" || branch.status === "revised") {
          const pinnedTurnId =
            branch.status === "revised" ? branch.revisionTurnId : branch.planTurnId;
          const selection = resolvePinnedAuthorPlan(
            snapshot,
            threadId,
            pinnedTurnId,
            branch.updatedAt,
          );
          if (selection.status !== "ready" || selection.plan.turnId === pinnedTurnId) {
            return workflow;
          }

          const replacementTurnId = selection.plan.turnId;
          if (
            !replacementTurnId ||
            (options?.expectedTurnId && replacementTurnId !== options.expectedTurnId) ||
            (branch.status === "plan_saved" && branch.reviews.length > 0) ||
            workflow.merge.status !== "not_started" ||
            !validateCapturedPlanForTurn({
              workflow,
              provider: branch.authorSlot.provider,
              thread,
              turnId: replacementTurnId,
            }).valid
          ) {
            return workflow;
          }

          const nextWorkflow =
            branch.status === "revised"
              ? markBranchRevised(workflow, authorBranchId, {
                  turnId: replacementTurnId,
                  updatedAt,
                })
              : markBranchPlanSaved(workflow, authorBranchId, {
                  turnId: replacementTurnId,
                  updatedAt,
                });
          if (nextWorkflow !== workflow) {
            yield* upsertWorkflow(nextWorkflow);
          }
          return nextWorkflow;
        }

        const failureStage = planningWorkflowBranchFailureStage(branch);
        // Once the current draft has been fully reviewed, the next author turn
        // is a revision even if a stale failure stage says otherwise.
        const currentDraftReviewed =
          branch.reviews.length > 0 &&
          branch.reviews.every((review) => review.status === "completed") &&
          reviewedPlanTurnIdForBranch(workflow, authorBranchId, branch, snapshot) ===
            branch.planTurnId;
        const authoringStage = branch.status === "authoring" || failureStage === "authoring";
        const isRevisionCompletion =
          branch.status === "revising" ||
          failureStage === "revision" ||
          (authoringStage && currentDraftReviewed);
        const isAuthoringCompletion = authoringStage && !currentDraftReviewed;
        if (!isAuthoringCompletion && !isRevisionCompletion) {
          return workflow;
        }
        thread = yield* stageThread(
          workflow,
          `${isRevisionCompletion ? "revision" : "author"}-${authorBranchId}`,
          rawThread,
        );
        if (!thread) return workflow;
        const turnId = getFinishedLatestTurnId(thread);
        if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId))
          return workflow;
        if (isRevisionCompletion && turnId === branch.planTurnId) {
          return workflow;
        }
        // A rejected turn is not evaluated again while its stage still runs.
        // Planning branches in error may still accept a late valid capture.
        if (
          turnId === branch.rejectedDocumentTurnId &&
          (isDocumentWorkflow(workflow) ||
            branch.status === "authoring" ||
            branch.status === "revising")
        ) {
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
            // Valid late output can still be captured; a failed turn must not
            // trigger another provider turn to repair invalid output.
            if (branch.status === "error") return workflow;
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
        if (!review) return workflow;
        thread = yield* stageThread(
          workflow,
          `${review.slot}-review-${reviewMatch.branchId}`,
          rawThread,
        );
        if (!thread) return workflow;
        const finishedTurn = getFinishedWorkflowReport(thread);
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

      thread = yield* stageThread(workflow, "merge", rawThread);
      if (!thread) return workflow;
      const turnId = getFinishedLatestTurnId(thread);
      if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId)) {
        return workflow;
      }
      const mergeCompletionEvidenceAt =
        thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? null;
      if (
        turnId === workflow.merge.rejectedDocumentTurnId &&
        (isDocumentWorkflow(workflow) || workflow.merge.status === "in_progress")
      )
        return workflow;
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
          if (workflow.merge.status === "error") return workflow;
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

      // The output path comes from the merge turn's file-change activity, which a
      // thread archived before startup has not loaded yet.
      yield* orchestrationEngine.ensureThreadActivities?.([threadId]) ?? Effect.void;
      const latestReadModel = yield* orchestrationEngine.getReadModel();
      const latestMergeThread =
        latestReadModel.threads.find((entry) => entry.id === threadId) ?? thread;
      const mergedPlanId =
        latestMergeThread.proposedPlans.find((plan) => plan.turnId === turnId)?.id ?? null;
      const outputFilePath = latestMarkdownFileChangePath(latestMergeThread, turnId);
      const nextWorkflow =
        isDocumentWorkflow(workflow) && workflow.readerReviewEnabled && mergedPlanId
          ? markDocumentMergeDrafted(workflow, {
              turnId,
              draftPlanId: mergedPlanId,
              readerThreadId: ThreadId.makeUnsafe(
                stableWorkflowUuid("document-reader-thread", workflow.id, turnId, updatedAt),
              ),
              updatedAt,
            })
          : markMergeReadyForManualReview(workflow, {
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
        // thread.turn-diff-completed event re-enters this state machine. At
        // processing quiescence, absence is definitive. Some valid workspaces,
        // such as roots spanning multiple Git repositories, cannot produce a
        // single checkpoint, so continue with read-only workspace inspection.
        if (!checkpoint) {
          if (!implementationThread.latestTurn?.processingQuiescedAt) {
            return;
          }
        } else {
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
      }

      const promptArtifact = implementationReviewPromptArtifact(reviewWorkflow);

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

      const setupResult = yield* Effect.gen(function* () {
        // Validate every undelivered review before creating threads or starting either turn.
        const preparedPrompts = new Map<ThreadId, PreparedImplementationReviewPrompt>();
        for (const [index, review] of requestedReviews.entries()) {
          const reviewState = pendingWorkflow.implementation?.codeReviews.find(
            (candidate) => candidate.threadId === review.threadId,
          );
          if (reviewState?.status !== "pending") continue;
          const reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
          const delivery = behavior.idempotentStageSetup
            ? yield* deliveryForStage(review.threadId, reviewState.updatedAt)
            : null;
          const deliveryError = ensureDeliveryCanResume(
            delivery,
            `${review.reviewerLabel} implementation review`,
          );
          if (deliveryError) return yield* Effect.fail(deliveryError);
          if (reviewThread?.latestTurn || delivery) continue;
          const prepared = prepareCodeReviewPrompt({
            mergedPlanMarkdown: mergedPlan.planMarkdown,
            requirementPrompt: pendingWorkflow.requirementPrompt,
            reviewArtifact: promptArtifact,
            reviewerLabel: review.reviewerLabel,
            lensBranch: index === 0 ? "a" : "b",
            reviewerSlot: review.reviewerSlot,
            enforceArtifactBudget: behavior.loudAuthoritativeArtifactLimit,
            structuredFindings: true,
            thread: reviewThread,
          });
          if (!("prompt" in prepared)) return yield* prepared;
          preparedPrompts.set(review.threadId, prepared);
        }
        yield* Effect.forEach(
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
                  preparedPrompt: preparedPrompts.get(review.threadId),
                  createdAt: updatedAt,
                });
              }
            }),
          { discard: true },
        );
      }).pipe(
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

  const readRevisionTurn = (thread: OrchestrationThread, turnId: TurnId) => {
    if (thread.latestTurn?.turnId === turnId) return Effect.succeed(thread.latestTurn);
    return turnRepository._tag === "Some"
      ? turnRepository.value
          .getByTurnId({ threadId: thread.id, turnId })
          .pipe(Effect.map(Option.getOrNull))
      : Effect.succeed(null);
  };

  const prepareImplementationRevision = (
    workflow: PlanningWorkflow,
    implementation: NonNullable<PlanningWorkflow["implementation"]>,
    snapshot: OrchestrationReadModel,
    legacyFormatting = false,
  ) =>
    Effect.gen(function* () {
      const feedbackSnapshot = legacyFormatting
        ? snapshot
        : yield* hydratePinnedOutputs(workflow, snapshot);
      const reviews = [];
      const pinnedReviews = [];
      for (const review of implementation.codeReviews) {
        const thread = feedbackSnapshot.threads.find((entry) => entry.id === review.threadId);
        let turnId = review.pinnedTurnId;
        let messageId = review.pinnedAssistantMessageId;
        if (thread && !turnId && !messageId) {
          // Legacy saves have only their completion boundary. Use the unique
          // completed output at that boundary, even if a later turn is latest.
          const turns =
            turnRepository._tag === "Some"
              ? yield* turnRepository.value.listByThreadId({ threadId: thread.id })
              : thread.latestTurn
                ? [thread.latestTurn]
                : [];
          const atBoundary = turns.filter((turn) => turn.requestedAt <= review.updatedAt);
          const lastRequestedAt = atBoundary.reduce(
            (latest, turn) => (latest > turn.requestedAt ? latest : turn.requestedAt),
            "",
          );
          const candidates = atBoundary.filter((turn) => turn.requestedAt === lastRequestedAt);
          const candidate =
            candidates.length === 1 &&
            candidates[0]?.state === "completed" &&
            candidates[0].completedAt &&
            candidates[0].completedAt <= review.updatedAt
              ? candidates[0]
              : undefined;
          const completed = candidate?.turnId
            ? getFinishedConsumableTurn(thread, { ...candidate, turnId: candidate.turnId })
            : null;
          turnId = completed?.turnId;
          messageId = completed?.assistantMessageId;
        }
        const message = thread?.messages.find(
          (entry) =>
            entry.id === messageId &&
            entry.turnId === turnId &&
            entry.role === "assistant" &&
            !entry.streaming,
        );
        const feedback = legacyFormatting
          ? message
            ? formatAssistantFeedback(message)
            : null
          : thread && turnId
            ? reviewFeedbackForPinnedTurn(thread, turnId, messageId ?? null, {
                preserveWhitespace: true,
              })
            : null;
        if (review.status !== "completed" || !turnId || !feedback) {
          return yield* Effect.fail(
            new Error(
              `Apply Reviews could not identify the saved output from ${review.reviewerLabel}. Restore the completed review output and retry.`,
            ),
          );
        }
        pinnedReviews.push({
          ...review,
          pinnedTurnId: turnId,
          pinnedAssistantMessageId: messageId,
        });
        reviews.push({
          reviewerLabel: review.reviewerLabel,
          reviewMarkdown: feedback.text,
          source: {
            workflowId: workflow.id,
            stage: review.reviewerLabel,
            turnId,
            ...(messageId ? { messageId } : {}),
          },
        });
      }
      if (reviews.length === 0) {
        return yield* Effect.fail(new Error("Apply Reviews has no saved reviews to send."));
      }
      return {
        pinnedReviews,
        prompt: buildImplementationRevisionPrompt({ reviews }),
        artifacts: reviews.map((review) => review.reviewMarkdown),
      };
    });

  const getRevisionDelivery = (commandId: CommandId) =>
    providerTurnDeliveryRepository._tag === "Some"
      ? providerTurnDeliveryRepository.value.getByCommandId(commandId)
      : Effect.succeed(null);

  const revisionContext = (
    thread: OrchestrationThread,
    slot: NonNullable<PlanningWorkflow["implementation"]>["implementationSlot"],
  ) => {
    // Same window resolution as planning revisions. Apply Reviews additionally
    // treats a compaction estimate as a full window, because it compacts on its
    // own before dispatching when the live fit fails.
    const { session, matchingThread, contextWindowTokens } = workflowContextTarget(slot, thread);
    const compactionEstimateOnly =
      matchingThread &&
      thread.compaction &&
      !thread.compaction.freshSessionRecordId &&
      session?.tokenUsageSource !== "provider" &&
      (thread.compaction.kind === "native" ||
        session?.status === "stopped" ||
        thread.lastInteractionAt <= thread.compaction.createdAt);
    return {
      contextWindowTokens,
      contextUsageTokens: compactionEstimateOnly
        ? contextWindowTokens
        : (session?.estimatedContextTokens ??
          (matchingThread ? thread.estimatedContextTokens : null) ??
          0),
    };
  };

  const reconcileApplyReviews = (
    workflowId: PlanningWorkflowId,
    options: {
      readonly retry?: "manual" | "automatic";
      readonly allowPossibleDuplicate?: boolean;
      readonly recheck?: boolean;
      readonly expectedTurnId?: TurnId | null;
      readonly expectedCommandId?: CommandId;
      readonly preflightOnly?: boolean;
      readonly compactionOutcome?: {
        readonly requestId: CommandId;
        readonly outcome: WorkflowCompactionOutcome;
      };
      readonly session?: Extract<
        OrchestrationEvent,
        { type: "thread.session-set" }
      >["payload"]["session"];
    } = {},
  ): Effect.Effect<OrchestrationRetryWorkflowResult, Error> =>
    Effect.gen(function* () {
      // A provider history read can block. Its result is consumed from the
      // durable delivery only after reacquiring the workflow gate.
      if (
        (options.recheck || options.retry === "manual") &&
        providerTurnDeliveryWorker._tag === "Some"
      ) {
        const current = yield* readWorkflow(orchestrationEngine, workflowId);
        const implementation = current?.implementation;
        if (implementation?.threadId && implementation.revisionDispatchCommandId) {
          const delivery = yield* getRevisionDelivery(implementation.revisionDispatchCommandId);
          if (
            delivery?.state === "sending" ||
            (options.retry === "manual" && delivery?.state === "ambiguous")
          ) {
            yield* providerTurnDeliveryWorker.value
              .recheck(implementation.threadId, delivery.deliveryId)
              .pipe(Effect.timeout(STARTUP_DISPATCH_RECHECK_TIMEOUT), Effect.ignore);
          }
        }
      }

      return yield* withWorkflowGate(
        workflowId,
        Effect.gen(function* () {
          const result = { status: "started" as const };
          const snapshot = yield* orchestrationEngine.getReadModel();
          const current = snapshot.planningWorkflows.find((entry) => entry.id === workflowId);
          if (!current || isDeletedWorkflow(current) || isArchivedWorkflow(current)) return result;
          let workflow = current;
          let implementation = workflow.implementation;
          if (!implementation?.threadId || !isApplyReviewsLifecycle(workflow)) return result;
          if (
            options.expectedCommandId &&
            implementation.revisionDispatchCommandId !== options.expectedCommandId
          )
            return result;
          const threadId = implementation.threadId;
          const thread = snapshot.threads.find(
            (entry) => entry.id === threadId && !entry.deletedAt,
          );
          const updatedAt = new Date().toISOString();

          if (options.session) {
            const withCost = applyWorkflowTurnCost(
              workflow,
              options.session.turnCostUsd,
              updatedAt,
            );
            if (withCost !== workflow) {
              yield* writeWorkflow(withCost);
              workflow = withCost;
            }
            // Only a current error can prompt a look at the exact failed turn.
            if (
              options.session.status !== "error" ||
              thread?.session?.status !== "error" ||
              thread.session.updatedAt !== options.session.updatedAt
            )
              return result;
          }
          const repairOnly = hasMisattributedRevision(workflow);
          if (implementation.status === "completed" && !repairOnly) return result;

          const fail = (detail: string) =>
            writeWorkflow(
              markImplementationError(workflow, detail, updatedAt, "apply-feedback"),
            ).pipe(Effect.as(result));
          if (!thread)
            return yield* fail("The Apply Reviews implementation thread is unavailable.");

          let commandId = implementation.revisionDispatchCommandId;
          let delivery = commandId ? yield* getRevisionDelivery(commandId) : null;
          if (options.preflightOnly && (delivery?.state === "accepted" || repairOnly))
            return result;
          if (!commandId && implementation.revisionAttempt === undefined) {
            let latest =
              providerTurnDeliveryRepository._tag === "Some"
                ? yield* providerTurnDeliveryRepository.value.getLatestByThread(threadId)
                : null;
            const boundary = repairOnly
              ? implementation.codeReviews.reduce(
                  (at, review) => (at > review.updatedAt ? at : review.updatedAt),
                  implementation.codeReviews[0]?.updatedAt ?? implementation.updatedAt,
                )
              : implementation.updatedAt;
            const legacyPrepared = thread.messages.some(
              (entry) => entry.role === "user" && entry.createdAt >= boundary,
            )
              ? yield* prepareImplementationRevision(workflow, implementation, snapshot, true).pipe(
                  Effect.option,
                )
              : Option.none();
            const matchingMessages = Option.isSome(legacyPrepared)
              ? thread.messages.filter(
                  (entry) =>
                    entry.role === "user" &&
                    entry.createdAt >= boundary &&
                    entry.text === legacyPrepared.value.prompt,
                )
              : [];
            const [matchingMessage] = matchingMessages;
            if (
              matchingMessages.length === 1 &&
              matchingMessage &&
              latest?.messageId !== matchingMessage.id
            ) {
              const evidence = yield* orchestrationEngine
                .readEvents(0, { threadId, eventTypes: ["thread.turn-start-requested"] })
                .pipe(
                  Stream.filter(
                    (event) =>
                      event.type === "thread.turn-start-requested" &&
                      event.payload.threadId === threadId &&
                      event.payload.messageId === matchingMessage.id &&
                      event.commandId !== null,
                  ),
                  Stream.take(2),
                  Stream.runCollect,
                );
              const [intent] = evidence;
              if (evidence.length === 1 && intent?.commandId)
                latest = yield* getRevisionDelivery(intent.commandId);
            }
            // The legacy dispatcher used the same timestamp for the durable
            // turn-start event and the applying state. Require the exact outbox
            // event and, when accepted, the turn's projected input association.
            let possibleLegacyDelivery = false;
            if (
              matchingMessages.length <= 1 &&
              latest &&
              (latest.createdAt === boundary ||
                ((repairOnly || implementation.status === "code_reviews_saved") &&
                  latest.createdAt >= boundary)) &&
              latest.event.type === "thread.turn-start-requested" &&
              latest.event.commandId === latest.commandId &&
              latest.event.payload.messageId === latest.messageId &&
              latest.providerTurnId !== implementation.implementationTurnId
            ) {
              const projected =
                latest.providerTurnId && turnRepository._tag === "Some"
                  ? yield* turnRepository.value.getByTurnId({
                      threadId,
                      turnId: latest.providerTurnId,
                    })
                  : Option.none();
              const prepared = legacyPrepared;
              const message = thread.messages.find((entry) => entry.id === latest.messageId);
              possibleLegacyDelivery =
                !message || Option.isNone(prepared) || message.text === prepared.value.prompt;
              if (
                Option.isSome(prepared) &&
                message?.role === "user" &&
                message.text === prepared.value.prompt &&
                (!repairOnly ||
                  (latest.state === "accepted" &&
                    Option.isSome(projected) &&
                    getFinishedConsumableTurn(thread, projected.value) !== null)) &&
                (latest.state !== "accepted" ||
                  (Option.isSome(projected) &&
                    projected.value.pendingMessageId === latest.messageId))
              ) {
                commandId = latest.commandId;
                delivery = latest;
                implementation = {
                  ...implementation,
                  status: "applying_reviews",
                  revisionTurnId: null,
                  revisionAttempt: 0,
                  revisionDispatchCommandId: commandId,
                };
                workflow = { ...workflow, implementation, updatedAt };
                yield* writeWorkflow(workflow);
              }
            }
            if (!commandId && repairOnly) {
              if (options.retry !== "manual") {
                if (options.recheck)
                  yield* Effect.logWarning("Could not verify the legacy Apply Reviews completion", {
                    workflowId,
                    threadId,
                  });
                return result;
              }
              if (!options.allowPossibleDuplicate)
                return { status: "confirmation_required" as const, threadIds: [threadId] };
            }
            if (
              !commandId &&
              !repairOnly &&
              (matchingMessages.length > 0 ||
                (possibleLegacyDelivery &&
                  implementation.status === "code_reviews_saved" &&
                  latest &&
                  latest.createdAt >= boundary &&
                  (latest.state === "accepted" ||
                    latest.state === "sending" ||
                    latest.state === "ambiguous") &&
                  latest.providerTurnId !== implementation.implementationTurnId))
            ) {
              yield* writeWorkflow({
                ...workflow,
                implementation: {
                  ...implementation,
                  status: "error",
                  revisionTurnId: null,
                  errorStage: "apply-feedback",
                  error:
                    "Could not verify the previous Apply Reviews delivery. Check the implementation conversation before retrying.",
                },
                updatedAt,
              });
              return result;
            }
            if (!commandId && implementation.status === "applying_reviews") {
              yield* writeWorkflow({
                ...markImplementationError(
                  workflow,
                  "Could not identify the previous Apply Reviews delivery. Wait for outstanding work to settle, then retry.",
                  updatedAt,
                  "apply-feedback",
                ),
                // Keep the legacy evidence boundary across retries.
                implementation: {
                  ...implementation,
                  status: "error",
                  errorStage: "apply-feedback",
                  error:
                    "Could not identify the previous Apply Reviews delivery. Wait for outstanding work to settle, then retry.",
                },
              });
              return result;
            }
            if (
              !commandId &&
              options.retry &&
              latest &&
              (latest.state === "pending" ||
                latest.state === "sending" ||
                latest.state === "ambiguous")
            ) {
              return yield* Effect.fail(
                new Error(
                  "Resolve the outstanding provider delivery before retrying Apply Reviews.",
                ),
              );
            }
          }

          if (options.preflightOnly && delivery?.state === "accepted") return result;
          let settledFailure = false;
          if (delivery?.state === "accepted") {
            const dispatch = yield* resolveStageDispatch(commandId, threadId);
            if (
              dispatch.kind !== "turn" ||
              dispatch.turnId === implementation.implementationTurnId ||
              (options.expectedTurnId && dispatch.turnId !== options.expectedTurnId)
            )
              return result;
            const turn = yield* readRevisionTurn(thread, dispatch.turnId);
            if (!turn?.completedAt) return result;
            if (dispatch.attributed && turn.state === "completed" && !turn.processingQuiescedAt)
              return result;
            const hasStreamingOutput = thread.messages.some(
              (message) =>
                message.turnId === turn.turnId && message.role === "assistant" && message.streaming,
            );
            if (!hasStreamingOutput && getFinishedConsumableTurn(thread, turn)) {
              if (!options.session)
                yield* writeWorkflow(markImplementationCompleted(workflow, turn.turnId, updatedAt));
              return result;
            }
            settledFailure = Boolean(
              turn.state === "error" ||
              turn.state === "interrupted" ||
              (turn.state === "completed" &&
                turn.processingQuiescedAt &&
                !hasStreamingOutput &&
                isSessionSettledForAutoRetry(thread)),
            );
            if (!settledFailure) return result;
            if (!options.retry) {
              const errorSession =
                thread.latestTurn?.turnId === dispatch.turnId && thread.session?.status === "error"
                  ? thread.session
                  : null;
              const failed = markImplementationError(
                workflow,
                errorSession?.lastError ??
                  (turn.state === "completed"
                    ? "The Apply Reviews turn finished without a finalized response."
                    : "The Apply Reviews turn failed or was interrupted."),
                updatedAt,
                "apply-feedback",
              );
              if (
                commandId &&
                errorSession &&
                isRetryableSessionError(errorSession) &&
                (implementation.lastRetryAt == null ||
                  implementation.lastRetryAt < turn.requestedAt) &&
                implementation.retryCount < MAX_AUTO_RETRY_ATTEMPTS
              ) {
                const expectedCommandId = commandId;
                yield* writeWorkflow(incrementImplementationRetryCount(failed, updatedAt));
                yield* awaitAutoRetrySettled(threadId).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      reconcileApplyReviews(workflowId, {
                        retry: "automatic",
                        expectedCommandId,
                      }),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Apply Reviews automatic retry did not start", {
                      workflowId,
                      cause,
                    }),
                  ),
                  Effect.forkIn(sources.scope),
                );
                return result;
              }
              if (implementation.status !== "error") yield* writeWorkflow(failed);
              return result;
            }
          }

          if (options.session) return result;
          if (repairOnly && options.retry !== "manual") return result;
          if (options.expectedTurnId && !settledFailure && delivery) return result;
          if (delivery?.state === "pending" || delivery?.state === "sending") return result;
          if (implementation.status === "error" && !options.retry) return result;

          const marker = implementation.revisionCompaction;
          const outcome = options.compactionOutcome;
          if (outcome && outcome.requestId !== marker?.requestId) return result;
          if (marker && activeRevisionCompactions.has(marker.requestId) && !outcome) return result;
          const compactionReceipt =
            marker && commandReceipts._tag === "Some"
              ? yield* commandReceipts.value.getByCommandId({ commandId: marker.recordCommandId })
              : Option.none();
          const recoveredContext = Boolean(
            marker &&
            thread.compaction?.freshSessionRecordId === marker.recordCommandId &&
            (commandReceipts._tag === "None" ||
              (Option.isSome(compactionReceipt) && compactionReceipt.value.status === "accepted")),
          );
          if (
            marker &&
            !options.retry &&
            !recoveredContext &&
            outcome?.outcome.kind !== "busy" &&
            outcome?.outcome.kind !== "skipped"
          ) {
            return yield* fail(
              outcome && outcome.outcome.kind !== "committed"
                ? `Apply Reviews context recovery failed. ${outcome.outcome.detail}`
                : "Apply Reviews context recovery was interrupted before its result could be verified. Retry the step.",
            );
          }

          const terminal = delivery?.state === "rejected" || delivery?.state === "ambiguous";
          if (delivery?.state === "abandoned" && !options.retry)
            return yield* fail(
              "The Apply Reviews delivery was discarded. Retry the step to start a new turn.",
            );
          const ambiguous =
            delivery?.state === "ambiguous" ||
            (delivery?.state === "rejected" && delivery.certainty !== "not_sent");
          if (terminal) {
            if (!options.retry && !(marker && !ambiguous && (recoveredContext || outcome))) {
              return yield* fail(
                delivery?.errorDetail ?? "The provider could not accept the Apply Reviews turn.",
              );
            }
            if (ambiguous && !options.allowPossibleDuplicate) {
              return { status: "confirmation_required" as const, threadIds: [threadId] };
            }
          }

          let rejectedReceipt = false;
          if (commandId && !delivery && commandReceipts._tag === "Some") {
            const receipt = yield* commandReceipts.value.getByCommandId({ commandId });
            if (Option.isSome(receipt)) {
              rejectedReceipt = receipt.value.status === "rejected";
              if (rejectedReceipt && !options.retry) {
                return yield* fail(
                  receipt.value.error ?? "The Apply Reviews command was rejected.",
                );
              }
              // An accepted receipt with an unreadable/missing outbox is not a
              // license to create another turn.
              if (!rejectedReceipt) return result;
            }
          }

          if (!isSessionSettledForAutoRetry(thread) || thread.latestTurn?.state === "running") {
            if (options.retry) {
              return yield* Effect.fail(
                new Error("Wait for the active turn to settle before retrying Apply Reviews."),
              );
            }
            return result;
          }
          const branchChanged =
            implementation.branch !== undefined && implementation.branch !== thread.branch;
          const sameWorktreeRename =
            branchChanged &&
            implementation.worktreePath != null &&
            implementation.worktreePath === thread.worktreePath &&
            implementation.branch != null &&
            isTemporaryWorktreeBranch(implementation.branch) &&
            thread.branch != null &&
            (yield* orchestrationEngine
              .readEvents(0, { threadId, eventTypes: ["thread.meta-updated"] })
              .pipe(
                Stream.filter(
                  (event) =>
                    event.type === "thread.meta-updated" &&
                    event.payload.threadId === threadId &&
                    (event.payload.branch !== undefined ||
                      event.payload.worktreePath !== undefined),
                ),
                Stream.runLast,
                Effect.map(Option.getOrNull),
              ));
          const verifiedRename =
            sameWorktreeRename &&
            sameWorktreeRename.type === "thread.meta-updated" &&
            sameWorktreeRename.commandId?.startsWith("server:worktree-branch-rename:") &&
            sameWorktreeRename.payload.branch === thread.branch &&
            sameWorktreeRename.payload.worktreePath === thread.worktreePath;
          if (
            (implementation.worktreePath !== undefined &&
              implementation.worktreePath !== thread.worktreePath) ||
            (branchChanged && !verifiedRename)
          ) {
            return yield* fail(
              "The implementation checkout changed. Restore it before applying the saved reviews.",
            );
          }
          if (verifiedRename) {
            implementation = { ...implementation, branch: thread.branch };
            workflow = { ...workflow, implementation, updatedAt };
            yield* writeWorkflow(workflow);
          }
          const unresolved =
            providerTurnDeliveryRepository._tag === "Some"
              ? yield* providerTurnDeliveryRepository.value.getUnresolvedByThread(threadId)
              : null;
          if (unresolved && unresolved.deliveryId !== delivery?.deliveryId) {
            return yield* fail(
              "Resolve the competing provider delivery before retrying Apply Reviews.",
            );
          }

          const budgetError = workflowBudgetError(workflow);
          if (budgetError) return yield* fail(budgetError.message);
          const prepared = yield* prepareImplementationRevision(
            workflow,
            implementation,
            snapshot,
          ).pipe(
            Effect.match({ onSuccess: (value) => ({ value }), onFailure: (error) => ({ error }) }),
          );
          if ("error" in prepared) return yield* fail(prepared.error.message);
          const targetSlot = resolveAvailableWorkflowModelSlot(
            implementation.implementationSlot,
            yield* getWorkflowProviders,
          );
          const context = revisionContext(thread, targetSlot);
          const behavior = resolveWorkflowBehavior({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
          });
          const artifactTokens = prepared.value.artifacts.reduce(
            (total, artifact) => total + roughTokenEstimateFromCharacters(artifact.length),
            0,
          );
          const fit = (contextUsageTokens: number) =>
            workflowPromptFit({
              ...prepared.value,
              ...context,
              contextUsageTokens,
              promptFramingTokens: Math.max(
                0,
                roughTokenEstimateFromCharacters(prepared.value.prompt.length) - artifactTokens,
              ),
              targetSlot,
              artifactLabel: "Implementation review feedback",
              enforceArtifactBudget: behavior.loudAuthoritativeArtifactLimit,
            });
          const freshFit = fit(0);
          if (freshFit.kind !== "fits") return yield* fail(freshFit.detail);
          const liveFit = fit(context.contextUsageTokens);

          const newAttempt =
            !commandId ||
            settledFailure ||
            rejectedReceipt ||
            delivery?.state === "abandoned" ||
            (options.retry === "manual" &&
              implementation.status === "error" &&
              marker != null &&
              !delivery &&
              !recoveredContext);
          const attempt = (implementation.revisionAttempt ?? 0) + (newAttempt ? 1 : 0);
          const dispatchId = newAttempt
            ? stableWorkflowCommandId("apply-reviews", workflow.id, attempt)
            : commandId!;
          const applyingWorkflow = markImplementationApplyingReviews(
            {
              ...workflow,
              implementation: {
                ...implementation,
                codeReviews: prepared.value.pinnedReviews,
                ...(repairOnly ? { revisionTurnId: null } : {}),
                revisionAttempt: attempt,
                revisionDispatchCommandId: dispatchId,
                ...(newAttempt ? { revisionCompaction: null } : {}),
                ...(options.retry === "manual" ? { retryCount: 0, lastRetryAt: null } : {}),
              },
            },
            updatedAt,
          );
          if (liveFit.kind !== "fits") {
            if (outcome && outcome.outcome.kind !== "committed") {
              return yield* fail(`${liveFit.detail} ${outcome.outcome.detail}`);
            }
            const retryRecovery = options.retry === "manual" && implementation.status === "error";
            if (
              compactionService._tag === "None" ||
              ambiguous ||
              (marker && !newAttempt && !retryRecovery)
            ) {
              return yield* fail(liveFit.detail);
            }
            const requestId = CommandId.makeUnsafe(timeOrderedUuid());
            const recordCommandId = stableWorkflowCommandId(
              "apply-reviews-compaction-record",
              workflow.id,
              requestId,
            );
            yield* writeWorkflow({
              ...applyingWorkflow,
              implementation: {
                ...applyingWorkflow.implementation!,
                revisionCompaction: { requestId, recordCommandId },
              },
            });
            activeRevisionCompactions.add(requestId);
            yield* compactionService.value
              .requestSummary({
                threadId,
                workflowId,
                attempt,
                dispatchCommandId: dispatchId,
                requestId,
                recordCommandId,
                targetSlot,
                contextWindowTokens: context.contextWindowTokens,
                interactionMode: behavior.interactionModeForStage("apply-feedback"),
                workflowExecutionProfile: behavior.executionProfileForStage("apply-feedback"),
                checkFit: (usage) => {
                  const restored = fit(usage);
                  return restored.kind === "fits" ? null : restored.detail;
                },
              })
              .pipe(
                Effect.flatMap((outcome) =>
                  reconcileApplyReviews(workflowId, {
                    expectedCommandId: dispatchId,
                    compactionOutcome: { requestId, outcome },
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    activeRevisionCompactions.delete(requestId);
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not reconcile Apply Reviews context recovery", {
                    workflowId,
                    requestId,
                    cause,
                  }),
                ),
                Effect.forkIn(sources.scope),
              );
            return result;
          }
          if (newAttempt || implementation.status !== "applying_reviews") {
            yield* writeWorkflow(applyingWorkflow);
          }

          const dispatch: Effect.Effect<void, Error> =
            terminal && delivery
              ? providerTurnDeliveryWorker._tag === "Some"
                ? providerTurnDeliveryWorker.value
                    .retry({
                      threadId,
                      deliveryId: delivery.deliveryId,
                      allowPossibleDuplicate: options.allowPossibleDuplicate ?? false,
                    })
                    .pipe(Effect.asVoid)
                : Effect.fail(new Error("The provider delivery worker is unavailable."))
              : dispatchWorkflowTurn(
                  orchestrationEngine,
                  "planning",
                  workflowId,
                  "apply-feedback",
                  {
                    type: "thread.turn.start",
                    commandId: dispatchId,
                    threadId,
                    message: {
                      messageId: MessageId.makeUnsafe(
                        stableWorkflowUuid("apply-reviews-message", workflow.id, attempt),
                      ),
                      role: "user",
                      text: prepared.value.prompt,
                      attachments: [],
                    },
                    ...workflowTurnProviderFields(targetSlot),
                    titleSourceText: workflow.title,
                    runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                    ...workflowTurnBehaviorFields({
                      runKind: "planning",
                      templateId: workflow.templateId,
                      templateVersion: workflow.templateVersion,
                      stage: "apply-feedback",
                    }),
                    createdAt: newAttempt ? updatedAt : implementation.updatedAt,
                  },
                ).pipe(Effect.asVoid);
          yield* dispatch.pipe(
            Effect.catch((error) =>
              writeWorkflow(
                markImplementationError(
                  applyingWorkflow,
                  `Apply Reviews dispatch failed: ${error.message}`,
                  updatedAt,
                  "apply-feedback",
                ),
              ).pipe(Effect.asVoid),
            ),
          );
          return result;
        }),
      );
    }).pipe(
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    );

  const maybeAdvanceImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
    expectedTurnId?: TurnId,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation) {
        return workflow;
      }

      if (threadId === workflow.implementation.threadId && isApplyReviewsLifecycle(workflow)) {
        return workflow;
      }
      const index = workflow.implementation.codeReviews.findIndex(
        (review) => review.threadId === threadId,
      );
      const taskId =
        index >= 0 ? `implementation-review-${index === 0 ? "a" : "b"}` : "implementation";
      const thread = yield* stageThread(
        workflow,
        taskId,
        snapshot.threads.find((entry) => entry.id === threadId),
      );
      const completedTurn =
        index >= 0 ? getFinishedWorkflowReport(thread) : getFinishedConsumableLatestTurn(thread);
      if (!completedTurn || (expectedTurnId && completedTurn.turnId !== expectedTurnId)) {
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
            ? "implementing"
            : workflow.implementation.status;
        nextWorkflow =
          recoveredStatus === "implementing"
            ? markImplementationDone(workflow, completedTurn.turnId, updatedAt)
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
            ? markCodeReviewCompleted(workflow, threadId, completedTurn, updatedAt)
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
      if (isArchivedWorkflow(workflow)) {
        if (
          workflow.implementation?.status === "implemented" &&
          !workflow.implementation.codeReviewEnabled
        )
          yield* upsertWorkflow(markImplementationCompleted(workflow, null, updatedAt));
        return;
      }
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

      if (workflow.implementation.status === "implemented") {
        yield* maybeStartCodeReviews(workflow, snapshot, updatedAt);
        return;
      }

      if (workflow.implementation.status === "code_reviews_saved") {
        yield* reconcileApplyReviews(workflow.id);
      }
    });

  function resumeImplementationStart(
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ): Effect.Effect<PlanningWorkflow, Error> {
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
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
        yield* dispatchWorkflowTurn(
          orchestrationEngine,
          "planning",
          workflow.id,
          "implementation",
          {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
          },
        );
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
      Effect.flatMap((started) =>
        Effect.gen(function* () {
          const threadId = started.implementation?.threadId;
          if (started === workflow || !threadId) return started;
          const latest = yield* orchestrationEngine.getReadModel();
          const current =
            latest.planningWorkflows.find((entry) => entry.id === started.id) ?? started;
          if (isDeletedWorkflow(current) || current.implementation?.status !== "implementing")
            return current;
          const advanced = yield* maybeAdvanceImplementationLifecycle(
            current,
            latest,
            threadId,
            updatedAt,
          );
          if (advanced !== current)
            yield* maybeContinueImplementationLifecycle(advanced, latest, updatedAt);
          return advanced;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Implementation completion could not be rechecked after dispatch", {
              workflowId: started.id,
              cause,
            }).pipe(Effect.as(started)),
          ),
        ),
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

      const original =
        providerTurnDeliveryRepository._tag === "Some"
          ? yield* (
              providerTurnDeliveryRepository.value.getWorkflowStageDelivery?.({
                runKind: "planning",
                workflowId: input.workflow.id,
                taskId: "implementation",
                threadId: input.thread.id,
                first: true,
              }) ?? Effect.succeed(null)
            )
          : null;
      const originalEvent =
        original?.event.type === "thread.turn-start-requested" ? original.event : null;
      const message = original
        ? input.thread.messages.find(
            (message) => message.id === original.messageId && message.role === "user",
          )
        : input.thread.messages.find((message) => message.role === "user" && !message.streaming);
      const prompt =
        message?.text ??
        (original ? yield* readWorkflowPrompt(input.thread.id, original.messageId) : null);
      if (prompt === null)
        return yield* Effect.fail(
          new Error(`Implementation retry message not found on thread '${input.thread.id}'.`),
        );

      return yield* dispatchWorkflowTurn(
        orchestrationEngine,
        "planning",
        input.workflow.id,
        "implementation",
        {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          threadId: input.thread.id,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: prompt,
            attachments: message?.attachments ?? [],
          },
          ...workflowTurnProviderFields(input.workflow.implementation.implementationSlot),
          titleSourceText: input.workflow.title,
          runtimeMode: input.thread.runtimeMode,
          interactionMode: input.thread.interactionMode,
          ...(originalEvent?.payload.sourceProposedPlan
            ? { sourceProposedPlan: originalEvent.payload.sourceProposedPlan }
            : {}),
          createdAt: input.createdAt,
        },
        originalEvent?.payload.workflowAttribution?.reviewTarget,
        originalEvent?.payload.workflowAttribution?.findingRefs ?? [],
      );
    });

  const reconcileWorkflowImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    deferApplyReviews = false,
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

      if (!deferApplyReviews || !isApplyReviewsLifecycle(reconciledWorkflow)) {
        yield* maybeContinueImplementationLifecycle(reconciledWorkflow, snapshot, updatedAt);
      }
    });

  const reconcileWorkflowImplementationLifecycles = Effect.gen(function* () {
    const snapshot = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(snapshot.planningWorkflows, (workflow) =>
      reconcileWorkflowImplementationLifecycle(workflow, snapshot, true).pipe(
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
      // A revision recorded as a fresh draft leaves `plan_saved` with completed
      // reviews of an earlier draft, which no lifecycle step can advance.
      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
        if (
          branch.status !== "plan_saved" ||
          branch.reviews.length === 0 ||
          !branch.reviews.every((review) => review.status === "completed")
        ) {
          continue;
        }
        const reviewedTurnId = reviewedPlanTurnIdForBranch(
          reconciledWorkflow,
          branchId,
          branch,
          snapshot,
        );
        if (!reviewedTurnId || reviewedTurnId === branch.planTurnId) {
          continue;
        }
        const authorThread = snapshot.threads.find((entry) => entry.id === branch.authorThreadId);
        if (
          !branch.planTurnId ||
          !authorThread?.proposedPlans.some((plan) => plan.turnId === branch.planTurnId)
        ) {
          yield* Effect.logWarning("workflow revision recorded as draft could not be repaired", {
            workflowId: workflow.id,
            branchId,
            reviewedTurnId,
            planTurnId: branch.planTurnId,
          });
          continue;
        }
        const repairedBranch: PlanningWorkflow["branchA"] = {
          ...branch,
          status: "revised",
          planTurnId: reviewedTurnId,
          revisionTurnId: branch.planTurnId,
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
        ...(reconciledWorkflow.readerPass ? [reconciledWorkflow.readerPass.readerThreadId] : []),
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

      const dispatchedRevisions = yield* maybeContinuePlanningWorkflowLifecycle(
        reconciledWorkflow,
        latestSnapshot,
        updatedAt,
      );
      yield* refreshWorkflowFromSnapshot;

      const readerPass = reconciledWorkflow.readerPass;
      if (
        readerPass &&
        (readerPass.status === "reader_running" || readerPass.status === "polishing")
      ) {
        const stage = readerPass.status === "reader_running" ? "reader" : "polish";
        const thread = latestSnapshot.threads.find(
          (entry) =>
            entry.id ===
            (stage === "reader" ? readerPass.readerThreadId : reconciledWorkflow.merge.threadId),
        );
        // Only audit a stage that was already running when reconciliation began.
        if (
          workflow.readerPass?.status === readerPass.status &&
          isSessionUnavailableForReconciliation(thread)
        ) {
          reconciledWorkflow = markReaderPassError(
            reconciledWorkflow,
            stage,
            `${stage === "reader" ? "Reader review" : "Polish"} session is unavailable; retry the failed stage.`,
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      for (const branchId of ["a", "b"] as const) {
        const branch = branchId === "a" ? reconciledWorkflow.branchA : reconciledWorkflow.branchB;
        const baselineBranch = branchId === "a" ? workflow.branchA : workflow.branchB;
        const authorThread = latestSnapshot.threads.find(
          (thread) => thread.id === branch.authorThreadId,
        );
        const startedBranchThisPass =
          dispatchedRevisions?.has(branch.authorThreadId) ||
          (baselineBranch.status !== branch.status &&
            (branch.status === "authoring" || branch.status === "revising"));
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

      if (reconciledWorkflow.implementation?.status === "implementing") {
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
            "Implementation session was not running during reconciliation.",
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
      // Partial messages cannot complete a stage. Avoid snapshot and delivery reads
      // for token deltas across all threads, including unrelated workflows.
      if (
        event.type === "thread.message-sent" &&
        (event.payload.streaming || event.payload.role !== "assistant")
      )
        return;
      // Reader and polish share the normal event stream, but own their completion pins.
      if (
        [
          "thread.proposed-plan-upserted",
          "thread.turn-diff-completed",
          "thread.turn-processing-quiesced",
          "thread.message-sent",
          "thread.session-set",
        ].includes(event.type) &&
        "threadId" in event.payload
      ) {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const threadId = event.payload.threadId as ThreadId;
        const applying = workflowForImplementationThread(
          snapshot.planningWorkflows,
          threadId,
        )?.workflow;
        if (applying && isApplyReviewsLifecycle(applying)) {
          if (event.type === "thread.session-set") {
            yield* reconcileApplyReviews(applying.id, {
              session: { ...event.payload.session, turnCostUsd: workflowSessionTurnCost(event) },
            });
            if (
              event.payload.session.status === "ready" ||
              event.payload.session.status === "stopped"
            )
              yield* reconcileApplyReviews(applying.id, { preflightOnly: true });
          } else if (
            event.type === "thread.turn-diff-completed" ||
            event.type === "thread.turn-processing-quiesced" ||
            event.type === "thread.message-sent"
          ) {
            if (event.payload.turnId) {
              yield* reconcileApplyReviews(applying.id, { expectedTurnId: event.payload.turnId });
            }
          }
          return;
        }
        const document = documentWorkflowForThread(snapshot.planningWorkflows, threadId);
        if (
          document &&
          (document.readerPass?.readerThreadId === threadId || document.merge.threadId === threadId)
        ) {
          let current = document;
          if (event.type === "thread.session-set") {
            if (
              current.merge.status === "merged" ||
              current.readerPass?.readerThreadId === threadId ||
              (current.merge.status === "manual_review" && event.payload.session.status === "error")
            ) {
              current = yield* recordWorkflowTurnCost(
                current,
                workflowSessionTurnCost(event),
                event.occurredAt,
              );
            }
            if (
              event.payload.session.status === "error" &&
              current.merge.status === "merged" &&
              current.readerPass
            ) {
              const stage = threadId === current.readerPass.readerThreadId ? "reader" : "polish";
              if (stage === "polish" && current.readerPass.status !== "polishing") return;
              if (
                stage === "reader" &&
                !["reader_requested", "reader_running", "error"].includes(current.readerPass.status)
              )
                return;
              const failed = markReaderPassError(
                current,
                stage,
                formatSessionError(event.payload.session, `${stage} failed.`),
                event.occurredAt,
              );
              yield* upsertWorkflow(failed);
              if (
                stage === "reader" &&
                current.readerPass.status === "reader_running" &&
                current.readerPass.readerStartedAt !== null &&
                snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.state ===
                  "error" &&
                (snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn
                  ?.requestedAt ?? "") >= current.readerPass.readerStartedAt &&
                isRetryableSessionError(event.payload.session) &&
                current.readerPass.retryCount < MAX_AUTO_RETRY_ATTEMPTS
              ) {
                const count = current.readerPass.retryCount + 1;
                const retrying = {
                  ...failed,
                  readerPass: {
                    ...failed.readerPass!,
                    retryCount: count,
                    lastRetryAt: event.occurredAt,
                  },
                };
                yield* upsertWorkflow(retrying);
                yield* forkAutoRetry({
                  kind: "document_reader",
                  workflowId: current.id,
                  threadId,
                  buildDispatch: ({ workflow, snapshot: retrySnapshot }) => {
                    if (
                      workflow.readerPass?.status !== "error" ||
                      workflow.readerPass.errorStage !== "reader" ||
                      workflow.readerPass.retryCount !== count ||
                      hasActiveRunningTurn(
                        retrySnapshot.threads.find((entry) => entry.id === threadId),
                      )
                    )
                      return null;
                    return Effect.gen(function* () {
                      const now = new Date().toISOString();
                      const running = markReaderRunning(workflow, now);
                      yield* upsertWorkflow(running);
                      yield* dispatchDocumentReaderStage(
                        running,
                        retrySnapshot,
                        "reader",
                        now,
                      ).pipe(
                        Effect.catch((error) =>
                          upsertWorkflow(
                            markReaderPassError(running, "reader", String(error), now),
                          ).pipe(Effect.asVoid),
                        ),
                      );
                    });
                  },
                });
              }
              return;
            }
            if (
              event.payload.session.status === "error" &&
              current.merge.status === "manual_review"
            )
              return;
          }
          if (current.merge.status === "merged") {
            const expectedTurnId =
              event.type === "thread.proposed-plan-upserted"
                ? event.payload.proposedPlan.turnId
                : "turnId" in event.payload
                  ? (event.payload.turnId as TurnId | null)
                  : undefined;
            current = yield* maybeAdvanceDocumentReaderPass(
              current,
              snapshot,
              threadId,
              event.occurredAt,
              expectedTurnId,
            );
            yield* maybeContinueDocumentReaderPass(current);
            return;
          }
          if (
            event.type === "thread.turn-processing-quiesced" &&
            current.merge.status === "manual_review" &&
            current.merge.threadId === threadId &&
            current.implementation === null &&
            event.payload.turnId !== current.merge.turnId
          ) {
            const thread = snapshot.threads.find((entry) => entry.id === threadId);
            if (thread && !hasProposedPlanForTurn(thread, event.payload.turnId))
              yield* maybeSynthesizeProposedPlan({
                workflow: current,
                provider: current.merge.mergeSlot.provider,
                thread,
                turnId: event.payload.turnId,
                createdAt: event.occurredAt,
                validate: (markdown) =>
                  validateDocumentArtifact(
                    markdown,
                    planningWorkflowDocumentType(current)!,
                    "replacement",
                  ),
              });
          }
        }
      }
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
            event.payload.proposedPlan.implementedAt === null &&
            (!isDocumentWorkflow(nextWorkflow) ||
              validateDocumentArtifact(
                event.payload.proposedPlan.planMarkdown,
                planningWorkflowDocumentType(nextWorkflow)!,
                "replacement",
              ).valid)
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

        case "thread.turn-processing-quiesced": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (
            implementationMatch?.workflow.implementation &&
            (implementationMatch.workflow.implementation.status === "implementing" ||
              implementationMatch.workflow.implementation.status === "applying_reviews" ||
              implementationMatch.workflow.implementation.status === "error" ||
              implementationMatch.workflow.implementation.implementationTurnId ===
                event.payload.turnId)
          ) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
              event.payload.turnId,
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
          if (!planningWorkflow) {
            return;
          }

          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            planningWorkflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.turnId },
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
            recordWorkflowTurnCost(workflow, workflowSessionTurnCost(event), event.occurredAt);
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
              const workflowWithCost = yield* applyTurnCost(implementationMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
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
              const workflowWithCost = yield* applyTurnCost(codeReviewMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
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
              const workflowWithCost = yield* applyTurnCost(planningWorkflow);
              const nextWorkflow =
                event.payload.session.status === "ready"
                  ? yield* maybeAdvancePlanningWorkflowFromCompletedThread(
                      workflowWithCost,
                      readModel,
                      event.payload.threadId,
                      event.occurredAt,
                    )
                  : workflowWithCost;
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
            const baseWorkflow = yield* applyTurnCost(reviewMatch.workflow);
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
            const baseWorkflow = yield* applyTurnCost(authorMatch.workflow);
            const branch =
              authorMatch.branchId === "a" ? baseWorkflow.branchA : baseWorkflow.branchB;
            if (branch.status !== "authoring" && branch.status !== "revising") {
              return;
            }
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
                      interrupted: true,
                      priorFailure: event.payload.session.lastError ?? undefined,
                    },
                  });
                },
                markFailed: ({ workflow, detail, failedAt }) => {
                  const branch = authorMatch.branchId === "a" ? workflow.branchA : workflow.branchB;
                  if (branch.status !== "authoring" || branch.retryCount !== expectedRetryCount) {
                    return null;
                  }
                  return markBranchError(workflow, authorMatch.branchId, {
                    error: `${formatSessionError(event.payload.session, "Authoring failed.")} | Automatic retry failed: ${detail}`,
                    stage: "authoring",
                    updatedAt: failedAt,
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
            const baseWorkflow = yield* applyTurnCost(implementationMatch.workflow);
            if (
              baseWorkflow.implementation &&
              baseWorkflow.implementation.status === "implementing" &&
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
                      workflow.implementation.status !== "implementing" ||
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
                  markFailed: ({ workflow, detail, failedAt }) =>
                    workflow.implementation?.status === "implementing" &&
                    workflow.implementation.retryCount === expectedRetryCount
                      ? markImplementationError(workflow, detail, failedAt, "implementation")
                      : null,
                });
                return;
              }
            }

            yield* upsertWorkflow(
              markImplementationError(
                baseWorkflow,
                formatSessionError(event.payload.session, "Implementation failed."),
                event.occurredAt,
                baseWorkflow.implementation?.status === "applying_reviews"
                  ? "apply-feedback"
                  : "implementation",
              ),
            );
            return;
          }

          if (codeReviewMatch) {
            const baseWorkflow = yield* applyTurnCost(codeReviewMatch.workflow);
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
                      thread: retryThread,
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
                yield* applyTurnCost(mergeMatch.workflow),
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
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
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
    const events = Stream.map(orchestrationEngine.streamDomainEvents, (event) => ({
      kind: "event" as const,
      event,
    }));
    const deliveries =
      providerTurnDeliveryWorker._tag === "Some"
        ? providerTurnDeliveryWorker.value.outcomes.pipe(
            Stream.map((outcome) => ({
              kind: "delivery" as const,
              outcome,
              threadId: outcome.threadId,
            })),
          )
        : Stream.empty;
    yield* Stream.runForEach(Stream.merge(events, deliveries), (item) => {
      if (item.kind === "event") return handleDomainEvent(item.event);
      return Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const at = item.outcome.occurredAt ?? new Date().toISOString();
        const onImplementationThread = workflowForImplementationThread(
          snapshot.planningWorkflows,
          item.threadId,
        )?.workflow;
        const revisionCommandId = onImplementationThread?.implementation?.revisionDispatchCommandId;
        if (
          onImplementationThread &&
          revisionCommandId &&
          isApplyReviewsLifecycle(onImplementationThread)
        ) {
          const origin =
            item.outcome.state === "accepted"
              ? yield* resolveDeliveryOrigin(item.outcome)
              : item.outcome.commandId;
          if (origin === revisionCommandId) {
            yield* reconcileApplyReviews(onImplementationThread.id, {
              expectedCommandId: revisionCommandId,
            });
          }
          return;
        }
        if (item.outcome.state !== "accepted") return;
        const document = documentWorkflowForThread(snapshot.planningWorkflows, item.threadId);
        if (
          document?.merge.status === "merged" &&
          (document.readerPass?.readerThreadId === item.threadId ||
            document.merge.threadId === item.threadId)
        ) {
          const next = yield* maybeAdvanceDocumentReaderPass(document, snapshot, item.threadId, at);
          yield* maybeContinueDocumentReaderPass(next);
          return;
        }
        const planning =
          workflowForAuthorThread(snapshot.planningWorkflows, item.threadId)?.workflow ??
          workflowForReviewThread(snapshot.planningWorkflows, item.threadId)?.workflow ??
          workflowForMergeThread(snapshot.planningWorkflows, item.threadId)?.workflow;
        if (planning) {
          const next = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            planning,
            snapshot,
            item.threadId,
            at,
          );
          if (next !== planning)
            yield* maybeContinuePlanningWorkflowLifecycle(
              next,
              yield* orchestrationEngine.getReadModel(),
              at,
            );
          return;
        }
        const implementation =
          onImplementationThread ??
          workflowForCodeReviewThread(snapshot.planningWorkflows, item.threadId)?.workflow;
        if (!implementation) return;
        const next = yield* maybeAdvanceImplementationLifecycle(
          implementation,
          snapshot,
          item.threadId,
          at,
        );
        if (next !== implementation)
          yield* maybeContinueImplementationLifecycle(
            next,
            yield* orchestrationEngine.getReadModel(),
            at,
          );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Planning workflow delivery reconciliation failed", { cause }),
        ),
      );
    }).pipe(
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope, { startImmediately: true }),
      Effect.asVoid,
    );
    const latest = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      latest.planningWorkflows.filter(
        (workflow) =>
          isApplyReviewsLifecycle(workflow) &&
          (workflow.implementation?.status !== "completed" || hasMisattributedRevision(workflow)),
      ),
      (workflow) =>
        reconcileApplyReviews(workflow.id, { recheck: true }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not reconcile Apply Reviews at startup", {
              workflowId: workflow.id,
              cause,
            }),
          ),
        ),
      { discard: true },
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
        ...(rawInput.templateId === DOCUMENT_WORKFLOW_TEMPLATE_ID
          ? { readerReviewEnabled: rawInput.readerReviewEnabled ?? true }
          : {}),
        branchA: resolveAvailableWorkflowModelSlot(rawInput.branchA, providers),
        branchB: resolveAvailableWorkflowModelSlot(rawInput.branchB, providers),
        merge: resolveAvailableWorkflowModelSlot(rawInput.merge, providers),
      };
      const behavior = yield* Effect.try({
        try: () =>
          resolveWorkflowBehavior({
            runKind: "planning",
            templateId: input.templateId,
            templateVersion:
              input.templateVersion ??
              latestWorkflowTemplateVersion({ runKind: "planning", templateId: input.templateId }),
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
      const document = input.templateId === DOCUMENT_WORKFLOW_TEMPLATE_ID;
      const documentInvariant = documentWorkflowCreateInvariant({
        ...input,
        readerSlot: input.reader,
      });
      if (documentInvariant) return yield* Effect.fail(new Error(documentInvariant));
      if (
        document &&
        input.branchA.provider === input.branchB.provider &&
        input.branchA.model === input.branchB.model
      )
        return yield* Effect.fail(
          new Error("Document workflows need two different author models."),
        );
      const readerSlot =
        document && input.readerReviewEnabled
          ? resolveAvailableWorkflowModelSlot(
              input.reader ?? defaultDocumentReaderSlot(input),
              providers,
            )
          : undefined;
      if (readerSlot)
        yield* Effect.try({
          try: () =>
            assertWorkflowStageProviderSupported({
              behavior,
              stage: "plan-review",
              provider: readerSlot.provider,
            }),
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
        documentType: input.documentType,
        readerReviewEnabled: input.readerReviewEnabled,
        readerPersona: input.readerPersona,
        readerSlot,
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
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
        documentType: input.documentType,
        readerReviewEnabled: input.readerReviewEnabled,
        readerPersona: input.readerPersona,
        readerSlot,
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
          suffix: document ? "Draft A" : "Branch A",
          lane: "a",
          now,
        }),
        createWorkflowThread({
          orchestrationEngine,
          input,
          threadId: authorThreadIdB,
          suffix: document ? "Draft B" : "Branch B",
          lane: "b",
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
      if (workflow && isArchivedWorkflow(workflow))
        return yield* Effect.fail(
          new Error("Restore the workflow before starting implementation."),
        );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }
      if (isDocumentWorkflow(workflow))
        return yield* Effect.fail(
          new Error(
            "Document workflows end at the final document and have no implementation phase.",
          ),
        );
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
        const preparationScript = setupProjectScript(
          snapshot.projects.find((project) => project.id === implementationWorkflow.projectId)
            ?.scripts ?? [],
        );
        const createdWorktree = yield* gitCore
          .createWorktree({
            preparation: {
              owner: `workflow:${implementationWorkflow.id}`,
              runSetupScript: preparationScript !== null,
              setupIdentity: preparationScript?.command ?? null,
            },
            cwd: workspaceRoot,
            branch: input.baseBranch,
            newBranch,
            path: yield* gitCore.allocateWorktreePath({ cwd: workspaceRoot, branch: newBranch }),
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

  const deleteWorkflow: WorkflowServiceShape["deleteWorkflow"] = (
    workflowId,
    deleteThreads = false,
  ) =>
    changeWorkflowArchive.delete(
      workflowId,
      Effect.gen(function* () {
        const workflow = yield* readWorkflow(orchestrationEngine, workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
        }

        const result = yield* orchestrationEngine.dispatch({
          type: "project.workflow.delete",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          workflowId,
          deleteThreads,
          projectId: workflow.projectId,
          createdAt: new Date().toISOString(),
        });
        return deleteThreads
          ? { deletedThreadIds: [...(result.deletedThreadIds ?? [])] }
          : undefined;
      }),
    );

  const changeWorkflowArchive = makeWorkflowArchiveLifecycle(orchestrationEngine, "planning");

  const archiveWorkflow: WorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.archive(workflowId);

  const unarchiveWorkflow: WorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.unarchive(workflowId, (snapshot) =>
      Effect.gen(function* () {
        const workflow = snapshot.planningWorkflows.find((entry) => entry.id === workflowId);
        if (workflow) yield* reconcileStuckWorkflow(workflow, snapshot);
        const latest = yield* orchestrationEngine.getReadModel();
        const current = latest.planningWorkflows.find((entry) => entry.id === workflowId);
        if (current && isApplyReviewsLifecycle(current)) {
          yield* reconcileApplyReviews(current.id, { recheck: true });
        } else if (current) {
          yield* reconcileWorkflowImplementationLifecycle(current, latest);
        }
      }),
    );

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
      if (isArchivedWorkflow(workflow))
        return yield* Effect.fail(new Error("Restore the workflow before retrying it."));

      if (
        isApplyReviewsLifecycle(workflow) &&
        (workflow.implementation?.status !== "completed" || hasMisattributedRevision(workflow))
      ) {
        return yield* reconcileApplyReviews(workflow.id, {
          retry: "manual",
          allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
        });
      }

      const updatedAt = new Date().toISOString();
      const failedThreadIds = new Set<ThreadId>();
      if (workflow.readerPass?.status === "error") {
        const threadId =
          workflow.readerPass.errorStage === "reader"
            ? workflow.readerPass.readerThreadId
            : workflow.merge.threadId;
        if (threadId) failedThreadIds.add(threadId);
      }

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
          workflow.implementation.errorStage !== "review-setup" &&
          workflow.implementation.threadId
        ) {
          failedThreadIds.add(workflow.implementation.threadId);
        }
      }

      const deliveryStateByThread = new Map<
        ThreadId,
        "pending" | "sending" | "accepted" | "rejected" | "ambiguous"
      >();
      const deliveryCreatedAtByThread = new Map<ThreadId, string>();
      const deliveries =
        providerTurnDeliveryWorker._tag === "Some"
          ? yield* Effect.forEach([...failedThreadIds], (threadId) =>
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
            )
          : [];
      const snapshot = yield* orchestrationEngine.getReadModel();
      const revisionPlanByThread = new Map<
        ThreadId,
        { turnId: TurnId | null; createdAt: string }
      >();
      for (const branch of [workflow.branchA, workflow.branchB]) {
        if (planningWorkflowBranchFailureStage(branch) !== "revision" || !branch.planTurnId)
          continue;
        const plan = snapshot.threads
          .find((thread) => thread.id === branch.authorThreadId)
          ?.proposedPlans.find((plan) => plan.turnId === branch.planTurnId);
        if (plan) revisionPlanByThread.set(branch.authorThreadId, plan);
      }
      for (const { threadId, delivery } of deliveries) {
        if (!delivery || delivery.state === "abandoned") continue;
        const plan = revisionPlanByThread.get(threadId);
        // A delivery that produced or predates the reviewed plan belongs to authoring.
        if (
          plan &&
          (delivery.createdAt < plan.createdAt || delivery.providerTurnId === plan.turnId)
        ) {
          continue;
        }
        deliveryStateByThread.set(threadId, delivery.state);
        deliveryCreatedAtByThread.set(threadId, delivery.createdAt);
      }
      const ambiguousThreadIds = [...deliveryStateByThread]
        .filter(([, state]) => state === "ambiguous")
        .map(([threadId]) => threadId);
      const deliveryMode = (
        threadId: ThreadId | null,
      ): "fresh" | "accepted" | "queued" | "retry" => {
        if (!threadId) return "fresh";
        // Accepted delivery says nothing about artifact validity. A completed invalid
        // capture needs a new turn, rather than waiting on the old accepted delivery.
        if (
          isDocumentWorkflow(workflow) &&
          !hasActiveRunningTurn(snapshot.threads.find((thread) => thread.id === threadId))
        ) {
          const branch = [workflow.branchA, workflow.branchB].find(
            (entry) => entry.authorThreadId === threadId,
          );
          const error =
            branch?.status === "error"
              ? branch.error
              : workflow.merge.threadId === threadId && workflow.merge.status === "error"
                ? workflow.merge.error
                : null;
          if (error?.startsWith("Invalid document:")) return "fresh";
        }
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
      const acceptedStageRequestedAt = (threadId: ThreadId, fallback: string) =>
        isDocumentWorkflow(workflow)
          ? (deliveryCreatedAtByThread.get(threadId) ??
            snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.requestedAt ??
            fallback)
          : updatedAt;
      const markAcceptedMergeStarted = (current: PlanningWorkflow, threadId: ThreadId) => ({
        ...markMergeStarted(
          current,
          threadId,
          acceptedStageRequestedAt(threadId, current.merge.updatedAt),
        ),
        updatedAt,
      });
      let retriedWorkflow = workflow;
      const handledAcceptedThreadIds = new Set<ThreadId>();
      const handledRevisionThreads = new Set<ThreadId>();
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
              updatedAt:
                stage === "revision"
                  ? (deliveryCreatedAtByThread.get(branch.authorThreadId) ??
                    currentBranch.updatedAt)
                  : acceptedStageRequestedAt(branch.authorThreadId, currentBranch.updatedAt),
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
          if (stage === "revision") handledRevisionThreads.add(branch.authorThreadId);
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
          retriedWorkflow = markAcceptedMergeStarted(retriedWorkflow, workflow.merge.threadId);
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
          workflow.implementation.errorStage !== "review-setup" &&
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
        (workflow.implementation?.status === "error" &&
          workflow.implementation.errorStage === "review-setup") ||
        (workflow.merge.status === "error" &&
          (!workflow.merge.threadId || deliveryMode(workflow.merge.threadId) === "fresh"));
      if (willSpend) {
        const budgetError = workflowBudgetError(workflow);
        if (budgetError) {
          return yield* Effect.fail(new Error(budgetError.message));
        }
      }

      if (isDocumentWorkflow(workflow) && workflow.readerPass?.status === "error") {
        const pass = workflow.readerPass;
        const stage = pass.errorStage ?? "reader";
        const threadId = stage === "reader" ? pass.readerThreadId : workflow.merge.threadId!;
        const mode = deliveryMode(threadId);
        if (mode === "accepted") {
          const advanced = yield* maybeAdvanceDocumentReaderPass(
            workflow,
            snapshot,
            threadId,
            updatedAt,
          );
          if (advanced !== workflow) {
            yield* maybeContinueDocumentReaderPass(advanced);
            return { status: "started" as const };
          }
          if (hasActiveRunningTurn(snapshot.threads.find((entry) => entry.id === threadId)))
            return { status: "started" as const };
        }
        if ((mode === "retry" || mode === "queued") && providerTurnDeliveryWorker._tag === "Some") {
          const resumed: PlanningWorkflow = {
            ...workflow,
            readerPass: {
              ...pass,
              status: stage === "reader" ? "reader_running" : "polishing",
              readerStartedAt:
                stage === "reader"
                  ? (pass.readerStartedAt ??
                    deliveryCreatedAtByThread.get(threadId) ??
                    pass.updatedAt)
                  : pass.readerStartedAt,
              error: null,
              errorStage: null,
              retryCount: 0,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(resumed);
          yield* providerTurnDeliveryWorker.value
            .retry({ threadId, allowPossibleDuplicate: input.allowPossibleDuplicate ?? false })
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* upsertWorkflow(
                    markReaderPassError(resumed, stage, String(error), new Date().toISOString()),
                  );
                  return yield* Effect.fail(new Error(String(error)));
                }),
              ),
            );
        } else {
          const next: PlanningWorkflow = {
            ...workflow,
            readerPass: {
              ...pass,
              status: stage === "reader" ? "reader_requested" : "reader_saved",
              ...(stage === "reader"
                ? {
                    previousReaderThreadIds: [
                      ...(pass.previousReaderThreadIds ?? []),
                      pass.readerThreadId,
                    ],
                    readerThreadId: ThreadId.makeUnsafe(crypto.randomUUID()),
                    readerStartedAt: null,
                    pinnedTurnId: null,
                    pinnedAssistantMessageId: null,
                    polishRequestedAt: null,
                    polishTurnId: null,
                  }
                : {}),
              error: null,
              errorStage: null,
              retryCount: 0,
              polishFormatRepairAttempts: 0,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(next);
          yield* maybeContinueDocumentReaderPass(next);
        }
        return { status: "started" as const };
      }
      const planForBranch = (branch: PlanningWorkflow["branchA"]) =>
        completedProposedPlanForTurn(
          snapshot,
          branch.authorThreadId,
          branch.planTurnId,
          branch.updatedAt,
        )?.planMarkdown ?? null;

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
          workflow.branchA.updatedAt,
        )?.planMarkdown;
        const planB = completedProposedPlanForTurn(
          snapshot,
          workflow.branchB.authorThreadId,
          workflow.branchB.revisionTurnId,
          workflow.branchB.updatedAt,
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
        workflow.implementation.errorStage !== "review-setup" &&
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
          ...(isDocumentWorkflow(workflow)
            ? {
                ...(originalStage === "revision"
                  ? { revisionFormatRepairAttempts: 0 }
                  : { authorFormatRepairAttempts: 0 }),
                ...(originalBranch.error?.startsWith("Invalid document:")
                  ? {
                      rejectedDocumentTurnId:
                        snapshot.threads.find(
                          (thread) => thread.id === originalBranch.authorThreadId,
                        )?.latestTurn?.turnId ??
                        originalBranch.rejectedDocumentTurnId ??
                        null,
                    }
                  : {}),
              }
            : {}),
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
              ...(isDocumentWorkflow(workflow) &&
              originalBranch.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: originalBranch.error ?? undefined,
            },
          });
        } else {
          const authorThread = snapshot.threads.find(
            (entry) => entry.id === originalBranch.authorThreadId,
          );
          // The reviewed plan is pinned by turn id, as automatic revision setup reads
          // it. A newer unsettled turn (such as a native compaction) can't hide it.
          const pinnedPlan = originalBranch.planTurnId
            ? authorThread?.proposedPlans.find((plan) => plan.turnId === originalBranch.planTurnId)
            : undefined;
          if (
            !pinnedPlan &&
            resolveWorkflowBehavior({
              runKind: "planning",
              templateId: workflow.templateId,
              templateVersion: workflow.templateVersion,
            }).templateVersion === 2
          ) {
            retriedWorkflow = yield* rejectRevision(
              { workflow: retriedWorkflow, branch: originalBranch, createdAt: updatedAt },
              `The reviewed ${isDocumentWorkflow(workflow) ? "draft" : "plan"} for Branch ${branchId.toUpperCase()} could not be found, so the revision was not sent.`,
            );
            continue;
          }
          const revisionOutcome = yield* dispatchRevisionTurn({
            workflow: retriedWorkflow,
            branch: originalBranch,
            originalPlanMarkdown: pinnedPlan?.planMarkdown ?? "# Original plan unavailable",
            ...(pinnedPlan ? { originalPlanCreatedAt: pinnedPlan.createdAt } : {}),
            reviews: revisionFeedback.get(branchId)!,
            ...(authorThread ? { thread: authorThread } : {}),
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              ...(isDocumentWorkflow(workflow) &&
              originalBranch.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: originalBranch.error ?? undefined,
            },
          });
          if (!revisionOutcome.started) {
            retriedWorkflow = revisionOutcome.workflow;
            continue;
          }
          handledRevisionThreads.add(originalBranch.authorThreadId);
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
            retriedWorkflow = markAcceptedMergeStarted(
              retriedWorkflow,
              retriedWorkflow.merge.threadId,
            );
            yield* upsertWorkflow(retriedWorkflow);
          }
        } else if (
          mode === "fresh" &&
          isDocumentWorkflow(retriedWorkflow) &&
          retriedWorkflow.merge.threadId
        ) {
          const next = markMergeStarted(
            {
              ...retriedWorkflow,
              merge: {
                ...retriedWorkflow.merge,
                formatRepairAttempts: 0,
                ...(retriedWorkflow.merge.error?.startsWith("Invalid document:")
                  ? {
                      rejectedDocumentTurnId:
                        snapshot.threads.find(
                          (thread) => thread.id === retriedWorkflow.merge.threadId,
                        )?.latestTurn?.turnId ??
                        retriedWorkflow.merge.rejectedDocumentTurnId ??
                        null,
                    }
                  : {}),
              },
            },
            retriedWorkflow.merge.threadId,
            updatedAt,
          );
          yield* upsertWorkflow(next);
          yield* startMergeTurn({
            orchestrationEngine,
            workflow: next,
            threadId: next.merge.threadId!,
            planA: completedProposedPlanForTurn(
              snapshot,
              next.branchA.authorThreadId,
              next.branchA.revisionTurnId,
              next.branchA.updatedAt,
            )!.planMarkdown,
            planB: completedProposedPlanForTurn(
              snapshot,
              next.branchB.authorThreadId,
              next.branchB.revisionTurnId,
              next.branchB.updatedAt,
            )!.planMarkdown,
            reviews: [
              ...(yield* reviewFeedbackForBranch(next.id, next.branchA, snapshot)),
              ...(yield* reviewFeedbackForBranch(next.id, next.branchB, snapshot)),
            ],
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              ...(retriedWorkflow.merge.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: retriedWorkflow.merge.error ?? undefined,
            },
          });
          return { status: "started" as const };
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
                  thread: snapshot.threads.find((thread) => thread.id === review.threadId),
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
      yield* maybeContinuePlanningWorkflowLifecycle(
        retriedWorkflow,
        latestSnapshot,
        updatedAt,
        handledRevisionThreads,
      );
      yield* maybeContinueImplementationLifecycle(retriedWorkflow, latestSnapshot, updatedAt);

      return { status: "started" as const };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error(error === null ? "Workflow retry failed." : String(error)),
      ),
      (effect) => withWorkflowRetryGate(input.workflowId, effect),
    );

  const skipDocumentReaderPass: WorkflowServiceShape["skipDocumentReaderPass"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const workflow = snapshot.planningWorkflows.find(
        (entry) => entry.id === input.workflowId && !entry.deletedAt,
      );
      if (!workflow || !isDocumentWorkflow(workflow) || workflow.readerPass?.status !== "error")
        return yield* Effect.fail(new Error("Only a failed document reader pass can be skipped."));
      for (const threadId of [workflow.readerPass.readerThreadId, workflow.merge.threadId]) {
        if (!threadId) continue;
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        if (hasActiveRunningTurn(thread))
          return yield* Effect.fail(
            new Error("Wait for the active turn to finish before skipping reader review."),
          );
        const delivery = yield* deliveryForStage(
          threadId,
          workflow.readerPass.readerStartedAt ?? workflow.readerPass.updatedAt,
        );
        if (delivery && ["pending", "sending", "ambiguous"].includes(delivery.state))
          return yield* Effect.fail(
            new Error("Resolve the pending provider delivery before skipping reader review."),
          );
        if (
          delivery?.state === "accepted" &&
          !isSessionUnavailableForReconciliation(thread) &&
          (!thread?.latestTurn ||
            thread.latestTurn.requestedAt < delivery.createdAt ||
            thread.latestTurn.state === "running")
        ) {
          return yield* Effect.fail(
            new Error(
              "Wait for the accepted provider turn to finish before skipping reader review.",
            ),
          );
        }
      }
      yield* upsertWorkflow(markReaderPassSkipped(workflow, new Date().toISOString()));
      return { status: "completed" as const };
    });

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

  yield* registerShutdown("planning-workflows-titles", "drain", () => titleGenerationWorker.drain, [
    "provider-ingestion",
  ]);

  yield* Effect.addFinalizer(() => sources.stop);

  return {
    start,
    drain: titleGenerationWorker.drain,
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    skipDocumentReaderPass,
    startImplementation,
    workflowForThread,
  } satisfies WorkflowServiceShape;
});

function createWorkflowThread({
  orchestrationEngine,
  input,
  threadId,
  suffix,
  lane,
  now,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  input: CreateWorkflowInput;
  threadId: ThreadId;
  suffix: string;
  lane: "a" | "b";
  now: string;
}) {
  const slot = lane === "a" ? input.branchA : input.branchB;
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId,
    projectId: input.projectId,
    title: suffix,
    model: slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    // The lane is not a Git branch; authors work in the project checkout.
    branch: null,
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
  const prompt = (isDocumentWorkflow(workflow) ? buildDocumentAuthorPrompt : buildAuthorPrompt)({
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
  return dispatchWorkflowTurn(
    orchestrationEngine,
    "planning",
    workflow.id,
    `author-${branch.branchId}`,
    {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
    },
  );
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
    commandId: stableWorkflowCommandId("create-plan-review-thread", workflow.id, threadId),
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
  attempt = 0,
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
  attempt?: number;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const documentType = planningWorkflowDocumentType(workflow);
  const prompt = structuredReviewPrompt(
    (documentType ? buildDocumentReviewPrompt : buildReviewPrompt)({
      documentType: documentType ?? "custom",
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
    }),
  );
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [planMarkdown],
    targetSlot: reviewerSlot,
    artifactLabel: "Plan under review",
  });
  if (promptError) return Effect.fail(promptError);
  const attemptKey = retry?.kind === "retry" ? `retry:${attempt}:${createdAt}` : "initial";
  return dispatchWorkflowTurn(
    orchestrationEngine,
    "planning",
    workflow.id,
    `${reviewKind}-review-${reviewedBranchId}`,
    {
      type: "thread.turn.start",
      commandId: stableWorkflowCommandId(
        "start-plan-review",
        workflow.id,
        reviewThreadId,
        attemptKey,
      ),
      threadId: reviewThreadId,
      message: {
        messageId: MessageId.makeUnsafe(
          stableWorkflowUuid("plan-review-message", workflow.id, reviewThreadId, attemptKey),
        ),
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
    },
    {
      label: `${documentType ? "Draft" : "Plan"} ${reviewedBranchId.toUpperCase()}`,
      threadId: (reviewedBranchId === "a" ? workflow.branchA : workflow.branchB).authorThreadId,
      ...(planTurnId ? { turnId: planTurnId } : {}),
    },
  );
}

function prepareRevisionTurn({
  workflow,
  branch,
  originalPlanMarkdown,
  reviews,
  thread,
  createdAt,
  retry,
  originalPlanCreatedAt,
}: {
  workflow: PlanningWorkflow;
  branch: PlanningWorkflow["branchA"];
  originalPlanMarkdown: string;
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
    readonly source: Parameters<typeof buildRevisionPrompt>[0]["reviews"][number]["source"];
  }>;
  thread?:
    | (WorkflowFitThread & {
        readonly compaction?: { readonly createdAt: string } | null;
      })
    | undefined;
  createdAt: string;
  retry?: WorkflowRetryContext;
  /** When the reviewed plan was produced; a retry resends it only after a later compaction. */
  originalPlanCreatedAt?: string | undefined;
}): { readonly command: ThreadTurnStartCommand } | { readonly rejection: string } {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return { rejection: budgetError.detail };
  // Only a manual retry passes the pinned plan's time, and the plan travels again
  // only when the author thread was compacted past it, format retries included.
  // Automatic format repair runs in a thread that still holds the plan.
  const includeOriginalPlan =
    retry?.kind === "retry" &&
    originalPlanCreatedAt !== undefined &&
    !!thread?.compaction &&
    thread.compaction.createdAt > originalPlanCreatedAt;
  const documentType = planningWorkflowDocumentType(workflow);
  const prompt = (documentType ? buildDocumentRevisionPrompt : buildRevisionPrompt)({
    documentType: documentType ?? "custom",
    requirementPrompt: workflow.requirementPrompt,
    originalPlan: {
      markdown: originalPlanMarkdown,
      source: {
        workflowId: workflow.id,
        stage: `author-${branch.branchId}`,
        ...(branch.planTurnId ? { turnId: branch.planTurnId } : {}),
      },
    },
    reviews,
    targetSlot: branch.authorSlot,
    retry,
    includeOriginalPlan,
  });
  if (includeOriginalPlan && prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT) {
    // Compacting again can't shrink this: the plan itself has to travel in the message.
    return {
      rejection: `The reviewed ${documentType ? "draft" : "plan"} and its reviews (${prompt.length.toLocaleString("en-US")} characters) no longer fit in one message now that the Branch ${branch.branchId.toUpperCase()} author conversation was compacted. Revise it manually in that thread, or restart the workflow with shorter reviews.`,
    };
  }
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [originalPlanMarkdown, ...reviews.map((review) => review.reviewMarkdown)],
    targetSlot: branch.authorSlot,
    artifactLabel: "Revision inputs",
    artifactBudgetRecovery: `Compact the Branch ${branch.branchId.toUpperCase()} author conversation, then retry.`,
    ...(thread ? { thread } : {}),
  });
  if (promptError) return { rejection: promptError.detail };
  const attemptKey =
    retry?.kind === "retry"
      ? `retry:${branch.retryCount}:${branch.revisionFormatRepairAttempts ?? 0}:${createdAt}`
      : "initial";
  const command: ThreadTurnStartCommand = {
    type: "thread.turn.start",
    commandId: stableWorkflowCommandId(
      "start-plan-revision",
      workflow.id,
      branch.branchId,
      branch.planTurnId,
      attemptKey,
    ),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(
        stableWorkflowUuid(
          "plan-revision-message",
          workflow.id,
          branch.branchId,
          branch.planTurnId,
          attemptKey,
        ),
      ),
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
  };
  return { command };
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
  const prompt = (isDocumentWorkflow(workflow) ? buildDocumentMergePrompt : buildMergePrompt)({
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
  const attemptKey =
    retry?.kind === "retry"
      ? `retry:${workflow.merge.formatRepairAttempts ?? 0}:${createdAt}`
      : "initial";
  return dispatchWorkflowTurn(orchestrationEngine, "planning", workflow.id, "merge", {
    type: "thread.turn.start",
    commandId: stableWorkflowCommandId("start-plan-merge", workflow.id, threadId, attemptKey),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(
        stableWorkflowUuid("plan-merge-message", workflow.id, threadId, attemptKey),
      ),
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
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
          "The implementation delta is in the current workspace. Inspect it with read-only Git commands, including committed, staged, unstaged, and untracked changes. If the workspace contains nested Git repositories, inspect every repository affected by the implementation.",
        source: {
          workflowId: workflow.id,
          stage: "implementation",
          ...(workflow.implementation?.implementationTurnId
            ? { turnId: workflow.implementation.implementationTurnId }
            : {}),
        },
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
  preparedPrompt,
  thread,
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
  preparedPrompt?: PreparedImplementationReviewPrompt | undefined;
  thread?: WorkflowFitThread | undefined;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prepared =
    preparedPrompt === undefined
      ? prepareCodeReviewPrompt({
          mergedPlanMarkdown,
          requirementPrompt: workflow.requirementPrompt,
          reviewArtifact,
          reviewerLabel,
          lensBranch,
          reviewerSlot,
          retry,
          thread,
          enforceArtifactBudget: resolveWorkflowBehavior({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
          }).loudAuthoritativeArtifactLimit,
          structuredFindings: true,
        })
      : preparedPrompt;
  if (!("prompt" in prepared)) return Effect.fail(prepared);
  return dispatchWorkflowTurn(
    orchestrationEngine,
    "planning",
    workflow.id,
    `implementation-review-${lensBranch}`,
    {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(timeOrderedUuid()),
      threadId: reviewThreadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: prepared.prompt,
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
    },
    {
      label: "Implementation patch",
      ...(workflow.implementation?.threadId ? { threadId: workflow.implementation.threadId } : {}),
      ...(reviewArtifact.source.turnId ? { turnId: reviewArtifact.source.turnId } : {}),
      ...(reviewArtifact.fullPatchHash ? { patchHash: reviewArtifact.fullPatchHash } : {}),
      ...(prepared.truncated
        ? {
            truncated: true,
            anchors: Array.from(
              prepared.artifacts[2].matchAll(/^\+\+\+ b\/(.+)$/gm),
              (match) => match[1]!,
            ),
          }
        : {}),
    },
  );
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
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
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
