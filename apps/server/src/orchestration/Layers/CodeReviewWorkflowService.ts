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
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  buildCodeReviewConsolidationPrompt,
  buildCodeReviewReviewerPrompt,
} from "../codeReviewWorkflowPrompts.ts";
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
  workflowArtifactFit,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "../workflowSharedUtils.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import type { ProviderTurnDelivery } from "../Services/ProviderTurnDeliveryRepository.ts";
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
import { buildCodeReviewWorkflowRecord } from "../workflowRecordBuilders.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";

type CodeReviewWorkflowTitleGenerationWorkItem = {
  readonly workflowId: CodeReviewWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

const MAX_PROFILE_TIMEOUT_RETRIES = 1;

function userFacingCauseMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message : String(squashed);
  return message.trim() || fallback;
}

type CodeReviewStage = {
  readonly status: CodeReviewReviewer["status"] | CodeReviewWorkflow["consolidation"]["status"];
  readonly pinnedTurnId: string | null;
  readonly pinnedAssistantMessageId: string | null;
  readonly updatedAt: string;
};

function canConsumeCompletedStageTurn(
  stage: CodeReviewStage,
  thread: OrchestrationReadModel["threads"][number] | null | undefined,
): boolean {
  const completionEvidenceAt = completedTurnEvidenceAt(thread);
  if (!completionEvidenceAt || !getFinishedConsumableLatestTurn(thread)) {
    return false;
  }
  return (
    stage.status === "running" ||
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
  reviewerKey: "reviewerA" | "reviewerB",
  reviewer: CodeReviewReviewer,
  updatedAt: string,
): CodeReviewWorkflow {
  return {
    ...workflow,
    [reviewerKey]: reviewer,
    updatedAt,
  };
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
): { reviewerKey: "reviewerA" | "reviewerB"; reviewer: CodeReviewReviewer } | null {
  if (workflow.reviewerA.threadId === threadId) {
    return { reviewerKey: "reviewerA", reviewer: workflow.reviewerA };
  }
  if (workflow.reviewerB.threadId === threadId) {
    return { reviewerKey: "reviewerB", reviewer: workflow.reviewerB };
  }
  return null;
}

function labelForThread(
  workflow: CodeReviewWorkflow,
  threadId: ThreadId,
): { workflow: CodeReviewWorkflow; label: string } | null {
  if (workflow.reviewerA.threadId === threadId) {
    return { workflow, label: "Reviewer A" };
  }
  if (workflow.reviewerB.threadId === threadId) {
    return { workflow, label: "Reviewer B" };
  }
  if (workflow.consolidation.threadId === threadId) {
    return { workflow, label: "Merge" };
  }
  return null;
}

function withReviewerRunning(workflow: CodeReviewWorkflow, updatedAt: string): CodeReviewWorkflow {
  return {
    ...workflow,
    reviewerA:
      workflow.reviewerA.status === "pending"
        ? {
            ...workflow.reviewerA,
            status: "running",
            error: null,
            updatedAt,
          }
        : workflow.reviewerA,
    reviewerB:
      workflow.reviewerB.status === "pending"
        ? {
            ...workflow.reviewerB,
            status: "running",
            error: null,
            updatedAt,
          }
        : workflow.reviewerB,
    updatedAt,
  };
}

function withReviewerRetryRunning(
  workflow: CodeReviewWorkflow,
  reviewerKey: "reviewerA" | "reviewerB",
  updatedAt: string,
): CodeReviewWorkflow {
  const reviewer = workflow[reviewerKey];
  return updateReviewer(
    workflow,
    reviewerKey,
    {
      ...reviewer,
      status: "running",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      retryCount: 0,
      updatedAt,
    },
    updatedAt,
  );
}

function withCompletedReviewer(input: {
  workflow: CodeReviewWorkflow;
  reviewerKey: "reviewerA" | "reviewerB";
  turnId: string | null;
  assistantMessageId: string | null;
  updatedAt: string;
}): CodeReviewWorkflow {
  const current = input.workflow[input.reviewerKey];
  if (
    current.status === "completed" &&
    current.pinnedTurnId === input.turnId &&
    current.pinnedAssistantMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return updateReviewer(
    input.workflow,
    input.reviewerKey,
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
  reviewerKey: "reviewerA" | "reviewerB";
  error: string;
  updatedAt: string;
}): CodeReviewWorkflow {
  const current = input.workflow[input.reviewerKey];
  return updateReviewer(
    input.workflow,
    input.reviewerKey,
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
): CodeReviewWorkflow {
  return {
    ...workflow,
    consolidation: {
      ...workflow.consolidation,
      threadId,
      status: "running",
      error: null,
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
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
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
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
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
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
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
  createdAt: string;
  retry: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildCodeReviewReviewerPrompt({
    workflowId: input.workflow.id,
    reviewPrompt: input.workflow.reviewPrompt,
    reviewerLabel: input.reviewer.label,
    lensBranch: input.reviewer.threadId === input.workflow.reviewerA.threadId ? "a" : "b",
    branch: input.workflow.branch,
    reviewerSlot: input.reviewer.slot,
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
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
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
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
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

function startConsolidationTurn(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: CodeReviewWorkflow;
  reviews: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  createdAt: string;
  retry: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildCodeReviewConsolidationPrompt({
    workflowId: input.workflow.id,
    reviewPrompt: input.workflow.reviewPrompt,
    reviews: input.reviews,
    consolidationSlot: input.workflow.consolidation.slot,
    retry: input.retry,
  });
  const behavior = resolveWorkflowBehavior({
    runKind: "codeReview",
    templateId: input.workflow.templateId,
    templateVersion: input.workflow.templateVersion,
  });
  const fit = workflowArtifactFit({
    artifacts: input.reviews.map((review) => review.text),
    targetSlot: input.workflow.consolidation.slot,
  });
  if (
    prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT ||
    (behavior.loudAuthoritativeArtifactLimit && !fit.fits)
  ) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail:
          prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT
            ? `Consolidation prompt is ${prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`
            : `Consolidation reviews require an estimated ${fit.estimatedTokens} tokens; only ${fit.availableTokens} are available.`,
      }),
    );
  }
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: input.workflow.consolidation.threadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
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
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);
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

      const deliveryExit = yield* Effect.exit(providerTurnDeliveryWorker.value.recheck(threadId));
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

  const titleGenerationWorker = yield* makeDrainableWorker(
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
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("CodeReviewWorkflowService.titleGenerationWorker failed", {
            workflowId: item.workflowId,
            cause,
          }),
        ),
      ),
  );

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
        workflow.reviewerA.status !== "completed" ||
        workflow.reviewerB.status !== "completed" ||
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
      const reviewerInputs = [pendingWorkflow.reviewerA, pendingWorkflow.reviewerB].map(
        (reviewer) => {
          const thread = snapshot.threads.find((entry) => entry.id === reviewer.threadId);
          // Reviewer threads are ephemeral, single-review threads, so the
          // pinned assistant message stays within the read model's retention
          // window. latestAssistantFeedback also falls back to the latest
          // assistant message if the pinned id is ever outside the window.
          const text = thread
            ? (latestAssistantFeedback(thread, reviewer.pinnedAssistantMessageId)?.text ?? null)
            : null;
          return {
            label: reviewer.label,
            text,
            ...(reviewer.pinnedTurnId ? { turnId: reviewer.pinnedTurnId } : {}),
            ...(reviewer.pinnedAssistantMessageId
              ? { messageId: reviewer.pinnedAssistantMessageId }
              : {}),
          };
        },
      );

      if (reviewerInputs.some((review) => !review.text || review.text.trim().length === 0)) {
        yield* upsertWorkflow(
          orchestrationEngine,
          withConsolidationError(
            pendingWorkflow,
            "Reviewer output not found for consolidation.",
            updatedAt,
          ),
          updatedAt,
        );
        return;
      }

      if (!snapshot.threads.some((thread) => thread.id === consolidationThreadId)) {
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

      const runningWorkflow = withConsolidationRunning(
        pendingWorkflow,
        consolidationThreadId,
        updatedAt,
      );
      yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
      const consolidationOutcome = yield* Effect.exit(
        startConsolidationTurn({
          orchestrationEngine,
          workflow: runningWorkflow,
          reviews: reviewerInputs.map((review) => ({
            label: review.label,
            text: review.text!,
            ...(review.turnId ? { turnId: review.turnId } : {}),
            ...(review.messageId ? { messageId: review.messageId } : {}),
          })),
          createdAt: updatedAt,
          retry: retry ?? { kind: "none" },
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

  const startPendingReviewers = (workflow: CodeReviewWorkflow, updatedAt: string) =>
    Effect.gen(function* () {
      const pendingReviewers = [workflow.reviewerA, workflow.reviewerB].filter(
        (reviewer) => reviewer.status === "pending",
      );
      if (pendingReviewers.length === 0) {
        return;
      }
      const snapshot = yield* orchestrationEngine.getReadModel();
      let nextWorkflow = workflow;
      for (const reviewer of pendingReviewers) {
        const reviewerThread = snapshot.threads.find((thread) => thread.id === reviewer.threadId);
        const outcome = yield* Effect.exit(
          startReviewerTurn({
            orchestrationEngine,
            workflow,
            reviewer,
            createdAt: updatedAt,
            retry: hasPriorThreadWork(reviewerThread)
              ? { kind: "retry", reusedThread: true }
              : { kind: "none" },
          }),
        );
        if (outcome._tag === "Failure") {
          yield* Effect.logError("Code-review reviewer turn dispatch failed", {
            workflowId: workflow.id,
            threadId: reviewer.threadId,
            cause: Cause.pretty(outcome.cause),
          });
          nextWorkflow = withReviewerError({
            workflow: nextWorkflow,
            reviewerKey:
              reviewer.threadId === workflow.reviewerA.threadId ? "reviewerA" : "reviewerB",
            error: userFacingCauseMessage(outcome.cause, "Could not start the reviewer."),
            updatedAt,
          });
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
      }
      yield* upsertWorkflow(
        orchestrationEngine,
        withReviewerRunning(nextWorkflow, updatedAt),
        updatedAt,
      );
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
      if (reviewer && canConsumeCompletedStageTurn(reviewer.reviewer, thread)) {
        const nextWorkflow = resetConsolidationAfterReviewerUpdate(
          withCompletedReviewer({
            workflow,
            reviewerKey: reviewer.reviewerKey,
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
        canConsumeCompletedStageTurn(workflow.consolidation, thread)
      ) {
        const nextWorkflow = withConsolidationCompleted({
          workflow,
          turnId: completedTurn.turnId,
          assistantMessageId: completedTurn.assistantMessageId,
          updatedAt,
        });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
        return nextWorkflow;
      }

      return workflow;
    });

  const reconcileStuckWorkflow = (workflow: CodeReviewWorkflow, snapshot: OrchestrationReadModel) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow)) {
        return;
      }
      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow;

      for (const reviewerKey of ["reviewerA", "reviewerB"] as const) {
        const reviewer = reconciledWorkflow[reviewerKey];
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

      if (reconciledWorkflow.consolidation.status === "pending_start") {
        yield* maybeStartConsolidation(reconciledWorkflow, snapshot, updatedAt, undefined, true);
        return;
      }

      if (
        reconciledWorkflow.reviewerA.status === "pending" ||
        reconciledWorkflow.reviewerB.status === "pending"
      ) {
        yield* startPendingReviewers(reconciledWorkflow, updatedAt);
        return;
      }

      if (
        shouldRetryConsolidationAfterReviewerUpdate(reconciledWorkflow) &&
        reconciledWorkflow.reviewerA.status === "completed" &&
        reconciledWorkflow.reviewerB.status === "completed"
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
        reconciledWorkflow.reviewerA.status === "completed" &&
        reconciledWorkflow.reviewerB.status === "completed"
      ) {
        yield* maybeStartConsolidation(reconciledWorkflow, snapshot, updatedAt);
        return;
      }

      for (const reviewerKey of ["reviewerA", "reviewerB"] as const) {
        const reviewer = reconciledWorkflow[reviewerKey];
        if (reviewer.status !== "running") {
          continue;
        }
        const thread = snapshot.threads.find((entry) => entry.id === reviewer.threadId);
        const error = yield* runningStageReconciliationError(
          reviewer.threadId,
          thread,
          reviewer.label,
        );
        if (error) {
          reconciledWorkflow = withReviewerError({
            workflow: reconciledWorkflow,
            reviewerKey,
            error,
            updatedAt,
          });
          yield* upsertWorkflow(
            orchestrationEngine,
            reconciledWorkflow,
            reconciledWorkflow.updatedAt,
          );
        }
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
            yield* maybeStartConsolidation(nextWorkflow, readModel, event.occurredAt);
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
                  match.reviewerKey,
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
              yield* upsertWorkflow(
                orchestrationEngine,
                withReviewerError({
                  workflow,
                  reviewerKey: match.reviewerKey,
                  error: event.payload.session.lastError ?? "Reviewer failed.",
                  updatedAt: event.occurredAt,
                }),
                event.occurredAt,
              );
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
                yield* maybeStartConsolidation(nextWorkflow, readModel, event.occurredAt);
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

  const start: CodeReviewWorkflowServiceShape["start"] = Effect.gen(function* () {
    yield* reconcileStuckWorkflows.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("CodeReviewWorkflowService.reconcileStuckWorkflows failed", {
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
      Effect.logError("CodeReviewWorkflowService.start failed", { cause }).pipe(
        Effect.asVoid,
        Effect.flatMap(() => Effect.failCause(cause)),
      ),
    ),
  );

  const createWorkflow: CodeReviewWorkflowServiceShape["createWorkflow"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const input = {
        ...rawInput,
        reviewerA: resolveAvailableWorkflowModelSlot(rawInput.reviewerA, providers),
        reviewerB: resolveAvailableWorkflowModelSlot(rawInput.reviewerB, providers),
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
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "standalone-review",
            provider: input.reviewerA.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "standalone-review",
            provider: input.reviewerB.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "consolidation",
            provider: input.consolidation.provider,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
      const snapshot = yield* orchestrationEngine.getReadModel();
      const existingSlugs = new Set(
        snapshot.codeReviewWorkflows
          .filter(
            (workflow) => workflow.projectId === input.projectId && workflow.deletedAt === null,
          )
          .map((workflow) => workflow.slug),
      );
      const now = new Date().toISOString();
      const workflowId = CodeReviewWorkflowId.makeUnsafe(crypto.randomUUID());
      const reviewThreadIdA = ThreadId.makeUnsafe(crypto.randomUUID());
      const reviewThreadIdB = ThreadId.makeUnsafe(crypto.randomUUID());
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
        reviewThreadIdA,
        reviewThreadIdB,
        reviewerA: input.reviewerA,
        reviewerB: input.reviewerB,
        consolidation: input.consolidation,
        maxCostUsd: input.maxCostUsd,
      });

      yield* orchestrationEngine.dispatch({
        type: "project.code-review-workflow.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        reviewPrompt: input.reviewPrompt,
        branch: input.branch ?? null,
        reviewerA: input.reviewerA,
        reviewerB: input.reviewerB,
        consolidation: input.consolidation,
        maxCostUsd: input.maxCostUsd ?? null,
        reviewerThreadIdA: reviewThreadIdA,
        reviewerThreadIdB: reviewThreadIdB,
        createdAt: now,
      });

      yield* Effect.all([
        createReviewerThread({
          orchestrationEngine,
          workflow,
          threadId: reviewThreadIdA,
          reviewer: workflow.reviewerA,
          title: "Reviewer A",
          createdAt: now,
        }),
        createReviewerThread({
          orchestrationEngine,
          workflow,
          threadId: reviewThreadIdB,
          reviewer: workflow.reviewerB,
          title: "Reviewer B",
          createdAt: now,
        }),
      ]).pipe(
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

      yield* startPendingReviewers(workflow, new Date().toISOString());
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

  const deleteWorkflow: CodeReviewWorkflowServiceShape["deleteWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
      }
      yield* orchestrationEngine.dispatch({
        type: "project.code-review-workflow.delete",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        workflowId,
        projectId: workflow.projectId,
        createdAt: new Date().toISOString(),
      });
    });

  const archiveWorkflow: CodeReviewWorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, workflowId).pipe(
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
      yield* upsertWorkflow(
        orchestrationEngine,
        { ...workflow, archivedAt: updatedAt, updatedAt },
        updatedAt,
      );
    });

  const unarchiveWorkflow: CodeReviewWorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    Effect.gen(function* () {
      const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, workflowId).pipe(
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
      yield* upsertWorkflow(
        orchestrationEngine,
        { ...workflow, archivedAt: null, updatedAt },
        updatedAt,
      );
    });

  const retryWorkflow: CodeReviewWorkflowServiceShape["retryWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* readCodeReviewWorkflow(orchestrationEngine, input.workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }

      const updatedAt = new Date().toISOString();
      const snapshot = yield* orchestrationEngine.getReadModel();
      let nextWorkflow = workflow;

      for (const reviewerKey of ["reviewerA", "reviewerB"] as const) {
        nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          nextWorkflow,
          snapshot,
          nextWorkflow[reviewerKey].threadId,
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
      if (
        scope === "consolidation" &&
        (nextWorkflow.reviewerA.status !== "completed" ||
          nextWorkflow.reviewerB.status !== "completed")
      ) {
        return yield* Effect.fail(
          new Error("Both reviewers must be completed before retrying consolidation."),
        );
      }

      type RetryTarget =
        | {
            readonly kind: "reviewer";
            readonly reviewerKey: "reviewerA" | "reviewerB";
            readonly threadId: ThreadId;
            readonly error: string | null;
            readonly expectedStatus: CodeReviewReviewer["status"];
            readonly updatedAt: string;
          }
        | {
            readonly kind: "consolidation";
            readonly threadId: ThreadId;
            readonly error: string | null;
            readonly expectedStatus: CodeReviewWorkflow["consolidation"]["status"];
            readonly updatedAt: string;
          };
      const reviewerTargets = (["reviewerA", "reviewerB"] as const)
        .filter((reviewerKey) => nextWorkflow[reviewerKey].status !== "completed")
        .map(
          (reviewerKey): RetryTarget => ({
            kind: "reviewer",
            reviewerKey,
            threadId: nextWorkflow[reviewerKey].threadId,
            error: nextWorkflow[reviewerKey].error,
            expectedStatus: nextWorkflow[reviewerKey].status,
            updatedAt: nextWorkflow[reviewerKey].updatedAt,
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
                },
              ]
            : []
          : reviewerTargets.length > 0
            ? reviewerTargets
            : (nextWorkflow.consolidation.status === "error" ||
                  nextWorkflow.consolidation.status === "running") &&
                nextWorkflow.consolidation.threadId !== null &&
                nextWorkflow.reviewerA.status === "completed" &&
                nextWorkflow.reviewerB.status === "completed"
              ? [
                  {
                    kind: "consolidation",
                    threadId: nextWorkflow.consolidation.threadId,
                    error: nextWorkflow.consolidation.error,
                    expectedStatus: nextWorkflow.consolidation.status,
                    updatedAt: nextWorkflow.consolidation.updatedAt,
                  },
                ]
              : [];

      if (targets.length === 0) {
        if (
          nextWorkflow.reviewerA.status === "completed" &&
          nextWorkflow.reviewerB.status === "completed" &&
          nextWorkflow.consolidation.status !== "running" &&
          nextWorkflow.consolidation.status !== "pending_start" &&
          nextWorkflow.consolidation.status !== "completed"
        ) {
          const budgetError = workflowBudgetError(nextWorkflow);
          if (budgetError) {
            return yield* budgetError;
          }
          const retryableWorkflow = resetConsolidationAfterReviewerUpdate(nextWorkflow, updatedAt);
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
      const targetStillCurrent = (candidate: CodeReviewWorkflow, target: RetryTarget): boolean => {
        const stage =
          target.kind === "reviewer" ? candidate[target.reviewerKey] : candidate.consolidation;
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
          .recheck(target.threadId)
          .pipe(
            Effect.mapError(
              (error) =>
                new Error(
                  `Could not verify provider delivery for thread '${target.threadId}'. Retry after the provider reconnects.`,
                  { cause: error },
                ),
            ),
          );
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

        if (target.kind === "reviewer") {
          const reviewer = currentWorkflow[target.reviewerKey];
          if (mode === "retry" || mode === "ambiguous") {
            if (providerTurnDeliveryWorker._tag === "None") {
              return yield* Effect.fail(new Error("Provider delivery retry is unavailable."));
            }
            yield* providerTurnDeliveryWorker.value.retry({
              threadId: target.threadId,
              allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
            });
          } else if (mode === "fresh") {
            yield* startReviewerTurn({
              orchestrationEngine,
              workflow: currentWorkflow,
              reviewer,
              createdAt: updatedAt,
              retry: {
                kind: "retry",
                reusedThread: true,
                priorFailure: target.error ?? undefined,
              },
            });
          }
          const latestWorkflow = yield* readCodeReviewWorkflow(
            orchestrationEngine,
            input.workflowId,
          );
          if (latestWorkflow && targetStillCurrent(latestWorkflow, target)) {
            nextWorkflow = withReviewerRetryRunning(latestWorkflow, target.reviewerKey, updatedAt);
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
          yield* providerTurnDeliveryWorker.value.retry({
            threadId: target.threadId,
            allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
          });
        }
        if (mode !== "fresh") {
          const latestWorkflow = yield* readCodeReviewWorkflow(
            orchestrationEngine,
            input.workflowId,
          );
          if (latestWorkflow && targetStillCurrent(latestWorkflow, target)) {
            nextWorkflow = withConsolidationRunning(latestWorkflow, target.threadId, updatedAt);
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

      return { status: "started" as const };
    });

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

  return {
    start,
    drain: titleGenerationWorker.drain,
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    workflowForThread,
  } satisfies CodeReviewWorkflowServiceShape;
});

export const CodeReviewWorkflowServiceLive = Layer.effect(
  CodeReviewWorkflowService,
  makeCodeReviewWorkflowService,
);
