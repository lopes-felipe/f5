import { timeOrderedUuid } from "@t3tools/shared/ids";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import { userFacingCauseMessage } from "../../causeMessage.ts";
import { makeWorkflowArchiveLifecycle } from "../workflowArchiveLifecycle.ts";
import {
  CodeReviewWorkflowId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationReadModel,
  ThreadId,
  type CodeReviewReviewer,
  type CodeReviewWorkflow,
  type OrchestrationEvent,
  WORKFLOW_REVIEW_MAX_PARTICIPANTS,
  type WorkflowParticipantId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Scope, Semaphore, Stream } from "effect";
import {
  codeReviewPromptUrls,
  codeReviewPullRequestFromRef,
  detectCodeReviewPullRequestShorthand,
  githubPullRequestFromRemote,
  isGitHubCodeReviewPullRequest,
} from "@t3tools/shared/codeReviewPullRequest";
import { parseSourceControlPullRequestUrl } from "@t3tools/shared/sourceControl";
import { GitCore } from "../../git/Services/GitCore.ts";
import { PrHubFederation } from "../../prHub/Layers/PrHubFederation.ts";
import {
  codeReviewMergedReviewText,
  codeReviewPostBody,
  type CodeReviewPostJob,
  type CodeReviewPostOutcome,
  manualCodeReviewPostBlocker,
  newCodeReviewPostOperationId,
  runCodeReviewPostJob,
  shouldAutoPostCodeReview,
  startedCodeReviewPost,
  withCodeReviewPost,
} from "../codeReviewPost.ts";
import { makeOperationGate } from "../../provider/operationGate.ts";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  buildBudgetedCodeReviewConsolidationPrompt,
  buildCodeReviewConsolidationPrompt,
  buildCodeReviewReviewerPrompt,
} from "../codeReviewWorkflowPrompts.ts";
import {
  codeReviewReviewers,
  requireCodeReviewReviewer,
  updateCodeReviewReviewer,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  CodeReviewWorkflowService,
  type CodeReviewWorkflowServiceShape,
} from "../Services/CodeReviewWorkflowService.ts";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import {
  completedTurnEvidenceAt,
  getFinishedConsumableLatestTurn,
  hasActiveRunningTurn,
  hasPriorThreadWork,
  isLatestTurnFinishedAndConsumable,
  latestAssistantFeedback,
  nextWorkflowSlug,
  reviewFeedbackForPinnedTurn,
  workflowArtifactFit,
  WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS,
  WORKFLOW_MAX_ACTIVE_REVIEW_TURNS,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "../workflowSharedUtils.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryOutcome,
} from "../Services/ProviderTurnDeliveryWorker.ts";
import {
  ProviderTurnDeliveryRepository,
  type ProviderTurnDelivery,
} from "../Services/ProviderTurnDeliveryRepository.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { applyWorkflowTurnCost, workflowBudgetError } from "../workflowBudget.ts";
import {
  resolveAvailableWorkflowModelSlot,
  workflowTurnProviderFields,
  withWorkflowModelSelectionGuard,
} from "../workflowModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  assertWorkflowStageProviderSupported,
  LATEST_WORKFLOW_TEMPLATE_VERSION,
  resolveWorkflowBehavior,
  type UnsupportedWorkflowProviderError,
  UnsupportedWorkflowTemplateError,
  workflowTurnBehaviorFields,
} from "../workflowBehavior.ts";
import {
  buildCodeReviewWorkflowRecord,
  codeReviewCommandReviewerFields,
  codeReviewInputReviewerFields,
  codeReviewInputReviewerSlots,
} from "../workflowRecordBuilders.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";
import {
  makeWorkflowStageDispatchResolver,
  STARTUP_DISPATCH_RECHECK_TIMEOUT,
  stageDispatchAllowsTurn,
  type WorkflowStageDispatchTurn,
} from "../workflowStageDispatch.ts";

type CodeReviewWorkflowTitleGenerationWorkItem = {
  readonly workflowId: CodeReviewWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

const MAX_PROFILE_TIMEOUT_RETRIES = 1;

type CodeReviewStage = {
  readonly status: CodeReviewReviewer["status"] | CodeReviewWorkflow["consolidation"]["status"];
  readonly pinnedTurnId: string | null;
  readonly pinnedAssistantMessageId: string | null;
  readonly dispatchCommandId?: CommandId | null | undefined;
  readonly updatedAt: string;
};

// A running stage only completes with the turn its own dispatch started, so a
// stale or user-started turn on a reused thread cannot stand in for it. Error
// and unpinned-completed stages keep the original recovery rules.
function canConsumeCompletedStageTurn(
  stage: CodeReviewStage,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
  dispatch: WorkflowStageDispatchTurn,
): boolean {
  const completionEvidenceAt = completedTurnEvidenceAt(thread);
  const completedTurn = getFinishedConsumableLatestTurn(thread);
  if (!completionEvidenceAt || !completedTurn) {
    return false;
  }
  return (
    (stage.status === "running" && stageDispatchAllowsTurn(dispatch, completedTurn.turnId)) ||
    (stage.status === "error" && completionEvidenceAt >= stage.updatedAt) ||
    (stage.status === "completed" &&
      (stage.pinnedTurnId === null || stage.pinnedAssistantMessageId === null))
  );
}

function hasNewerActiveStageTurn(
  stageUpdatedAt: string,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
): boolean {
  return (
    hasActiveRunningTurn(thread) &&
    thread?.latestTurn !== null &&
    thread?.latestTurn !== undefined &&
    thread.latestTurn.requestedAt >= stageUpdatedAt
  );
}

function acceptedDeliveryMatchesCurrentTurn(
  delivery: ProviderTurnDelivery,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
): boolean {
  if (delivery.state !== "accepted" || delivery.providerTurnId === null) {
    return false;
  }
  const latestTurn = thread?.latestTurn ?? null;
  if (!latestTurn) {
    return true;
  }
  if (latestTurn.turnId === delivery.providerTurnId) {
    return latestTurn.state === "running";
  }
  return delivery.preSendTurnIds.some((turnId) => turnId === latestTurn.turnId);
}

function updateReviewer(
  workflow: CodeReviewWorkflow,
  reviewerId: WorkflowParticipantId,
  reviewer: CodeReviewReviewer,
  updatedAt: string,
): CodeReviewWorkflow {
  return {
    ...updateCodeReviewReviewer(workflow, reviewerId, () => reviewer),
    updatedAt,
  };
}

function allReviewersCompleted(workflow: CodeReviewWorkflow): boolean {
  return codeReviewReviewers(workflow).every(({ reviewer }) => reviewer.status === "completed");
}

function readCodeReviewWorkflow(
  orchestrationEngine: OrchestrationEngineShape,
  workflowId: CodeReviewWorkflowId,
) {
  return orchestrationEngine
    .getReadModel()
    .pipe(
      Effect.map(
        (snapshot) =>
          snapshot.codeReviewWorkflows.find(
            (workflow) => workflow.id === workflowId && workflow.deletedAt === null,
          ) ?? null,
      ),
    );
}

function shouldRetryConsolidationAfterReviewerUpdate(workflow: CodeReviewWorkflow): boolean {
  return (
    workflow.consolidation.threadId === null &&
    workflow.consolidation.status === "error" &&
    workflow.consolidation.error === "Reviewer output not found for consolidation."
  );
}

function resetConsolidationAfterReviewerUpdate(
  workflow: CodeReviewWorkflow,
  updatedAt: string,
): CodeReviewWorkflow {
  return shouldRetryConsolidationAfterReviewerUpdate(workflow)
    ? {
        ...workflow,
        consolidation: {
          ...workflow.consolidation,
          status: "not_started",
          error: null,
          updatedAt,
        },
        updatedAt,
      }
    : workflow;
}

function reviewerMatch(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): { reviewerId: WorkflowParticipantId; reviewer: CodeReviewReviewer } | null {
  const match = codeReviewReviewers(workflow).find(
    ({ reviewer }) => reviewer.threadId === threadId,
  );
  return match ? { reviewerId: match.id, reviewer: match.reviewer } : null;
}

function labelForThread(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): { workflow: CodeReviewWorkflow; label: string } | null {
  const reviewer = reviewerMatch(workflow, threadId);
  if (reviewer) {
    return { workflow, label: `Reviewer ${workflowParticipantLabel(reviewer.reviewerId)}` };
  }
  if (workflow.consolidation.threadId === threadId) {
    return { workflow, label: "Merge" };
  }
  return null;
}

function withReviewerRunning(
  workflow: CodeReviewWorkflow,
  updatedAt: string,
  dispatchCommandIds: ReadonlyMap<ThreadId, CommandId>,
): CodeReviewWorkflow {
  let next = workflow;
  for (const { id, reviewer } of codeReviewReviewers(workflow)) {
    const dispatchCommandId = dispatchCommandIds.get(reviewer.threadId);
    if (reviewer.status !== "pending" || dispatchCommandId === undefined) continue;
    next = updateCodeReviewReviewer(next, id, (current) => ({
      ...current,
      status: "running",
      error: null,
      dispatchCommandId,
      updatedAt,
    }));
  }
  return { ...next, updatedAt };
}

function withReviewerRetryRunning(
  workflow: CodeReviewWorkflow,
  reviewerId: WorkflowParticipantId,
  updatedAt: string,
  dispatchCommandId: CommandId | null,
): CodeReviewWorkflow {
  const reviewer = requireCodeReviewReviewer(workflow, reviewerId);
  return updateReviewer(
    workflow,
    reviewerId,
    {
      ...reviewer,
      status: "running",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      dispatchCommandId,
      updatedAt,
    },
    updatedAt,
  );
}

function withCompletedReviewer(input: {
  workflow: CodeReviewWorkflow;
  reviewerId: WorkflowParticipantId;
  turnId: string | null;
  assistantMessageId: string | null;
  updatedAt: string;
}): CodeReviewWorkflow {
  const current = requireCodeReviewReviewer(input.workflow, input.reviewerId);
  if (
    current.status === "completed" &&
    current.pinnedTurnId === input.turnId &&
    current.pinnedAssistantMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return updateReviewer(
    input.workflow,
    input.reviewerId,
    {
      ...current,
      status: "completed",
      pinnedTurnId: input.turnId,
      pinnedAssistantMessageId: input.assistantMessageId,
      error: null,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withReviewerError(input: {
  workflow: CodeReviewWorkflow;
  reviewerId: WorkflowParticipantId;
  error: string;
  updatedAt: string;
}): CodeReviewWorkflow {
  const current = requireCodeReviewReviewer(input.workflow, input.reviewerId);
  return updateReviewer(
    input.workflow,
    input.reviewerId,
    {
      ...current,
      status: "error",
      error: input.error,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withConsolidationPendingStart(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
  updatedAt: string,
): CodeReviewWorkflow {
  if (
    workflow.consolidation.status === "pending_start" &&
    workflow.consolidation.threadId === threadId
  ) {
    return workflow;
  }
  return {
    ...workflow,
    consolidation: {
      ...workflow.consolidation,
      threadId,
      status: "pending_start",
      error: null,
      updatedAt,
    },
    updatedAt,
  };
}

function withConsolidationRunning(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
  updatedAt: string,
  dispatchCommandId: CommandId | null,
): CodeReviewWorkflow {
  return {
    ...workflow,
    consolidation: {
      ...workflow.consolidation,
      threadId,
      status: "running",
      error: null,
      dispatchCommandId,
      updatedAt,
    },
    updatedAt,
  };
}

function withConsolidationCompleted(input: {
  workflow: CodeReviewWorkflow;
  turnId: string | null;
  assistantMessageId: string | null;
  updatedAt: string;
}): CodeReviewWorkflow {
  const current = input.workflow.consolidation;
  if (
    current.status === "completed" &&
    current.pinnedTurnId === input.turnId &&
    current.pinnedAssistantMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return {
    ...input.workflow,
    consolidation: {
      ...current,
      status: "completed",
      pinnedTurnId: input.turnId,
      pinnedAssistantMessageId: input.assistantMessageId,
      error: null,
      updatedAt: input.updatedAt,
    },
    updatedAt: input.updatedAt,
  };
}

function withConsolidationError(
  workflow: CodeReviewWorkflow,
  error: string,
  updatedAt: string,
): CodeReviewWorkflow {
  return {
    ...workflow,
    consolidation: {
      ...workflow.consolidation,
      status: "error",
      error,
      updatedAt,
    },
    updatedAt,
  };
}

function upsertWorkflow(
  orchestrationEngine: OrchestrationEngineShape,
  workflow: CodeReviewWorkflow,
  updatedAt: string,
) {
  return orchestrationEngine.dispatch({
    type: "project.code-review-workflow.upsert",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    projectId: workflow.projectId,
    workflow,
    updatedAt,
  });
}

function dispatchWorkflowDeleteCompensation(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflowId: CodeReviewWorkflowId;
  projectId: CodeReviewWorkflow["projectId"];
  createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "project.code-review-workflow.delete",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    workflowId: input.workflowId,
    projectId: input.projectId,
    createdAt: input.createdAt,
  });
}

function createReviewerThread(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: CodeReviewWorkflow;
  threadId: ThreadId;
  reviewer: CodeReviewReviewer;
  title: string;
  createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: input.title,
    model: input.reviewer.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
    createdAt: input.createdAt,
  });
}

function startReviewerTurn(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: CodeReviewWorkflow;
  reviewer: CodeReviewReviewer;
  commandId: CommandId;
  createdAt: string;
  retry: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildCodeReviewReviewerPrompt({
    workflowId: input.workflow.id,
    reviewPrompt: input.workflow.reviewPrompt,
    reviewerLabel: input.reviewer.label,
    lensBranch:
      codeReviewReviewers(input.workflow).findIndex(
        ({ reviewer }) => reviewer.threadId === input.reviewer.threadId,
      ) %
        2 ===
      1
        ? "b"
        : "a",
    branch: input.workflow.branch,
    reviewerSlot: input.reviewer.slot,
    pullRequest: input.workflow.pullRequest,
    retry: input.retry,
  });
  if (prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail: `Reviewer prompt is ${prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`,
      }),
    );
  }
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.reviewer.threadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.reviewer.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "codeReview",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "standalone-review",
    }),
    createdAt: input.createdAt,
  });
}

function createConsolidationThread(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: CodeReviewWorkflow;
  threadId: ThreadId;
  createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: "Review Merge",
    model: input.workflow.consolidation.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
    createdAt: input.createdAt,
  });
}

/**
 * The consolidation prompt, or why it can't be sent. Checked before the merge is saved as
 * running, so a merge that can never fit fails visibly instead of sitting `running`.
 */
function prepareConsolidationPrompt(input: {
  workflow: CodeReviewWorkflow;
  reviews: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  retry: WorkflowRetryContext;
}): { readonly prompt: string } | { readonly error: Error } {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return { error: budgetError };
  const promptInput = {
    workflowId: input.workflow.id,
    reviewPrompt: input.workflow.reviewPrompt,
    reviews: input.reviews,
    consolidationSlot: input.workflow.consolidation.slot,
    pullRequest: input.workflow.pullRequest,
    retry: input.retry,
  };
  let prompt: string;
  let artifacts: ReadonlyArray<string> = input.reviews.map((review) => review.text);
  if (workflowUsesMesh(input.reviews.length)) {
    // Runs with more than two reviewers share the prompt among the reports: a retry cannot
    // shrink six paid reports, so they are excerpted instead of failing on size.
    const budgeted = buildBudgetedCodeReviewConsolidationPrompt({
      ...promptInput,
      maxRenderedChars: WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
    });
    if (
      budgeted.smallestExcerpt !== null &&
      budgeted.smallestExcerpt < WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS
    ) {
      return {
        error: new OrchestrationCommandInvariantError({
          commandType: "workflow.turn.start",
          detail: `${input.reviews.length} reviewers leave ${budgeted.smallestExcerpt} characters per report; start a new code review with fewer reviewers.`,
        }),
      };
    }
    prompt = budgeted.prompt;
    artifacts = budgeted.reviewTexts;
  } else {
    prompt = buildCodeReviewConsolidationPrompt(promptInput);
  }
  const behavior = resolveWorkflowBehavior({
    runKind: "codeReview",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
  const fit = workflowArtifactFit({
    artifacts,
    targetSlot: input.workflow.consolidation.slot,
  });
  if (
    prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT ||
    (behavior.loudAuthoritativeArtifactLimit && !fit.fits)
  ) {
    return {
      error: new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail:
          prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT
            ? `Consolidation prompt is ${prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`
            : `Consolidation reviews require an estimated ${fit.estimatedTokens} tokens; only ${fit.availableTokens} are available.`,
      }),
    };
  }
  return { prompt };
}

/** Sends the consolidation prompt that `prepareConsolidationPrompt` already checked. */
function startConsolidationTurn(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: CodeReviewWorkflow;
  prompt: string;
  commandId: CommandId;
  createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.workflow.consolidation.threadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.workflow.consolidation.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "codeReview",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "consolidation",
    }),
    createdAt: input.createdAt,
  });
}

export const makeCodeReviewWorkflowService = Effect.gen(function* () {
  const sources = yield* makeShutdownSourceScope("code-review-workflows-sources");
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);
  const providerTurnDeliveryRepository = yield* Effect.serviceOption(
    ProviderTurnDeliveryRepository,
  );
  const prHubFederation = Option.getOrNull(yield* Effect.serviceOption(PrHubFederation));
  const gitCore = Option.getOrNull(yield* Effect.serviceOption(GitCore));
  // Serializes workflow read-modify-write between the event fiber and the post
  // worker, so a post result never overwrites a stage transition or vice versa.
  const workflowWriteLock = yield* Semaphore.make(1);
  const withWorkflowWriteLock = workflowWriteLock.withPermits(1);
  /**
   * How each manually retried reviewer that was queued for a free slot starts when admitted:
   * a new turn on its thread, or a resend of its failed delivery (with the user's duplicate-risk
   * confirmation). In memory only; after a restart a queued reviewer whose saved delivery is
   * still rejected or ambiguous is resent without that confirmation (`persistedDeliveryRetry`),
   * and any other starts a new turn. Reviewer prompts don't render the earlier failure.
   */
  const queuedReviewerRetries = new Map<
    ThreadId,
    | { readonly kind: "turn"; readonly retry: WorkflowRetryContext }
    | {
        readonly kind: "delivery";
        readonly deliveryId: CommandId | undefined;
        readonly allowPossibleDuplicate: boolean;
      }
  >();
  const resolveStageDispatch = yield* makeWorkflowStageDispatchResolver;
  // Only running stages are gated on their dispatch; skip the lookup otherwise.
  const resolveRunningStageDispatch = (stage: CodeReviewStage) =>
    resolveStageDispatch(stage.status === "running" ? stage.dispatchCommandId : null);
  const getWorkflowProviders =
    providerRegistry._tag === "Some" ? providerRegistry.value.getProviders : Effect.succeed([]);
  const orchestrationEngine = withWorkflowModelSelectionGuard(
    baseOrchestrationEngine,
    getWorkflowProviders,
  );

  const runningStageReconciliationError = (
    threadId: ThreadId,
    thread: OrchestrationReadModel["threads"][number] | null | undefined,
    label: string,
    dispatchCommandId: CommandId | null | undefined,
  ) =>
    Effect.gen(function* () {
      if (!thread) {
        return `${label} thread was unavailable during reconciliation.`;
      }
      if (hasActiveRunningTurn(thread)) {
        return null;
      }
      if (thread.session?.status === "error" || thread.session?.status === "stopped") {
        return (
          thread.session.lastError ?? `${label} session was not running during reconciliation.`
        );
      }
      if (providerTurnDeliveryWorker._tag === "None") {
        return null;
      }

      // A stage with a recorded dispatch is judged by its own delivery only.
      const deliveryExit = yield* Effect.exit(
        providerTurnDeliveryWorker.value.recheck(threadId, dispatchCommandId ?? undefined),
      );
      if (deliveryExit._tag === "Failure") {
        yield* Effect.logWarning("Code-review startup delivery reconciliation failed", {
          threadId,
          cause: Cause.pretty(deliveryExit.cause),
        });
        return `Could not verify ${label.toLowerCase()} provider delivery during reconciliation.`;
      }

      const delivery = deliveryExit.value;
      if (
        delivery?.state === "pending" ||
        delivery?.state === "sending" ||
        (delivery?.state === "accepted" && acceptedDeliveryMatchesCurrentTurn(delivery, thread))
      ) {
        return null;
      }
      return (
        delivery?.errorDetail ?? `${label} had no active or recoverable turn during reconciliation.`
      );
    });

  const titleGenerationWorker = yield* makeBackgroundWorker(
    (item: CodeReviewWorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const workflow =
          snapshot.codeReviewWorkflows.find(
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
          logPrefix: "code review workflow service",
          logContext: {
            workflowId: item.workflowId,
          },
        });
        if (title === workflow.title) {
          return;
        }

        // Under the write lock so this whole-record upsert cannot revert a
        // concurrent stage or post transition.
        yield* withWorkflowWriteLock(
          Effect.gen(function* () {
            const latestSnapshot = yield* orchestrationEngine.getReadModel();
            const latestWorkflow =
              latestSnapshot.codeReviewWorkflows.find(
                (entry) => entry.id === item.workflowId && !isDeletedWorkflow(entry),
              ) ?? null;
            if (!latestWorkflow || latestWorkflow.title !== item.expectedCurrentTitle) {
              return;
            }

            const updatedAt = new Date().toISOString();
            yield* upsertWorkflow(
              orchestrationEngine,
              {
                ...latestWorkflow,
                title,
                updatedAt,
              },
              updatedAt,
            );
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("CodeReviewWorkflowService.titleGenerationWorker failed", {
            workflowId: item.workflowId,
            cause,
          }),
        ),
      ),
    { name: "CodeReviewWorkflowService", key: (item) => String(item.workflowId) },
  );

  const applyPostOutcome = (job: CodeReviewPostJob, outcome: CodeReviewPostOutcome) =>
    withWorkflowWriteLock(
      Effect.gen(function* () {
        const latest = yield* readCodeReviewWorkflow(orchestrationEngine, job.workflowId);
        const post = latest?.post;
        if (
          !latest ||
          isDeletedWorkflow(latest) ||
          !post ||
          post.operationId !== job.operationId ||
          post.status !== "posting"
        ) {
          return;
        }
        const updatedAt = new Date().toISOString();
        yield* upsertWorkflow(
          orchestrationEngine,
          withCodeReviewPost(
            latest,
            {
              ...post,
              status: outcome.status,
              commentUrl: outcome.commentUrl,
              error: outcome.error,
              operationId: outcome.operationId ?? post.operationId,
              updatedAt,
            },
            updatedAt,
          ),
          updatedAt,
        );
      }),
    );

  // GitHub I/O stays off the event fiber; results come back through the lock.
  const postWorker = yield* makeBackgroundWorker(
    (job: CodeReviewPostJob) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const workflow = snapshot.codeReviewWorkflows.find((entry) => entry.id === job.workflowId);
        if (
          !workflow ||
          isDeletedWorkflow(workflow) ||
          workflow.post?.operationId !== job.operationId ||
          workflow.post.status !== "posting"
        ) {
          return;
        }
        const mergedReview = job.checkOnly ? null : codeReviewMergedReviewText(workflow, snapshot);
        const outcome = yield* runCodeReviewPostJob({
          federation: prHubFederation,
          workflow,
          job,
          body: mergedReview === null ? null : codeReviewPostBody(workflow, mergedReview),
        });
        yield* applyPostOutcome(job, outcome);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("CodeReviewWorkflowService.postWorker failed", {
            workflowId: job.workflowId,
            cause,
          }),
        ),
      ),
    { name: "CodeReviewWorkflowService.post", key: (job) => String(job.workflowId) },
  );

  /**
   * Record the post as in flight, then hand the GitHub work to the post worker.
   * An unknown earlier outcome is only re-verified unless the caller accepts a
   * possible duplicate. Callers must hold the workflow write lock.
   */
  const beginPost = (
    workflow: CodeReviewWorkflow,
    trigger: "auto" | "manual",
    updatedAt: string,
    options: { readonly allowPossibleDuplicate?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const previous = workflow.post;
      const abandonSuperseded =
        previous?.status === "needs_recovery" && options.allowPossibleDuplicate === true;
      const checkOnly = previous?.status === "needs_recovery" && !abandonSuperseded;
      const operationId = checkOnly
        ? previous.operationId
        : newCodeReviewPostOperationId(workflow.id);
      const post = checkOnly
        ? { ...previous, status: "posting" as const, updatedAt }
        : startedCodeReviewPost({ workflow, trigger, operationId, updatedAt });
      const nextWorkflow = withCodeReviewPost(workflow, post, updatedAt);
      yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      yield* postWorker.enqueue({
        workflowId: workflow.id,
        operationId,
        checkOnly,
        resumed: false,
        supersededOperationId: checkOnly ? null : (previous?.operationId ?? null),
        // A failed attempt for this same merge may still have reached GitHub
        // (for example a send that was resumed, or submitted from PR Hub).
        adoptSuperseded:
          !checkOnly &&
          !abandonSuperseded &&
          previous?.status === "failed" &&
          previous.consolidationTurnId === workflow.consolidation.pinnedTurnId,
        abandonSuperseded,
      });
      return nextWorkflow;
    });

  const maybeStartConsolidation = (
    workflow: CodeReviewWorkflow,
    snapshotAtCall: OrchestrationReadModel | null,
    updatedAt: string,
    retry?: WorkflowRetryContext,
    resumePendingStart = false,
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        isArchivedWorkflow(workflow) ||
        !allReviewersCompleted(workflow) ||
        (workflow.consolidation.status === "pending_start" && !resumePendingStart) ||
        workflow.consolidation.status === "running" ||
        workflow.consolidation.status === "completed"
      ) {
        return;
      }

      const consolidationThreadId =
        workflow.consolidation.threadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
      const pendingWorkflow = withConsolidationPendingStart(
        workflow,
        consolidationThreadId,
        updatedAt,
      );
      if (pendingWorkflow !== workflow) {
        yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
      }

      const snapshot = snapshotAtCall ?? (yield* orchestrationEngine.getReadModel());
      const reviewerInputs = codeReviewReviewers(pendingWorkflow).map(({ reviewer }) => {
        const thread = snapshot.threads.find((entry) => entry.id === reviewer.threadId);
        // A reviewer that submitted its report as a plan (for example via
        // ExitPlanMode) often ends with only a short summary message, so a
        // longer plan captured for the pinned turn wins over that message.
        // The latestAssistantFeedback fallback only applies to stages with
        // no pinned message id and no assistant message on the pinned turn
        // (legacy or recovered stages). It keeps the previous behavior of
        // using the thread's latest assistant message from any turn.
        const text = thread
          ? ((
              reviewFeedbackForPinnedTurn(
                thread,
                reviewer.pinnedTurnId,
                reviewer.pinnedAssistantMessageId,
              ) ?? latestAssistantFeedback(thread, reviewer.pinnedAssistantMessageId)
            )?.text ?? null)
          : null;
        return {
          label: reviewer.label,
          text,
          ...(reviewer.pinnedTurnId ? { turnId: reviewer.pinnedTurnId } : {}),
          ...(reviewer.pinnedAssistantMessageId
            ? { messageId: reviewer.pinnedAssistantMessageId }
            : {}),
        };
      });

      // An error before the merge thread exists drops the thread id this pass reserved, so a
      // retry takes the no-thread path instead of recovering a thread that was never created.
      const consolidationThreadExists = snapshot.threads.some(
        (thread) => thread.id === consolidationThreadId,
      );
      const errorBeforeThread = (message: string) =>
        withConsolidationError(
          consolidationThreadExists
            ? pendingWorkflow
            : {
                ...pendingWorkflow,
                consolidation: { ...pendingWorkflow.consolidation, threadId: null },
              },
          message,
          updatedAt,
        );
      if (reviewerInputs.some((review) => !review.text || review.text.trim().length === 0)) {
        yield* upsertWorkflow(
          orchestrationEngine,
          errorBeforeThread("Reviewer output not found for consolidation."),
          updatedAt,
        );
        return;
      }

      // Before the merge thread or the running state: a merge that can never be sent records
      // its error directly.
      const prepared = prepareConsolidationPrompt({
        workflow: pendingWorkflow,
        reviews: reviewerInputs.map((review) => ({ label: review.label, text: review.text! })),
        retry: retry ?? { kind: "none" },
      });
      if ("error" in prepared) {
        yield* upsertWorkflow(
          orchestrationEngine,
          errorBeforeThread(prepared.error.message),
          updatedAt,
        );
        return yield* Effect.fail(prepared.error);
      }

      if (!consolidationThreadExists) {
        const createOutcome = yield* Effect.exit(
          createConsolidationThread({
            orchestrationEngine,
            workflow: pendingWorkflow,
            threadId: consolidationThreadId,
            createdAt: updatedAt,
          }),
        );
        if (createOutcome._tag === "Failure") {
          yield* Effect.logError("Code-review consolidation thread creation failed", {
            workflowId: workflow.id,
            cause: Cause.pretty(createOutcome.cause),
          });
          yield* upsertWorkflow(
            orchestrationEngine,
            withConsolidationError(
              pendingWorkflow,
              userFacingCauseMessage(createOutcome.cause, "Could not create the merge thread."),
              updatedAt,
            ),
            updatedAt,
          );
          return yield* Effect.failCause(createOutcome.cause);
        }
      }

      const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
      const runningWorkflow = withConsolidationRunning(
        pendingWorkflow,
        consolidationThreadId,
        updatedAt,
        dispatchCommandId,
      );
      yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
      const consolidationOutcome = yield* Effect.exit(
        startConsolidationTurn({
          orchestrationEngine,
          workflow: runningWorkflow,
          commandId: dispatchCommandId,
          prompt: prepared.prompt,
          createdAt: updatedAt,
        }),
      );
      if (consolidationOutcome._tag === "Failure") {
        yield* Effect.logError("Code-review consolidation turn dispatch failed", {
          workflowId: workflow.id,
          threadId: consolidationThreadId,
          cause: Cause.pretty(consolidationOutcome.cause),
        });
        yield* upsertWorkflow(
          orchestrationEngine,
          withConsolidationError(
            runningWorkflow,
            userFacingCauseMessage(consolidationOutcome.cause, "Could not start the review merge."),
            updatedAt,
          ),
          updatedAt,
        );
        return yield* Effect.failCause(consolidationOutcome.cause);
      }
    });

  /**
   * The resend a queued reviewer still owes after a restart dropped `queuedReviewerRetries`: a
   * pending reviewer keeps the dispatch of its failed delivery, and while that delivery is still
   * rejected or ambiguous it is resent rather than replaced. Duplicate-risk confirmation isn't
   * kept, so an ambiguous one fails the resend and asks the user to confirm again.
   */
  const persistedDeliveryRetry = (reviewer: CodeReviewReviewer) =>
    Effect.gen(function* () {
      if (!reviewer.dispatchCommandId || providerTurnDeliveryWorker._tag === "None") {
        return undefined;
      }
      const delivery = yield* providerTurnDeliveryWorker.value
        .recheck(reviewer.threadId, reviewer.dispatchCommandId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      return delivery?.state === "rejected" || delivery?.state === "ambiguous"
        ? {
            kind: "delivery" as const,
            deliveryId: reviewer.dispatchCommandId,
            allowPossibleDuplicate: false,
          }
        : undefined;
    });

  /**
   * Starts pending reviewers in roster order while fewer than
   * `WORKFLOW_MAX_ACTIVE_REVIEW_TURNS` are running. Called again whenever a reviewer
   * completes or fails, so a large run drains its queue. Callers hold the write lock.
   */
  const startPendingReviewers = (workflow: CodeReviewWorkflow, updatedAt: string) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow) || isArchivedWorkflow(workflow)) return;
      let current = workflow;
      // Each pass fills the free slots; a reviewer that fails to start frees its slot
      // for the next one in line, so passes repeat until no failure is left to backfill.
      while (true) {
        const reviewers = codeReviewReviewers(current);
        const running = reviewers.filter(({ reviewer }) => reviewer.status === "running").length;
        const pendingReviewers = reviewers
          .filter(({ reviewer }) => reviewer.status === "pending")
          .slice(0, Math.max(0, WORKFLOW_MAX_ACTIVE_REVIEW_TURNS - running));
        if (pendingReviewers.length === 0) {
          return;
        }
        // A completion can reach the cost limit while reviewers wait. Nothing starts past it,
        // neither a fresh turn nor a resend: waiting reviewers fail visibly with the limit, as
        // planning reviews do, and keep their dispatch id for a later retry.
        const budgetError = workflowBudgetError(current);
        if (budgetError) {
          for (const { id: reviewerId, reviewer } of reviewers) {
            if (reviewer.status !== "pending") continue;
            current = withReviewerError({
              workflow: current,
              reviewerId,
              error: budgetError.detail,
              updatedAt,
            });
          }
          yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
          return;
        }
        const snapshot = yield* orchestrationEngine.getReadModel();
        let failures = 0;
        for (const { id: reviewerId, reviewer } of pendingReviewers) {
          const reviewerThread = snapshot.threads.find((thread) => thread.id === reviewer.threadId);
          const queued =
            queuedReviewerRetries.get(reviewer.threadId) ??
            (yield* persistedDeliveryRetry(reviewer));
          if (queued?.kind === "delivery" && providerTurnDeliveryWorker._tag === "Some") {
            const deliveryWorker = providerTurnDeliveryWorker.value;
            // Saved before the resend. A resend reuses the delivery's command id, so the
            // reviewer keeps that identity throughout: a restart before the resend still
            // judges it by that delivery, never by an older turn on the thread.
            current = updateCodeReviewReviewer(current, reviewerId, (entry) => ({
              ...entry,
              status: "running",
              error: null,
              dispatchCommandId: queued.deliveryId ?? null,
              updatedAt,
            }));
            yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
            // Dropped only once the admission is saved, so a failed write keeps the resend.
            queuedReviewerRetries.delete(reviewer.threadId);
            const resent = yield* Effect.exit(
              deliveryWorker.retry({
                threadId: reviewer.threadId,
                allowPossibleDuplicate: queued.allowPossibleDuplicate,
                deliveryId: queued.deliveryId,
              }),
            );
            if (resent._tag === "Success") {
              current = updateCodeReviewReviewer(current, reviewerId, (entry) => ({
                ...entry,
                dispatchCommandId: resent.value.commandId,
              }));
              yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
              continue;
            }
            current = withReviewerError({
              workflow: current,
              reviewerId,
              error: userFacingCauseMessage(resent.cause, "Could not resend the reviewer turn."),
              updatedAt,
            });
            yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
            failures += 1;
            continue;
          }
          const commandId = CommandId.makeUnsafe(timeOrderedUuid());
          // Record the attempt before dispatching it: after a crash in between, startup
          // judges this reviewer by its own delivery instead of dispatching it again.
          current = withReviewerRunning(
            current,
            updatedAt,
            new Map([[reviewer.threadId, commandId]]),
          );
          yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
          queuedReviewerRetries.delete(reviewer.threadId);
          const outcome = yield* Effect.exit(
            startReviewerTurn({
              orchestrationEngine,
              workflow: current,
              reviewer,
              commandId,
              createdAt: updatedAt,
              retry:
                queued?.kind === "turn"
                  ? queued.retry
                  : hasPriorThreadWork(reviewerThread)
                    ? { kind: "retry", reusedThread: true }
                    : { kind: "none" },
            }),
          );
          if (outcome._tag === "Failure") {
            yield* Effect.logError("Code-review reviewer turn dispatch failed", {
              workflowId: current.id,
              threadId: reviewer.threadId,
              cause: Cause.pretty(outcome.cause),
            });
            current = withReviewerError({
              workflow: current,
              reviewerId,
              error: userFacingCauseMessage(outcome.cause, "Could not start the reviewer."),
              updatedAt,
            });
            yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
            failures += 1;
          }
        }
        if (failures === 0) {
          return;
        }
      }
    });

  /**
   * Creation-time admission. Completions and failures admit reviewers under the write lock from
   * the persisted roster, so creation takes the same lock and re-reads the roster: otherwise a
   * fast completion and creation could both admit the same pending reviewer.
   */
  const startPendingReviewersLocked = (workflowId: CodeReviewWorkflowId) =>
    withWorkflowWriteLock(
      Effect.gen(function* () {
        const current = yield* readCodeReviewWorkflow(orchestrationEngine, workflowId);
        if (current) yield* startPendingReviewers(current, new Date().toISOString());
      }),
    );

  /** After a stage completes: start queued reviewers, or consolidate once all are done. */
  const continueAfterStageAdvance = (
    workflow: CodeReviewWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      yield* startPendingReviewers(workflow, updatedAt);
      yield* maybeStartConsolidation(workflow, snapshot, updatedAt);
    });

  const maybeAdvanceWorkflowFromCompletedThread = (
    workflow: CodeReviewWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const completedTurn = getFinishedConsumableLatestTurn(thread);
      if (!completedTurn) {
        return workflow;
      }

      const reviewer = reviewerMatch(workflow, threadId);
      if (
        reviewer &&
        canConsumeCompletedStageTurn(
          reviewer.reviewer,
          thread,
          yield* resolveRunningStageDispatch(reviewer.reviewer),
        )
      ) {
        const nextWorkflow = resetConsolidationAfterReviewerUpdate(
          withCompletedReviewer({
            workflow,
            reviewerId: reviewer.reviewerId,
            turnId: completedTurn.turnId,
            assistantMessageId: completedTurn.assistantMessageId,
            updatedAt,
          }),
          updatedAt,
        );
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
        return nextWorkflow;
      }

      if (
        workflow.consolidation.threadId === threadId &&
        canConsumeCompletedStageTurn(
          workflow.consolidation,
          thread,
          yield* resolveRunningStageDispatch(workflow.consolidation),
        )
      ) {
        const nextWorkflow = withConsolidationCompleted({
          workflow,
          turnId: completedTurn.turnId,
          assistantMessageId: completedTurn.assistantMessageId,
          updatedAt,
        });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
          if (shouldAutoPostCodeReview(nextWorkflow)) {
            return yield* beginPost(nextWorkflow, "auto", updatedAt);
          }
        }
        return nextWorkflow;
      }

      return workflow;
    });

  // A restart can leave a stage's delivery `sending` after its turn finished.
  // Rechecking that delivery against provider history records the acceptance
  // so the completion pass below can attribute the turn to the stage.
  const promoteFinishedStageDispatch = (
    stage: CodeReviewStage,
    thread: OrchestrationReadModel["threads"][number] | undefined,
  ) =>
    Effect.gen(function* () {
      if (
        stage.status !== "running" ||
        !stage.dispatchCommandId ||
        providerTurnDeliveryWorker._tag === "None" ||
        !thread ||
        !getFinishedConsumableLatestTurn(thread)
      ) {
        return;
      }
      // Bounded: this runs before the event subscription starts.
      yield* providerTurnDeliveryWorker.value.recheck(thread.id, stage.dispatchCommandId).pipe(
        Effect.timeout(STARTUP_DISPATCH_RECHECK_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("Code-review stage dispatch recheck failed", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    });

  const ensureReviewerThreads = (workflow: CodeReviewWorkflow, snapshot: OrchestrationReadModel) =>
    Effect.forEach(
      codeReviewReviewers(workflow),
      ({ reviewer }) =>
        reviewer.status !== "pending" ||
        reviewer.dispatchCommandId ||
        snapshot.threads.some((thread) => thread.id === reviewer.threadId)
          ? Effect.void
          : createReviewerThread({
              orchestrationEngine,
              workflow,
              reviewer,
              threadId: reviewer.threadId,
              title: reviewer.label,
              createdAt: workflow.createdAt,
            }).pipe(Effect.asVoid),
      { discard: true },
    );

  const reconcileStuckWorkflow = (workflow: CodeReviewWorkflow, snapshot: OrchestrationReadModel) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow)) {
        return;
      }
      if (!isArchivedWorkflow(workflow)) yield* ensureReviewerThreads(workflow, snapshot);
      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow;

      yield* Effect.forEach(
        [...codeReviewReviewers(workflow).map(({ reviewer }) => reviewer), workflow.consolidation],
        (stage) =>
          stage.threadId
            ? promoteFinishedStageDispatch(
                stage,
                snapshot.threads.find((entry) => entry.id === stage.threadId),
              )
            : Effect.void,
        { discard: true },
      );

      for (const { id: reviewerId } of codeReviewReviewers(workflow)) {
        const reviewer = requireCodeReviewReviewer(reconciledWorkflow, reviewerId);
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          snapshot,
          reviewer.threadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
          continue;
        }
      }

      if (reconciledWorkflow.consolidation.threadId) {
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          snapshot,
          reconciledWorkflow.consolidation.threadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
        }
      }

      if (workflow.post?.status === "posting") {
        // Resume with the same operation id: PR Hub reads an existing operation
        // back and only ever sends one that is still `prepared`. (A post begun
        // by the advancement above was already enqueued.)
        yield* postWorker.enqueue({
          workflowId: workflow.id,
          operationId: workflow.post.operationId,
          checkOnly: false,
          resumed: true,
          supersededOperationId: null,
          adoptSuperseded: false,
          abandonSuperseded: false,
        });
      } else if (shouldAutoPostCodeReview(reconciledWorkflow)) {
        reconciledWorkflow = yield* beginPost(reconciledWorkflow, "auto", updatedAt);
      }

      if (reconciledWorkflow.consolidation.status === "pending_start") {
        yield* maybeStartConsolidation(reconciledWorkflow, snapshot, updatedAt, undefined, true);
        return;
      }

      // Reviewers that lost their turn across the restart are failed first, so queued
      // reviewers do not wait behind them. One whose recorded dispatch never happened (a crash
      // between saving the attempt and sending it) goes back in the queue instead.
      const failLostRunningReviewers = (current: CodeReviewWorkflow) =>
        Effect.gen(function* () {
          let next = current;
          for (const { id: reviewerId, reviewer } of codeReviewReviewers(current)) {
            if (reviewer.status !== "running") {
              continue;
            }
            const thread = snapshot.threads.find((entry) => entry.id === reviewer.threadId);
            if (
              reviewer.dispatchCommandId &&
              thread &&
              !hasActiveRunningTurn(thread) &&
              providerTurnDeliveryRepository._tag === "Some"
            ) {
              const dispatched = yield* providerTurnDeliveryRepository.value
                .getByCommandId(reviewer.dispatchCommandId)
                .pipe(
                  Effect.map((delivery) => delivery !== null),
                  // Unknown is not proof that nothing was sent; judge it as before.
                  Effect.catchCause(() => Effect.succeed(true)),
                );
              if (!dispatched) {
                next = updateCodeReviewReviewer(next, reviewerId, (entry) => ({
                  ...entry,
                  status: "pending",
                  error: null,
                  dispatchCommandId: null,
                  updatedAt,
                }));
                yield* upsertWorkflow(orchestrationEngine, next, updatedAt);
                continue;
              }
            }
            const error = yield* runningStageReconciliationError(
              reviewer.threadId,
              thread,
              reviewer.label,
              reviewer.dispatchCommandId,
            );
            if (error) {
              next = withReviewerError({ workflow: next, reviewerId, error, updatedAt });
              yield* upsertWorkflow(orchestrationEngine, next, next.updatedAt);
            }
          }
          return next;
        });

      if (
        codeReviewReviewers(reconciledWorkflow).some(
          ({ reviewer }) => reviewer.status === "pending",
        )
      ) {
        reconciledWorkflow = yield* failLostRunningReviewers(reconciledWorkflow);
        yield* startPendingReviewers(reconciledWorkflow, updatedAt);
        return;
      }

      if (
        shouldRetryConsolidationAfterReviewerUpdate(reconciledWorkflow) &&
        allReviewersCompleted(reconciledWorkflow)
      ) {
        const retriableWorkflow = resetConsolidationAfterReviewerUpdate(
          reconciledWorkflow,
          updatedAt,
        );
        yield* upsertWorkflow(orchestrationEngine, retriableWorkflow, retriableWorkflow.updatedAt);
        yield* maybeStartConsolidation(retriableWorkflow, snapshot, retriableWorkflow.updatedAt, {
          kind: "retry",
          reusedThread: false,
        });
        return;
      }

      if (
        reconciledWorkflow.consolidation.status === "not_started" &&
        allReviewersCompleted(reconciledWorkflow)
      ) {
        yield* maybeStartConsolidation(reconciledWorkflow, snapshot, updatedAt);
        return;
      }

      reconciledWorkflow = yield* failLostRunningReviewers(reconciledWorkflow);
      if (
        codeReviewReviewers(reconciledWorkflow).some(
          ({ reviewer }) => reviewer.status === "pending",
        )
      ) {
        yield* startPendingReviewers(reconciledWorkflow, updatedAt);
        return;
      }

      if (reconciledWorkflow.consolidation.status === "running") {
        const thread = reconciledWorkflow.consolidation.threadId
          ? snapshot.threads.find((entry) => entry.id === reconciledWorkflow.consolidation.threadId)
          : null;
        const error = reconciledWorkflow.consolidation.threadId
          ? yield* runningStageReconciliationError(
              reconciledWorkflow.consolidation.threadId,
              thread,
              "Consolidation",
              reconciledWorkflow.consolidation.dispatchCommandId,
            )
          : "Consolidation thread was unavailable during reconciliation.";
        if (error) {
          reconciledWorkflow = withConsolidationError(reconciledWorkflow, error, updatedAt);
          yield* upsertWorkflow(
            orchestrationEngine,
            reconciledWorkflow,
            reconciledWorkflow.updatedAt,
          );
        }
      }
    });

  const reconcileStuckWorkflows = Effect.gen(function* () {
    const snapshot = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(snapshot.codeReviewWorkflows, (workflow) =>
      reconcileStuckWorkflow(workflow, snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("CodeReviewWorkflowService.reconcileStuckWorkflow failed", {
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
        case "thread.turn-diff-completed": {
          return;
        }

        case "thread.message-sent": {
          if (event.payload.role !== "assistant" || event.payload.streaming) {
            return;
          }

          const readModel = yield* orchestrationEngine.getReadModel();
          const workflow = readModel.codeReviewWorkflows.find(
            (entry) =>
              !isDeletedWorkflow(entry) &&
              (reviewerMatch(entry, event.payload.threadId) ||
                entry.consolidation.threadId === event.payload.threadId),
          );
          if (!workflow) {
            return;
          }

          const nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
            workflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
          );
          if (nextWorkflow !== workflow) {
            yield* continueAfterStageAdvance(nextWorkflow, readModel, event.occurredAt);
          }
          return;
        }

        case "thread.session-set": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const matchedWorkflow = readModel.codeReviewWorkflows.find(
            (entry) => !isDeletedWorkflow(entry) && reviewerMatch(entry, event.payload.threadId),
          );
          if (matchedWorkflow) {
            const workflow = applyWorkflowTurnCost(
              matchedWorkflow,
              event.payload.session.turnCostUsd,
              event.occurredAt,
            );
            if (workflow !== matchedWorkflow) {
              yield* upsertWorkflow(orchestrationEngine, workflow, event.occurredAt);
            }
            const match = reviewerMatch(workflow, event.payload.threadId)!;
            const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
            if (event.payload.session.status === "error") {
              if (match.reviewer.status !== "running") {
                return;
              }
              if (
                event.payload.session.lastErrorRetryability === "retryable" &&
                (match.reviewer.retryCount ?? 0) < MAX_PROFILE_TIMEOUT_RETRIES &&
                workflowBudgetError(workflow) === null
              ) {
                const retryWorkflow = updateReviewer(
                  workflow,
                  match.reviewerId,
                  {
                    ...match.reviewer,
                    status: "pending",
                    error: null,
                    retryCount: (match.reviewer.retryCount ?? 0) + 1,
                    updatedAt: event.occurredAt,
                  },
                  event.occurredAt,
                );
                yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
                yield* startPendingReviewers(retryWorkflow, event.occurredAt);
                return;
              }
              const failedWorkflow = withReviewerError({
                workflow,
                reviewerId: match.reviewerId,
                error: event.payload.session.lastError ?? "Reviewer failed.",
                updatedAt: event.occurredAt,
              });
              yield* upsertWorkflow(orchestrationEngine, failedWorkflow, event.occurredAt);
              yield* startPendingReviewers(failedWorkflow, event.occurredAt);
              return;
            }
            if (
              event.payload.session.status === "ready" &&
              isLatestTurnFinishedAndConsumable(thread)
            ) {
              const nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
                workflow,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              if (nextWorkflow !== workflow) {
                yield* continueAfterStageAdvance(nextWorkflow, readModel, event.occurredAt);
              }
            }
            return;
          }

          const matchedConsolidationWorkflow = readModel.codeReviewWorkflows.find(
            (entry) =>
              !isDeletedWorkflow(entry) && entry.consolidation.threadId === event.payload.threadId,
          );
          if (!matchedConsolidationWorkflow) {
            return;
          }
          const consolidationWorkflow = applyWorkflowTurnCost(
            matchedConsolidationWorkflow,
            event.payload.session.turnCostUsd,
            event.occurredAt,
          );
          if (consolidationWorkflow !== matchedConsolidationWorkflow) {
            yield* upsertWorkflow(orchestrationEngine, consolidationWorkflow, event.occurredAt);
          }
          if (event.payload.session.status === "error") {
            if (consolidationWorkflow.consolidation.status !== "running") {
              return;
            }
            if (
              event.payload.session.lastErrorRetryability === "retryable" &&
              (consolidationWorkflow.consolidation.retryCount ?? 0) < MAX_PROFILE_TIMEOUT_RETRIES &&
              workflowBudgetError(consolidationWorkflow) === null
            ) {
              const retryWorkflow: CodeReviewWorkflow = {
                ...consolidationWorkflow,
                consolidation: {
                  ...consolidationWorkflow.consolidation,
                  threadId: null,
                  status: "not_started",
                  pinnedTurnId: null,
                  pinnedAssistantMessageId: null,
                  error: null,
                  retryCount: (consolidationWorkflow.consolidation.retryCount ?? 0) + 1,
                  updatedAt: event.occurredAt,
                },
                updatedAt: event.occurredAt,
              };
              yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
              yield* maybeStartConsolidation(retryWorkflow, readModel, event.occurredAt, {
                kind: "retry",
                reusedThread: false,
                priorFailure: event.payload.session.lastError ?? undefined,
              });
              return;
            }
            yield* upsertWorkflow(
              orchestrationEngine,
              withConsolidationError(
                consolidationWorkflow,
                event.payload.session.lastError ?? "Consolidation failed.",
                event.occurredAt,
              ),
              event.occurredAt,
            );
            return;
          }
          if (
            event.payload.session.status === "ready" &&
            isLatestTurnFinishedAndConsumable(
              readModel.threads.find((entry) => entry.id === event.payload.threadId),
            )
          ) {
            yield* maybeAdvanceWorkflowFromCompletedThread(
              consolidationWorkflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
          }
          return;
        }

        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("CodeReviewWorkflowService.handleDomainEvent failed", {
          eventType: event.type,
          cause,
        }),
      ),
    );

  // A provider can report acceptance after the stage's turn already finished
  // (ACP starts await the whole prompt). The completion events were skipped
  // while the dispatch was unaccepted, so re-check the stage now.
  const handleDeliveryOutcome = (outcome: ProviderTurnDeliveryOutcome) =>
    Effect.gen(function* () {
      if (outcome.state !== "accepted") {
        return;
      }
      const readModel = yield* orchestrationEngine.getReadModel();
      const isRunningDispatch = (stage: CodeReviewStage) =>
        stage.status === "running" && stage.dispatchCommandId === outcome.commandId;
      const workflow = readModel.codeReviewWorkflows.find(
        (entry) =>
          !isDeletedWorkflow(entry) &&
          (codeReviewReviewers(entry).some(({ reviewer }) => isRunningDispatch(reviewer)) ||
            isRunningDispatch(entry.consolidation)),
      );
      if (!workflow) {
        return;
      }
      const updatedAt = new Date().toISOString();
      const nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
        workflow,
        readModel,
        outcome.threadId,
        updatedAt,
      );
      if (nextWorkflow !== workflow) {
        yield* continueAfterStageAdvance(nextWorkflow, readModel, updatedAt);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("CodeReviewWorkflowService.handleDeliveryOutcome failed", {
          commandId: outcome.commandId,
          cause,
        }),
      ),
    );

  const start: CodeReviewWorkflowServiceShape["start"] = Effect.gen(function* () {
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
    yield* withWorkflowWriteLock(reconcileStuckWorkflows).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("CodeReviewWorkflowService.reconcileStuckWorkflows failed", {
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    // Delivery outcomes share the domain-event fiber so stage transitions stay
    // serialized.
    const domainEvents = orchestrationEngine.streamDomainEvents.pipe(
      Stream.map((event) => ({ kind: "event" as const, event })),
    );
    const work =
      providerTurnDeliveryWorker._tag === "Some"
        ? Stream.merge(
            domainEvents,
            providerTurnDeliveryWorker.value.outcomes.pipe(
              Stream.map((outcome) => ({ kind: "outcome" as const, outcome })),
            ),
          )
        : domainEvents;
    yield* Stream.runForEach(work, (item) =>
      withWorkflowWriteLock(
        item.kind === "event" ? handleDomainEvent(item.event) : handleDeliveryOutcome(item.outcome),
      ),
    ).pipe(
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope, { startImmediately: true }),
      Effect.asVoid,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("CodeReviewWorkflowService.start failed", { cause }).pipe(
        Effect.asVoid,
        Effect.flatMap(() => Effect.failCause(cause)),
      ),
    ),
  );

  const withCreationLock = makeOperationGate<CodeReviewWorkflowId>();
  const createWorkflow: CodeReviewWorkflowServiceShape["createWorkflow"] = (rawInput, options) => {
    const id = options?.workflowId;
    const create = Effect.gen(function* () {
      if (id) {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const existing = snapshot.codeReviewWorkflows.find((workflow) => workflow.id === id);
        if (existing) {
          if (isDeletedWorkflow(existing))
            return yield* Effect.fail(new Error("Code review workflow " + id + " was deleted."));
          if (!isArchivedWorkflow(existing)) {
            yield* ensureReviewerThreads(existing, snapshot);
            yield* startPendingReviewersLocked(existing.id);
          }
          return id;
        }
      }
      return yield* createNewWorkflow(rawInput, id);
    });
    if (!id)
      return create.pipe(
        Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
      );
    return withCreationLock(id, create).pipe(
      Effect.mapError((error) => new Error(error instanceof Error ? error.message : String(error))),
    );
  };

  /**
   * The PR the instructions name: the first PR URL (account hosts first, so
   * GitHub Enterprise resolves), else one shorthand number resolved against
   * the project's GitHub `origin`.
   */
  const resolveCodeReviewPullRequest = (
    reviewPrompt: string,
    projectId: CodeReviewWorkflow["projectId"],
    snapshot: OrchestrationReadModel,
  ) =>
    Effect.gen(function* () {
      for (const candidate of codeReviewPromptUrls(reviewPrompt)) {
        const federated = prHubFederation
          ? yield* prHubFederation.parseUrl(candidate).pipe(Effect.orElseSucceed(() => null))
          : null;
        const ref = federated ?? parseSourceControlPullRequestUrl(candidate);
        if (ref) return codeReviewPullRequestFromRef(ref, candidate);
      }
      const number = detectCodeReviewPullRequestShorthand(reviewPrompt);
      if (number === null || !gitCore) return null;
      const cwd = snapshot.projects.find(
        (project) => project.id === projectId && project.deletedAt === null,
      )?.workspaceRoot;
      if (!cwd) return null;
      const remoteUrl = yield* gitCore
        .readConfigValue(cwd, "remote.origin.url")
        .pipe(Effect.orElseSucceed(() => null));
      return githubPullRequestFromRemote(remoteUrl, number);
    });

  const createNewWorkflow = (
    rawInput: Parameters<CodeReviewWorkflowServiceShape["createWorkflow"]>[0],
    id?: CodeReviewWorkflowId,
  ) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const requestedReviewerSlots = codeReviewInputReviewerSlots(rawInput);
      if (requestedReviewerSlots.length > WORKFLOW_REVIEW_MAX_PARTICIPANTS) {
        return yield* Effect.fail(
          new Error(
            `Code review workflows support up to ${WORKFLOW_REVIEW_MAX_PARTICIPANTS} reviewers.`,
          ),
        );
      }
      const reviewerSlots = requestedReviewerSlots.map((slot) =>
        resolveAvailableWorkflowModelSlot(slot, providers),
      );
      const input = {
        ...rawInput,
        ...codeReviewInputReviewerFields(reviewerSlots),
        consolidation: resolveAvailableWorkflowModelSlot(rawInput.consolidation, providers),
      };
      const behavior = yield* Effect.try({
        try: () =>
          resolveWorkflowBehavior({
            runKind: "codeReview",
            templateId: input.templateId,
            templateVersion: input.templateVersion ?? LATEST_WORKFLOW_TEMPLATE_VERSION,
          }),
        catch: () =>
          new UnsupportedWorkflowTemplateError(
            "codeReview",
            input.templateId ?? "builtin.code-review.dual",
            input.templateVersion ?? 2,
          ),
      });
      yield* Effect.try({
        try: () => {
          for (const slot of reviewerSlots) {
            assertWorkflowStageProviderSupported({
              behavior,
              stage: "standalone-review",
              provider: slot.provider,
              providers,
            });
          }
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "consolidation",
            provider: input.consolidation.provider,
            providers,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
      const snapshot = yield* orchestrationEngine.getReadModel();
      const pullRequest = yield* resolveCodeReviewPullRequest(
        input.reviewPrompt,
        input.projectId,
        snapshot,
      );
      const autoPost = input.autoPost === true;
      if (autoPost && !isGitHubCodeReviewPullRequest(pullRequest)) {
        return yield* Effect.fail(
          new Error(
            "Auto-post needs a GitHub pull request link or PR #number in the review instructions.",
          ),
        );
      }
      const existingSlugs = new Set(
        snapshot.codeReviewWorkflows
          .filter(
            (workflow) => workflow.projectId === input.projectId && workflow.deletedAt === null,
          )
          .map((workflow) => workflow.slug),
      );
      const now = new Date().toISOString();
      const workflowId = id ?? CodeReviewWorkflowId.makeUnsafe(crypto.randomUUID());
      const reviewers = reviewerSlots.map((slot) => ({
        slot,
        threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
      }));
      const titleSourceText = input.branch
        ? `Branch: ${input.branch}\n\n${input.reviewPrompt}`
        : input.reviewPrompt;
      const initialTitle =
        input.title ??
        buildFallbackTitle({
          titleSourceText,
          attachments: [],
          defaultTitle: "New code review",
        });
      const slug = nextWorkflowSlug(existingSlugs, initialTitle);
      const workflow = buildCodeReviewWorkflowRecord({
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        reviewPrompt: input.reviewPrompt,
        branch: input.branch ?? null,
        createdAt: now,
        reviewers,
        consolidation: input.consolidation,
        maxCostUsd: input.maxCostUsd,
        pullRequest,
        autoPost,
      });

      yield* orchestrationEngine.dispatch({
        type: "project.code-review-workflow.create",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        reviewPrompt: input.reviewPrompt,
        branch: input.branch ?? null,
        ...codeReviewCommandReviewerFields(reviewers),
        consolidation: input.consolidation,
        maxCostUsd: input.maxCostUsd ?? null,
        pullRequest,
        autoPost,
        createdAt: now,
      });

      yield* Effect.all(
        codeReviewReviewers(workflow).map(({ id, reviewer }) =>
          createReviewerThread({
            orchestrationEngine,
            workflow,
            threadId: reviewer.threadId,
            reviewer,
            title: `Reviewer ${workflowParticipantLabel(id)}`,
            createdAt: now,
          }),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          dispatchWorkflowDeleteCompensation({
            orchestrationEngine,
            workflowId,
            projectId: input.projectId,
            createdAt: new Date().toISOString(),
          }).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.flatMap(() => Effect.failCause(cause)),
          ),
        ),
      );

      yield* startPendingReviewersLocked(workflowId);
      if (input.title === undefined) {
        yield* titleGenerationWorker.enqueue({
          workflowId,
          titleSourceText,
          expectedCurrentTitle: initialTitle,
          titleGenerationModel: input.titleGenerationModel,
          defaultTitle: "New code review",
        });
      }
      return workflowId;
    }).pipe(
      Effect.mapError((error) => new Error(error instanceof Error ? error.message : String(error))),
    );

  const deleteWorkflow: CodeReviewWorkflowServiceShape["deleteWorkflow"] = (
    workflowId,
    deleteThreads = false,
  ) =>
    changeWorkflowArchive.delete(
      workflowId,
      Effect.gen(function* () {
        const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
        }
        const result = yield* orchestrationEngine.dispatch({
          type: "project.code-review-workflow.delete",
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

  const changeWorkflowArchive = makeWorkflowArchiveLifecycle(orchestrationEngine, "codeReview");

  const archiveWorkflow: CodeReviewWorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.archive(workflowId);

  const unarchiveWorkflow: CodeReviewWorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.unarchive(workflowId, () =>
      // Read under the lock: a launch that ran while this waited must not be reconciled from a
      // stale record and written over.
      withWorkflowWriteLock(
        Effect.gen(function* () {
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow = snapshot.codeReviewWorkflows.find((entry) => entry.id === workflowId);
          if (workflow) yield* reconcileStuckWorkflow(workflow, snapshot);
        }),
      ),
    );

  // Under the write lock: retry upserts whole records and can complete a merge,
  // which may begin an auto-post.
  const retryWorkflow: CodeReviewWorkflowServiceShape["retryWorkflow"] = (input) =>
    withWorkflowWriteLock(
      Effect.gen(function* () {
        const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, input.workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
        }
        if (isArchivedWorkflow(workflow))
          return yield* Effect.fail(new Error("Restore the workflow before retrying it."));

        const updatedAt = new Date().toISOString();
        const snapshot = yield* orchestrationEngine.getReadModel();
        let nextWorkflow = workflow;

        for (const { reviewer } of codeReviewReviewers(workflow)) {
          nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
            nextWorkflow,
            snapshot,
            reviewer.threadId,
            updatedAt,
          );
        }
        if (nextWorkflow.consolidation.threadId) {
          nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
            nextWorkflow,
            snapshot,
            nextWorkflow.consolidation.threadId,
            updatedAt,
          );
        }
        nextWorkflow =
          (yield* readCodeReviewWorkflow(orchestrationEngine, input.workflowId)) ?? nextWorkflow;

        const scope = input.scope ?? "failed";
        if (scope === "consolidation" && !allReviewersCompleted(nextWorkflow)) {
          return yield* Effect.fail(
            new Error("All reviewers must be completed before retrying consolidation."),
          );
        }

        type RetryTarget =
          | {
              readonly kind: "reviewer";
              readonly reviewerId: WorkflowParticipantId;
              readonly threadId: ThreadId;
              readonly error: string | null;
              readonly expectedStatus: CodeReviewReviewer["status"];
              readonly updatedAt: string;
              readonly dispatchCommandId: CommandId | null;
            }
          | {
              readonly kind: "consolidation";
              readonly threadId: ThreadId;
              readonly error: string | null;
              readonly expectedStatus: CodeReviewWorkflow["consolidation"]["status"];
              readonly updatedAt: string;
              readonly dispatchCommandId: CommandId | null;
            };
        // Queued reviewers are not failures: the launcher starts them as slots free up.
        const reviewerTargets = codeReviewReviewers(nextWorkflow)
          .filter(
            ({ reviewer }) =>
              reviewer.status !== "completed" &&
              !(
                reviewer.status === "pending" &&
                workflowUsesMesh(codeReviewReviewers(nextWorkflow).length)
              ),
          )
          .map(
            ({ id, reviewer }): RetryTarget => ({
              kind: "reviewer",
              reviewerId: id,
              threadId: reviewer.threadId,
              error: reviewer.error,
              expectedStatus: reviewer.status,
              updatedAt: reviewer.updatedAt,
              dispatchCommandId: reviewer.dispatchCommandId ?? null,
            }),
          );
        const targets: RetryTarget[] =
          scope === "consolidation"
            ? (nextWorkflow.consolidation.status === "error" ||
                nextWorkflow.consolidation.status === "running") &&
              nextWorkflow.consolidation.threadId !== null
              ? [
                  {
                    kind: "consolidation",
                    threadId: nextWorkflow.consolidation.threadId,
                    error: nextWorkflow.consolidation.error,
                    expectedStatus: nextWorkflow.consolidation.status,
                    updatedAt: nextWorkflow.consolidation.updatedAt,
                    dispatchCommandId: nextWorkflow.consolidation.dispatchCommandId ?? null,
                  },
                ]
              : []
            : reviewerTargets.length > 0
              ? reviewerTargets
              : (nextWorkflow.consolidation.status === "error" ||
                    nextWorkflow.consolidation.status === "running") &&
                  nextWorkflow.consolidation.threadId !== null &&
                  allReviewersCompleted(nextWorkflow)
                ? [
                    {
                      kind: "consolidation",
                      threadId: nextWorkflow.consolidation.threadId,
                      error: nextWorkflow.consolidation.error,
                      expectedStatus: nextWorkflow.consolidation.status,
                      updatedAt: nextWorkflow.consolidation.updatedAt,
                      dispatchCommandId: nextWorkflow.consolidation.dispatchCommandId ?? null,
                    },
                  ]
                : [];

        if (targets.length === 0) {
          // Settling finished turns above can free slots for queued reviewers; their own
          // completion events have already been handled, so nothing else would admit them.
          if (!allReviewersCompleted(nextWorkflow)) {
            yield* startPendingReviewers(nextWorkflow, updatedAt);
            return { status: "started" as const };
          }
          if (
            allReviewersCompleted(nextWorkflow) &&
            nextWorkflow.consolidation.status !== "running" &&
            nextWorkflow.consolidation.status !== "pending_start" &&
            nextWorkflow.consolidation.status !== "completed"
          ) {
            const budgetError = workflowBudgetError(nextWorkflow);
            if (budgetError) {
              return yield* budgetError;
            }
            const retryableWorkflow = resetConsolidationAfterReviewerUpdate(
              nextWorkflow,
              updatedAt,
            );
            if (retryableWorkflow !== nextWorkflow) {
              yield* upsertWorkflow(orchestrationEngine, retryableWorkflow, updatedAt);
              nextWorkflow = retryableWorkflow;
            }
            yield* maybeStartConsolidation(nextWorkflow, snapshot, updatedAt, {
              kind: "retry",
              reusedThread: false,
              priorFailure: workflow.consolidation.error ?? undefined,
            });
          }
          return { status: "started" as const };
        }

        type RetryMode = "active" | "accepted" | "queued" | "retry" | "ambiguous" | "fresh";
        const retryModes = new Map<ThreadId, RetryMode>();
        // The delivery each non-fresh retry resumes; it becomes the stage dispatch.
        const resumedDispatchCommandIds = new Map<ThreadId, CommandId>();
        const targetStillCurrent = (
          candidate: CodeReviewWorkflow,
          target: RetryTarget,
        ): boolean => {
          const stage =
            target.kind === "reviewer"
              ? requireCodeReviewReviewer(candidate, target.reviewerId)
              : candidate.consolidation;
          return (
            stage.status === target.expectedStatus &&
            stage.updatedAt === target.updatedAt &&
            (target.kind === "reviewer" || stage.threadId === target.threadId)
          );
        };
        for (const target of targets) {
          const thread = snapshot.threads.find((entry) => entry.id === target.threadId);
          if (hasNewerActiveStageTurn(target.updatedAt, thread)) {
            retryModes.set(target.threadId, "active");
            continue;
          }
          if (providerTurnDeliveryWorker._tag === "None") {
            retryModes.set(target.threadId, "fresh");
            continue;
          }
          const delivery = yield* providerTurnDeliveryWorker.value
            // A stage with a recorded dispatch rechecks its own delivery, never a
            // newer one on the thread (for example a turn the user started).
            .recheck(target.threadId, target.dispatchCommandId ?? undefined)
            .pipe(
              Effect.mapError(
                (error) =>
                  new Error(
                    `Could not verify provider delivery for thread '${target.threadId}'. Retry after the provider reconnects.`,
                    { cause: error },
                  ),
              ),
            );
          if (delivery) {
            resumedDispatchCommandIds.set(target.threadId, delivery.commandId);
          }
          switch (delivery?.state) {
            case "accepted":
              retryModes.set(
                target.threadId,
                acceptedDeliveryMatchesCurrentTurn(delivery, thread) ? "accepted" : "fresh",
              );
              break;
            case "pending":
            case "sending":
              retryModes.set(target.threadId, "queued");
              break;
            case "rejected":
              retryModes.set(target.threadId, "retry");
              break;
            case "ambiguous":
              retryModes.set(target.threadId, "ambiguous");
              break;
            default:
              retryModes.set(target.threadId, "fresh");
              break;
          }
        }

        const latestBeforeConfirmation =
          (yield* readCodeReviewWorkflow(orchestrationEngine, input.workflowId)) ?? nextWorkflow;
        const ambiguousThreadIds = targets
          .filter(
            (target) =>
              retryModes.get(target.threadId) === "ambiguous" &&
              targetStillCurrent(latestBeforeConfirmation, target),
          )
          .map((target) => target.threadId);
        if (ambiguousThreadIds.length > 0 && !input.allowPossibleDuplicate) {
          return {
            status: "confirmation_required" as const,
            threadIds: ambiguousThreadIds,
          };
        }

        // A target that fails part-way must not strand reviewers this pass already queued:
        // with none of them running, no completion would admit them.
        const applied = yield* Effect.exit(
          Effect.gen(function* () {
            for (const target of targets) {
              const mode = retryModes.get(target.threadId) ?? "fresh";
              const currentWorkflow = yield* readCodeReviewWorkflow(
                orchestrationEngine,
                input.workflowId,
              );
              if (!currentWorkflow || !targetStillCurrent(currentWorkflow, target)) {
                if (currentWorkflow) {
                  nextWorkflow = currentWorkflow;
                }
                continue;
              }
              if (mode === "fresh" || mode === "retry" || mode === "ambiguous") {
                const budgetError = workflowBudgetError(currentWorkflow);
                if (budgetError) {
                  return yield* budgetError;
                }
              }

              // "active" resumes a turn with no known delivery, so it stays ungated.
              let dispatchCommandId: CommandId | null =
                mode === "active" ? null : (resumedDispatchCommandIds.get(target.threadId) ?? null);
              if (target.kind === "reviewer") {
                const reviewer = requireCodeReviewReviewer(currentWorkflow, target.reviewerId);
                const mesh = workflowUsesMesh(codeReviewReviewers(currentWorkflow).length);
                const reviewSlotFree =
                  codeReviewReviewers(currentWorkflow).filter(
                    (entry) => entry.reviewer.status === "running",
                  ).length < WORKFLOW_MAX_ACTIVE_REVIEW_TURNS;
                if ((mode === "retry" || mode === "ambiguous") && (!mesh || reviewSlotFree)) {
                  if (providerTurnDeliveryWorker._tag === "None") {
                    return yield* Effect.fail(new Error("Provider delivery retry is unavailable."));
                  }
                  const retried = yield* providerTurnDeliveryWorker.value.retry({
                    threadId: target.threadId,
                    allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
                    deliveryId: target.dispatchCommandId ?? undefined,
                  });
                  dispatchCommandId = retried.commandId;
                } else if (mesh && (mode === "fresh" || mode === "retry" || mode === "ambiguous")) {
                  // Larger runs queue the fresh retry (and a delivery retry with no free slot),
                  // so the launcher keeps at most WORKFLOW_MAX_ACTIVE_REVIEW_TURNS running.
                  const latestWorkflow = yield* readCodeReviewWorkflow(
                    orchestrationEngine,
                    input.workflowId,
                  );
                  if (latestWorkflow && targetStillCurrent(latestWorkflow, target)) {
                    queuedReviewerRetries.set(
                      target.threadId,
                      mode === "fresh"
                        ? {
                            kind: "turn",
                            retry: {
                              kind: "retry",
                              reusedThread: true,
                              priorFailure: target.error ?? undefined,
                            },
                          }
                        : {
                            kind: "delivery",
                            deliveryId: target.dispatchCommandId ?? undefined,
                            allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
                          },
                    );
                    nextWorkflow = updateReviewer(
                      latestWorkflow,
                      target.reviewerId,
                      {
                        ...requireCodeReviewReviewer(latestWorkflow, target.reviewerId),
                        status: "pending",
                        pinnedTurnId: null,
                        pinnedAssistantMessageId: null,
                        error: null,
                        retryCount: 0,
                        // A delivery retry keeps the failed delivery it will resend, so the resend
                        // survives a restart (see `persistedDeliveryRetry`).
                        dispatchCommandId:
                          mode === "fresh"
                            ? null
                            : (target.dispatchCommandId ??
                              resumedDispatchCommandIds.get(target.threadId) ??
                              null),
                        updatedAt,
                      },
                      updatedAt,
                    );
                    yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
                  } else if (latestWorkflow) {
                    nextWorkflow = latestWorkflow;
                  }
                  continue;
                } else if (mode === "fresh") {
                  const freshCommandId = CommandId.makeUnsafe(timeOrderedUuid());
                  // Saved before dispatching, so a crash in between leaves a running reviewer that
                  // startup judges by this attempt's delivery rather than one dispatched twice.
                  const runningWorkflow = withReviewerRetryRunning(
                    currentWorkflow,
                    target.reviewerId,
                    updatedAt,
                    freshCommandId,
                  );
                  yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
                  nextWorkflow = runningWorkflow;
                  const started = yield* Effect.exit(
                    startReviewerTurn({
                      orchestrationEngine,
                      workflow: runningWorkflow,
                      reviewer,
                      commandId: freshCommandId,
                      createdAt: updatedAt,
                      retry: {
                        kind: "retry",
                        reusedThread: true,
                        priorFailure: target.error ?? undefined,
                      },
                    }),
                  );
                  if (started._tag === "Failure") {
                    // The retry never started: the reviewer keeps the failure it had.
                    nextWorkflow = updateReviewer(
                      runningWorkflow,
                      target.reviewerId,
                      reviewer,
                      updatedAt,
                    );
                    yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
                    return yield* Effect.failCause(started.cause);
                  }
                  continue;
                }
                const latestWorkflow = yield* readCodeReviewWorkflow(
                  orchestrationEngine,
                  input.workflowId,
                );
                if (latestWorkflow && targetStillCurrent(latestWorkflow, target)) {
                  nextWorkflow = withReviewerRetryRunning(
                    latestWorkflow,
                    target.reviewerId,
                    updatedAt,
                    dispatchCommandId,
                  );
                  yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
                } else if (latestWorkflow) {
                  nextWorkflow = latestWorkflow;
                }
                continue;
              }

              if (mode === "retry" || mode === "ambiguous") {
                if (providerTurnDeliveryWorker._tag === "None") {
                  return yield* Effect.fail(new Error("Provider delivery retry is unavailable."));
                }
                const retried = yield* providerTurnDeliveryWorker.value.retry({
                  threadId: target.threadId,
                  allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
                  deliveryId: target.dispatchCommandId ?? undefined,
                });
                dispatchCommandId = retried.commandId;
              }
              if (mode !== "fresh") {
                const latestWorkflow = yield* readCodeReviewWorkflow(
                  orchestrationEngine,
                  input.workflowId,
                );
                if (latestWorkflow && targetStillCurrent(latestWorkflow, target)) {
                  nextWorkflow = withConsolidationRunning(
                    latestWorkflow,
                    target.threadId,
                    updatedAt,
                    dispatchCommandId,
                  );
                  yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
                } else if (latestWorkflow) {
                  nextWorkflow = latestWorkflow;
                }
                continue;
              }

              const retryableWorkflow: CodeReviewWorkflow = {
                ...currentWorkflow,
                consolidation: {
                  ...currentWorkflow.consolidation,
                  threadId: null,
                  status: "not_started",
                  pinnedTurnId: null,
                  pinnedAssistantMessageId: null,
                  error: null,
                  retryCount: 0,
                  updatedAt,
                },
                updatedAt,
              };
              nextWorkflow = retryableWorkflow;
              const latestSnapshot = yield* orchestrationEngine.getReadModel();
              yield* maybeStartConsolidation(retryableWorkflow, latestSnapshot, updatedAt, {
                kind: "retry",
                reusedThread: false,
                priorFailure: target.error ?? undefined,
              });
            }
          }),
        );

        // Admission runs either way. When both fail, the target's failure stays the primary
        // cause and the admission failure is added to it.
        const admitted = yield* Effect.exit(
          Effect.gen(function* () {
            const settledWorkflow = yield* readCodeReviewWorkflow(
              orchestrationEngine,
              input.workflowId,
            );
            if (settledWorkflow) {
              yield* startPendingReviewers(settledWorkflow, updatedAt);
            }
          }),
        );
        if (applied._tag === "Failure") {
          return yield* Effect.failCause(
            admitted._tag === "Failure"
              ? Cause.combine(applied.cause, admitted.cause)
              : applied.cause,
          );
        }
        if (admitted._tag === "Failure") return yield* Effect.failCause(admitted.cause);
        return { status: "started" as const };
      }),
    );

  const postWorkflow: CodeReviewWorkflowServiceShape["postWorkflow"] = (input) =>
    withWorkflowWriteLock(
      Effect.gen(function* () {
        const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, input.workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
        }
        const blocker = manualCodeReviewPostBlocker(workflow);
        if (blocker) return yield* Effect.fail(new Error(blocker));
        yield* beginPost(workflow, "manual", new Date().toISOString(), {
          allowPossibleDuplicate: input.allowPossibleDuplicate === true,
        });
        return { status: "started" as const };
      }),
    ).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))));

  const workflowForThread: CodeReviewWorkflowServiceShape["workflowForThread"] = (threadId) =>
    orchestrationEngine.getReadModel().pipe(
      Effect.map((snapshot) => {
        for (const workflow of snapshot.codeReviewWorkflows) {
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
        Effect.logWarning("CodeReviewWorkflowService.workflowForThread: snapshot lookup failed", {
          threadId,
          cause: error,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  yield* registerShutdown(
    "code-review-workflows-titles",
    "drain",
    () => titleGenerationWorker.drain,
    ["provider-ingestion"],
  );

  yield* Effect.addFinalizer(() => sources.stop);

  return {
    start,
    drain: Effect.andThen(titleGenerationWorker.drain, postWorker.drain),
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    postWorkflow,
    workflowForThread,
  } satisfies CodeReviewWorkflowServiceShape;
});

export const CodeReviewWorkflowServiceLive = Layer.effect(
  CodeReviewWorkflowService,
  makeCodeReviewWorkflowService,
);
