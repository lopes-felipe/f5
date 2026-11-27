import { timeOrderedUuid } from "@t3tools/shared/ids";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import { userFacingCauseMessage } from "../../causeMessage.ts";
import {
  CommandId,
  InvestigationWorkflowId,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type InvestigationInvestigator,
  type InvestigationPhaseStatus,
  type InvestigationWorkflow,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  WORKFLOW_MESH_MAX_PARTICIPANTS,
  type WorkflowParticipantId,
} from "@t3tools/contracts";
import {
  clearInvestigatorErrorForPhase,
  findInvestigationCrossReview,
  type InvestigationCrossReviewEdge,
  type InvestigationCrossReviewPatch,
  type InvestigationCrossReviewView,
  investigationCrossReviews,
  investigationCrossReviewsOf,
  investigationInvestigators,
  requireInvestigator,
  sameInvestigationCrossReviewEdge,
  updateInvestigationCrossReview,
  updateInvestigator,
  workflowModelSlotsHaveDuplicate,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import { makeWorkflowArchiveLifecycle } from "../workflowArchiveLifecycle.ts";
import { Cause, Effect, Layer, Scope, Semaphore, Stream } from "effect";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  buildInvestigationCrossReviewPrompt,
  buildInvestigationPrompt,
  buildInvestigationSelfReviewPrompt,
  buildBudgetedInvestigationSynthesisPrompt,
  buildInvestigationSynthesisPrompt,
  type InvestigationSynthesisContributionInput,
  investigationSynthesisShareAtCreation,
} from "../investigationWorkflowPrompts.ts";
import {
  InvestigationWorkflowService,
  type InvestigationWorkflowServiceShape,
} from "../Services/InvestigationWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  getFinishedConsumableLatestTurn,
  hasPriorThreadWork,
  isLatestTurnFinishedAndConsumable,
  latestAssistantFeedback,
  nextWorkflowSlug,
  WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS,
  WORKFLOW_MAX_ACTIVE_REVIEW_TURNS,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "../workflowSharedUtils.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";
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
  buildInvestigationWorkflowRecord,
  investigationCommandInvestigatorFields,
  investigationInputInvestigatorFields,
  investigationInputInvestigatorSlots,
} from "../workflowRecordBuilders.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryOutcome,
} from "../Services/ProviderTurnDeliveryWorker.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
import {
  makeWorkflowStageDispatchResolver,
  STARTUP_DISPATCH_RECHECK_TIMEOUT,
  stageDispatchAllowsTurn,
} from "../workflowStageDispatch.ts";
import {
  isStageAlreadyCompletedWith,
  transitionStageCompleted,
  transitionStageError,
  transitionStagePendingStart,
  transitionStageRunning,
} from "../workflowEngine/WorkflowStageStateMachine.ts";
import {
  createWorkflowStageThread,
  dispatchWorkflowDeleteCompensationCommand,
  liveThreadById,
  readActiveInvestigationWorkflow as readInvestigationWorkflow,
  upsertInvestigationWorkflowRecord as upsertWorkflow,
} from "../workflowEngine/WorkflowThreadCoordinator.ts";

type InvestigationWorkflowTitleGenerationWorkItem = {
  readonly workflowId: InvestigationWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

const CROSS_REVIEW_OUTPUT_NOT_FOUND =
  "Investigator output not found for investigation cross-review.";
const SELF_REVIEW_OUTPUT_NOT_FOUND =
  "Investigator output not found for investigation own-model review.";
const SYNTHESIS_OUTPUT_NOT_FOUND = "Investigation upstream output not found for synthesis.";
const MAX_PROFILE_TIMEOUT_RETRIES = 1;

/** One review turn of the review phase: a directed cross-review edge or an own-model review. */
type InvestigationReviewTask =
  | ({ readonly kind: "cross" } & InvestigationCrossReviewEdge)
  | { readonly kind: "self"; readonly investigatorId: WorkflowParticipantId };

interface InvestigationReviewTaskState {
  readonly status: InvestigationPhaseStatus;
  readonly threadId: ThreadId | null;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly error: string | null;
  readonly retryCount: number;
  readonly dispatchCommandId: CommandId | null;
}

function setInvestigator(
  workflow: InvestigationWorkflow,
  investigatorId: WorkflowParticipantId,
  investigator: InvestigationInvestigator,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...updateInvestigator(workflow, investigatorId, () => investigator),
    updatedAt,
  };
}

function allInvestigationsCompleted(workflow: InvestigationWorkflow): boolean {
  return investigationInvestigators(workflow).every(
    ({ investigator }) => investigator.investigationStatus === "completed",
  );
}

function investigatorLabel(workflow: InvestigationWorkflow, id: WorkflowParticipantId): string {
  return requireInvestigator(workflow, id).label;
}

function investigationMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { investigatorId: WorkflowParticipantId; investigator: InvestigationInvestigator } | null {
  const match = investigationInvestigators(workflow).find(
    ({ investigator }) => investigator.investigationThreadId === threadId,
  );
  return match ? { investigatorId: match.id, investigator: match.investigator } : null;
}

function crossReviewMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): InvestigationCrossReviewView | null {
  return investigationCrossReviews(workflow).find((view) => view.threadId === threadId) ?? null;
}

function selfReviewMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { investigatorId: WorkflowParticipantId; investigator: InvestigationInvestigator } | null {
  const match = investigationInvestigators(workflow).find(
    ({ investigator }) => investigator.selfReviewThreadId === threadId,
  );
  return match ? { investigatorId: match.id, investigator: match.investigator } : null;
}

function crossReviewTitle(
  workflow: InvestigationWorkflow,
  edge: InvestigationCrossReviewEdge,
): string {
  const reviewer = workflowParticipantLabel(edge.reviewerId);
  return workflowUsesMesh(investigationInvestigators(workflow).length)
    ? `Cross-review ${reviewer} on ${workflowParticipantLabel(edge.revieweeId)}`
    : `Cross-review ${reviewer}`;
}

function labelForThread(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { workflow: InvestigationWorkflow; label: string } | null {
  const investigation = investigationMatch(workflow, threadId);
  if (investigation) {
    return {
      workflow,
      label: `Investigator ${workflowParticipantLabel(investigation.investigatorId)}`,
    };
  }
  const crossReview = crossReviewMatch(workflow, threadId);
  if (crossReview) {
    return { workflow, label: crossReviewTitle(workflow, crossReview) };
  }
  const selfReview = selfReviewMatch(workflow, threadId);
  if (selfReview) {
    return {
      workflow,
      label: `Own-model review ${workflowParticipantLabel(selfReview.investigatorId)}`,
    };
  }
  if (workflow.synthesis.threadId === threadId) {
    return { workflow, label: "Synthesis" };
  }
  return null;
}

/** Running stages that recorded the command which dispatched their turn. */
function runningStageDispatches(
  workflow: InvestigationWorkflow,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly dispatchCommandId: CommandId }> {
  const stages: Array<{
    readonly status: string;
    readonly threadId: ThreadId | null;
    readonly dispatchCommandId: CommandId | null | undefined;
  }> = [];
  for (const { investigator } of investigationInvestigators(workflow)) {
    stages.push({
      status: investigator.investigationStatus,
      threadId: investigator.investigationThreadId,
      dispatchCommandId: investigator.investigationDispatchCommandId,
    });
  }
  stages.push(...investigationCrossReviews(workflow));
  for (const { investigator } of investigationInvestigators(workflow)) {
    stages.push({
      status: investigator.selfReviewStatus,
      threadId: investigator.selfReviewThreadId,
      dispatchCommandId: investigator.selfReviewDispatchCommandId,
    });
  }
  stages.push({
    status: workflow.synthesis.status,
    threadId: workflow.synthesis.threadId,
    dispatchCommandId: workflow.synthesis.dispatchCommandId,
  });
  return stages.flatMap((stage) =>
    stage.status === "running" && stage.threadId && stage.dispatchCommandId
      ? [{ threadId: stage.threadId, dispatchCommandId: stage.dispatchCommandId }]
      : [],
  );
}

function withInvestigationRunning(
  workflow: InvestigationWorkflow,
  investigatorId: WorkflowParticipantId,
  updatedAt: string,
  dispatchCommandId: CommandId,
): InvestigationWorkflow {
  const investigator = requireInvestigator(workflow, investigatorId);
  return setInvestigator(
    workflow,
    investigatorId,
    {
      ...investigator,
      investigationStatus: "running",
      investigationDispatchCommandId: dispatchCommandId,
      error: clearInvestigatorErrorForPhase(investigator, "investigation"),
      updatedAt,
    },
    updatedAt,
  );
}

function withInvestigationCompleted(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorId: WorkflowParticipantId;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = requireInvestigator(input.workflow, input.investigatorId);
  if (
    current.investigationStatus === "completed" &&
    current.investigationTurnId === input.turnId &&
    current.investigationMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return setInvestigator(
    input.workflow,
    input.investigatorId,
    {
      ...current,
      investigationStatus: "completed",
      investigationTurnId: input.turnId,
      investigationMessageId: input.assistantMessageId,
      error: clearInvestigatorErrorForPhase(current, "investigation"),
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withInvestigationError(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorId: WorkflowParticipantId;
  readonly error: string;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = requireInvestigator(input.workflow, input.investigatorId);
  return setInvestigator(
    input.workflow,
    input.investigatorId,
    {
      ...current,
      investigationStatus: "error",
      error: input.error,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

/** Review tasks in launch order: cross-reviews by reviewer then reviewee, then own-model reviews. */
function investigationReviewTasks(workflow: InvestigationWorkflow): InvestigationReviewTask[] {
  const tasks: InvestigationReviewTask[] = investigationCrossReviews(workflow).map((view) => ({
    kind: "cross",
    reviewerId: view.reviewerId,
    revieweeId: view.revieweeId,
  }));
  if (workflow.selfReviewEnabled) {
    for (const { id } of investigationInvestigators(workflow)) {
      tasks.push({ kind: "self", investigatorId: id });
    }
  }
  return tasks;
}

function reviewTaskState(
  workflow: InvestigationWorkflow,
  task: InvestigationReviewTask,
): InvestigationReviewTaskState {
  if (task.kind === "cross") {
    const view = findInvestigationCrossReview(workflow, task);
    if (!view) {
      throw new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail: `Investigation has no cross-review of ${workflowParticipantLabel(task.revieweeId)} by ${workflowParticipantLabel(task.reviewerId)}.`,
      });
    }
    return view;
  }
  const investigator = requireInvestigator(workflow, task.investigatorId);
  return {
    status: investigator.selfReviewStatus,
    threadId: investigator.selfReviewThreadId,
    turnId: investigator.selfReviewTurnId,
    messageId: investigator.selfReviewMessageId,
    error: investigator.selfReviewStatus === "error" ? investigator.error : null,
    retryCount: investigator.selfReviewRetryCount ?? 0,
    dispatchCommandId: investigator.selfReviewDispatchCommandId ?? null,
  };
}

/**
 * The one writer for review state. `error: null` clears the review's error (on an
 * investigator's shared field, only when no other phase of it is in error).
 */
function withReviewTask(
  workflow: InvestigationWorkflow,
  task: InvestigationReviewTask,
  patch: InvestigationCrossReviewPatch,
  updatedAt: string,
): InvestigationWorkflow {
  if (task.kind === "cross") {
    return { ...updateInvestigationCrossReview(workflow, task, patch, updatedAt), updatedAt };
  }
  const investigator = requireInvestigator(workflow, task.investigatorId);
  const error =
    patch.error === undefined
      ? investigator.error
      : patch.error === null
        ? clearInvestigatorErrorForPhase(investigator, "selfReview")
        : patch.error;
  return setInvestigator(
    workflow,
    task.investigatorId,
    {
      ...investigator,
      ...(patch.threadId !== undefined ? { selfReviewThreadId: patch.threadId } : {}),
      ...(patch.status !== undefined ? { selfReviewStatus: patch.status } : {}),
      ...(patch.turnId !== undefined ? { selfReviewTurnId: patch.turnId } : {}),
      ...(patch.messageId !== undefined ? { selfReviewMessageId: patch.messageId } : {}),
      ...(patch.retryCount !== undefined ? { selfReviewRetryCount: patch.retryCount } : {}),
      ...(patch.dispatchCommandId !== undefined
        ? { selfReviewDispatchCommandId: patch.dispatchCommandId }
        : {}),
      error,
      updatedAt,
    },
    updatedAt,
  );
}

function withReviewTaskCompleted(input: {
  readonly workflow: InvestigationWorkflow;
  readonly task: InvestigationReviewTask;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = reviewTaskState(input.workflow, input.task);
  if (
    current.status === "completed" &&
    current.turnId === input.turnId &&
    current.messageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return withReviewTask(
    input.workflow,
    input.task,
    {
      status: "completed",
      turnId: input.turnId,
      messageId: input.assistantMessageId,
      error: null,
    },
    input.updatedAt,
  );
}

function allReviewsCompleted(workflow: InvestigationWorkflow): boolean {
  return investigationReviewTasks(workflow).every(
    (task) => reviewTaskState(workflow, task).status === "completed",
  );
}

function withSynthesisPendingStart(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  if (workflow.synthesis.status === "pending_start") {
    return workflow;
  }
  return {
    ...workflow,
    synthesis: transitionStagePendingStart(
      workflow.synthesis,
      workflow.synthesis.threadId,
      updatedAt,
    ),
    updatedAt,
  };
}

function withSynthesisRunning(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
  updatedAt: string,
  dispatchCommandId: CommandId,
): InvestigationWorkflow {
  return {
    ...workflow,
    synthesis: transitionStageRunning(workflow.synthesis, updatedAt, dispatchCommandId, {
      threadId,
    }),
    updatedAt,
  };
}

function withSynthesisThreadPrepared(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    synthesis: {
      ...workflow.synthesis,
      threadId,
      status:
        workflow.synthesis.status === "not_started" ? "pending_start" : workflow.synthesis.status,
      error: null,
      updatedAt,
    },
    updatedAt,
  };
}

function withSynthesisCompleted(input: {
  readonly workflow: InvestigationWorkflow;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow.synthesis;
  if (isStageAlreadyCompletedWith(current, input.turnId, input.assistantMessageId)) {
    return input.workflow;
  }
  return {
    ...input.workflow,
    synthesis: transitionStageCompleted(current, {
      turnId: input.turnId,
      assistantMessageId: input.assistantMessageId,
      updatedAt: input.updatedAt,
    }),
    updatedAt: input.updatedAt,
  };
}

function withSynthesisError(
  workflow: InvestigationWorkflow,
  error: string,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    synthesis: transitionStageError(workflow.synthesis, error, updatedAt),
    updatedAt,
  };
}

const RESET_REVIEW_PATCH: InvestigationCrossReviewPatch = {
  status: "not_started",
  turnId: null,
  messageId: null,
  error: null,
};

function resetCrossReviews(
  workflow: InvestigationWorkflow,
  updatedAt: string,
  only?: (view: InvestigationCrossReviewView) => boolean,
): InvestigationWorkflow {
  let next = workflow;
  for (const view of investigationCrossReviews(workflow)) {
    if (only && !only(view)) continue;
    next = withReviewTask(next, { kind: "cross", ...view }, RESET_REVIEW_PATCH, updatedAt);
  }
  return next;
}

function resetSelfReviews(
  workflow: InvestigationWorkflow,
  updatedAt: string,
  only?: (investigator: InvestigationInvestigator) => boolean,
): InvestigationWorkflow {
  let next = workflow;
  for (const { id, investigator } of investigationInvestigators(workflow)) {
    if (only && !only(investigator)) continue;
    next = withReviewTask(
      next,
      { kind: "self", investigatorId: id },
      RESET_REVIEW_PATCH,
      updatedAt,
    );
  }
  return next;
}

function resetCrossReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  const next = resetCrossReviews(workflow, updatedAt);
  return { ...next, synthesis: resetSynthesis(next.synthesis, updatedAt), updatedAt };
}

function resetSelfReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  const next = resetSelfReviews(workflow, updatedAt);
  return { ...next, synthesis: resetSynthesis(next.synthesis, updatedAt), updatedAt };
}

function resetAllReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  const next = resetSelfReviews(resetCrossReviews(workflow, updatedAt), updatedAt);
  return { ...next, synthesis: resetSynthesis(next.synthesis, updatedAt), updatedAt };
}

function resetSynthesis(
  synthesis: InvestigationWorkflow["synthesis"],
  updatedAt: string,
): InvestigationWorkflow["synthesis"] {
  return {
    ...synthesis,
    status: "not_started",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    error: null,
    updatedAt,
  };
}

function dispatchWorkflowDeleteCompensation(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflowId: InvestigationWorkflowId;
  readonly projectId: InvestigationWorkflow["projectId"];
  readonly createdAt: string;
}) {
  return dispatchWorkflowDeleteCompensationCommand({ kind: "investigation", ...input });
}

/** Creates a phase thread on the investigator's model (investigation and both review kinds). */
function createInvestigatorThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflow: InvestigationWorkflow;
  readonly threadId: ThreadId;
  readonly investigator: InvestigationInvestigator;
  readonly title: string;
  readonly createdAt: string;
}) {
  return createWorkflowStageThread({
    orchestrationEngine: input.orchestrationEngine,
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: input.title,
    model: input.investigator.slot.model,
    branch: input.workflow.branch,
    createdAt: input.createdAt,
  });
}

function investigationPromptInvariant(
  prompt: string,
  artifactLabel: string,
): OrchestrationCommandInvariantError | null {
  return prompt.length <= WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT
    ? null
    : new OrchestrationCommandInvariantError({
        commandType: "workflow.turn.start",
        detail: `${artifactLabel} rendered prompt is ${prompt.length} characters; maximum is ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT}.`,
      });
}

function synthesisShareMessage(investigatorCount: number, share: number): string {
  return `${investigatorCount} investigators leave ${Math.max(0, share)} characters per report; start a new investigation with fewer investigators or a shorter problem statement.`;
}

function startInvestigationTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  readonly investigator: InvestigationInvestigator;
  readonly lensBranch: "a" | "b";
  readonly retry: WorkflowRetryContext;
  readonly createdAt: string;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildInvestigationPrompt({
    workflowId: input.workflow.id,
    problemPrompt: input.workflow.problemPrompt,
    investigatorLabel: input.investigator.label,
    lensBranch: input.lensBranch,
    branch: input.workflow.branch,
    attended:
      resolveWorkflowBehavior({
        runKind: "investigation",
        templateId: input.workflow.templateId,
        templateVersion: input.workflow.templateVersion,
      }).executionProfileForStage("investigation") === "attended-readonly",
    targetSlot: input.investigator.slot,
    retry: input.retry,
    investigatorCount: investigationInvestigators(input.workflow).length,
  });
  const promptError = investigationPromptInvariant(prompt, "Investigation");
  if (promptError) return Effect.fail(promptError);
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.investigator.investigationThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.investigator.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "investigation",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "investigation",
    }),
    createdAt: input.createdAt,
  });
}

function startCrossReviewTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  /** The reviewing investigator, whose model runs the cross-review. */
  readonly investigator: InvestigationInvestigator;
  readonly threadId: ThreadId;
  readonly peerLabel: string;
  readonly peerReport: string;
  readonly retry: WorkflowRetryContext;
  readonly createdAt: string;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildInvestigationCrossReviewPrompt({
    workflowId: input.workflow.id,
    problemPrompt: input.workflow.problemPrompt,
    peerLabel: input.peerLabel,
    peerReport: input.peerReport,
    targetSlot: input.investigator.slot,
    retry: input.retry,
  });
  const promptError = investigationPromptInvariant(prompt, "Investigation cross-review");
  if (promptError) return Effect.fail(promptError);
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.investigator.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "investigation",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "investigation-review",
    }),
    createdAt: input.createdAt,
  });
}

function startSelfReviewTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  readonly investigator: InvestigationInvestigator;
  readonly investigationReport: string;
  readonly retry: WorkflowRetryContext;
  readonly createdAt: string;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildInvestigationSelfReviewPrompt({
    workflowId: input.workflow.id,
    problemPrompt: input.workflow.problemPrompt,
    investigatorLabel: input.investigator.label,
    investigationReport: input.investigationReport,
    investigationTurnId: input.investigator.investigationTurnId ?? undefined,
    investigationMessageId: input.investigator.investigationMessageId ?? undefined,
    targetSlot: input.investigator.slot,
    retry: input.retry,
  });
  const promptError = investigationPromptInvariant(prompt, "Investigation self-review");
  if (promptError) return Effect.fail(promptError);
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.investigator.selfReviewThreadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.investigator.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "investigation",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "investigation-review",
    }),
    createdAt: input.createdAt,
  });
}

function createSynthesisThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflow: InvestigationWorkflow;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}) {
  return createWorkflowStageThread({
    orchestrationEngine: input.orchestrationEngine,
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: "RCA Synthesis",
    model: input.workflow.synthesis.slot.model,
    branch: input.workflow.branch,
    createdAt: input.createdAt,
  });
}

/**
 * The synthesis prompt, or why it cannot be sent (cost limit, too little room per report, size).
 * Checked before the stage is marked running, so a rejected prompt never looks dispatched.
 */
function prepareSynthesisPrompt(input: {
  readonly workflow: InvestigationWorkflow;
  readonly contributions: ReadonlyArray<InvestigationSynthesisContributionInput>;
  readonly retry: WorkflowRetryContext;
}): Effect.Effect<string, Error> {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const promptInput = {
    workflowId: input.workflow.id,
    problemPrompt: input.workflow.problemPrompt,
    targetSlot: input.workflow.synthesis.slot,
    retry: input.retry,
    contributions: input.contributions,
  };
  let prompt: string;
  if (workflowUsesMesh(input.contributions.length)) {
    const budgeted = buildBudgetedInvestigationSynthesisPrompt({
      ...promptInput,
      maxRenderedChars: WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
    });
    if (
      budgeted.smallestExcerpt !== null &&
      budgeted.smallestExcerpt < WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS
    ) {
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: "workflow.turn.start",
          detail: synthesisShareMessage(input.contributions.length, budgeted.smallestExcerpt),
        }),
      );
    }
    prompt = budgeted.prompt;
  } else {
    prompt = buildInvestigationSynthesisPrompt(promptInput);
  }
  const promptError = investigationPromptInvariant(prompt, "Investigation synthesis");
  if (promptError) return Effect.fail(promptError);
  return Effect.succeed(prompt);
}

function startSynthesisTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  readonly prompt: string;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.workflow.synthesis.threadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(input.workflow.synthesis.slot),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "investigation",
      templateId: input.workflow.templateId,
      templateVersion: input.workflow.templateVersion,
      stage: "synthesis",
    }),
    createdAt: input.createdAt,
  });
}

function investigationReport(
  snapshot: OrchestrationReadModel,
  investigator: InvestigationInvestigator,
): string | null {
  const thread = snapshot.threads.find((entry) => entry.id === investigator.investigationThreadId);
  return thread
    ? (latestAssistantFeedback(thread, investigator.investigationMessageId, {
        combinedReasoningHeading: "Investigation reasoning",
      })?.text ?? null)
    : null;
}

function crossReviewReport(
  snapshot: OrchestrationReadModel,
  view: InvestigationCrossReviewView,
): string | null {
  if (view.threadId === null) {
    return null;
  }
  const thread = snapshot.threads.find((entry) => entry.id === view.threadId);
  return thread
    ? (latestAssistantFeedback(thread, view.messageId, {
        combinedReasoningHeading: "Cross-review reasoning",
      })?.text ?? null)
    : null;
}

function selfReviewReport(
  snapshot: OrchestrationReadModel,
  investigator: InvestigationInvestigator,
): string | null {
  if (investigator.selfReviewThreadId === null) {
    return null;
  }
  const thread = snapshot.threads.find((entry) => entry.id === investigator.selfReviewThreadId);
  return thread
    ? (latestAssistantFeedback(thread, investigator.selfReviewMessageId, {
        combinedReasoningHeading: "Own-model review reasoning",
      })?.text ?? null)
    : null;
}

interface CollectedSynthesisContribution {
  readonly label: string;
  readonly investigation: string | null;
  readonly crossReviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly text: string | null;
  }>;
  readonly selfReview: string | null;
}

/** Each investigation with every cross-review of it (reviewer order) and its own-model review. */
function collectSynthesisContributions(
  workflow: InvestigationWorkflow,
  snapshot: OrchestrationReadModel,
): ReadonlyArray<CollectedSynthesisContribution> {
  return investigationInvestigators(workflow).map(({ id, investigator }) => ({
    label: investigator.label,
    investigation: investigationReport(snapshot, investigator),
    crossReviews: investigationCrossReviewsOf(workflow, id).map((view) => ({
      reviewerLabel: investigatorLabel(workflow, view.reviewerId),
      text: crossReviewReport(snapshot, view),
    })),
    selfReview: workflow.selfReviewEnabled ? selfReviewReport(snapshot, investigator) : null,
  }));
}

function isBlank(text: string | null | undefined): boolean {
  return !text || text.trim().length === 0;
}

function synthesisContributionsMissing(
  workflow: InvestigationWorkflow,
  contributions: ReadonlyArray<CollectedSynthesisContribution>,
): boolean {
  return contributions.some(
    (contribution) =>
      isBlank(contribution.investigation) ||
      contribution.crossReviews.length === 0 ||
      contribution.crossReviews.some((review) => isBlank(review.text)) ||
      (workflow.selfReviewEnabled && isBlank(contribution.selfReview)),
  );
}

export const makeInvestigationWorkflowService = Effect.gen(function* () {
  const sources = yield* makeShutdownSourceScope("investigation-workflows-sources");
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const getWorkflowProviders =
    providerRegistry._tag === "Some" ? providerRegistry.value.getProviders : Effect.succeed([]);
  const orchestrationEngine = withWorkflowModelSelectionGuard(
    baseOrchestrationEngine,
    getWorkflowProviders,
  );
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);
  const deliveryRepository = yield* Effect.serviceOption(ProviderTurnDeliveryRepository);
  // Serializes the event fiber, reconciliation and manual retries: each reads a workflow, then
  // writes and launches from that read, so two at once could launch the same queued review.
  const workflowWriteLock = yield* Semaphore.make(1);
  const withWorkflowWriteLock = workflowWriteLock.withPermits(1);
  const resolveStageDispatch = yield* makeWorkflowStageDispatchResolver;

  const titleGenerationWorker = yield* makeBackgroundWorker(
    (item: InvestigationWorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const workflow =
          snapshot.investigationWorkflows.find(
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
          logPrefix: "investigation workflow service",
          logContext: {
            workflowId: item.workflowId,
          },
        });
        if (title === workflow.title) {
          return;
        }

        const latestSnapshot = yield* orchestrationEngine.getReadModel();
        const latestWorkflow =
          latestSnapshot.investigationWorkflows.find(
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
          Effect.logError("InvestigationWorkflowService.titleGenerationWorker failed", {
            workflowId: item.workflowId,
            cause,
          }),
        ),
      ),
    { name: "InvestigationWorkflowService", key: (item) => String(item.workflowId) },
  );

  const startPendingInvestigations = (workflow: InvestigationWorkflow, updatedAt: string) =>
    Effect.gen(function* () {
      if (isArchivedWorkflow(workflow)) return workflow;
      let nextWorkflow = workflow;
      for (const [index, { id: investigatorId }] of investigationInvestigators(
        workflow,
      ).entries()) {
        const investigator = requireInvestigator(nextWorkflow, investigatorId);
        if (investigator.investigationStatus !== "pending") {
          continue;
        }
        let snapshot = yield* orchestrationEngine.getReadModel();
        let investigationThread = liveThreadById(snapshot, investigator.investigationThreadId);
        if (!investigationThread) {
          const createOutcome = yield* Effect.exit(
            createInvestigatorThread({
              orchestrationEngine,
              workflow: nextWorkflow,
              threadId: investigator.investigationThreadId,
              investigator,
              title: `Investigator ${workflowParticipantLabel(investigatorId)}`,
              createdAt: updatedAt,
            }),
          );
          if (createOutcome._tag === "Failure") {
            snapshot = yield* orchestrationEngine.getReadModel();
            investigationThread = liveThreadById(snapshot, investigator.investigationThreadId);
            if (!investigationThread) {
              nextWorkflow = withInvestigationError({
                workflow: nextWorkflow,
                investigatorId,
                error: String(createOutcome.cause),
                updatedAt,
              });
              yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
              continue;
            }
          }
        }
        const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
        const outcome = yield* Effect.exit(
          startInvestigationTurn({
            orchestrationEngine,
            commandId: dispatchCommandId,
            workflow: nextWorkflow,
            investigator,
            lensBranch: index % 2 === 0 ? "a" : "b",
            retry: hasPriorThreadWork(investigationThread)
              ? { kind: "retry", reusedThread: true }
              : { kind: "none" },
            createdAt: updatedAt,
          }),
        );
        if (outcome._tag === "Failure") {
          nextWorkflow = withInvestigationError({
            workflow: nextWorkflow,
            investigatorId,
            error: String(outcome.cause),
            updatedAt,
          });
        } else {
          nextWorkflow = withInvestigationRunning(
            nextWorkflow,
            investigatorId,
            updatedAt,
            dispatchCommandId,
          );
        }
        yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      }
      return nextWorkflow;
    });

  const maybeAdvanceWorkflowFromCompletedThread = (
    workflow: InvestigationWorkflow,
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

      // Running stages only complete with the turn their own dispatch started.
      const runningDispatchAllows = (
        status: string,
        dispatchCommandId: CommandId | null | undefined,
      ) =>
        status === "running"
          ? resolveStageDispatch(dispatchCommandId).pipe(
              Effect.map((dispatch) => stageDispatchAllowsTurn(dispatch, completedTurn.turnId)),
            )
          : Effect.succeed(false);

      const investigation = investigationMatch(workflow, threadId);
      if (
        investigation &&
        ((yield* runningDispatchAllows(
          investigation.investigator.investigationStatus,
          investigation.investigator.investigationDispatchCommandId,
        )) ||
          (investigation.investigator.investigationStatus === "completed" &&
            (investigation.investigator.investigationTurnId === null ||
              investigation.investigator.investigationMessageId === null)))
      ) {
        const nextWorkflow = withInvestigationCompleted({
          workflow,
          investigatorId: investigation.investigatorId,
          turnId: completedTurn.turnId,
          assistantMessageId: completedTurn.assistantMessageId,
          updatedAt,
        });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
        return nextWorkflow;
      }

      const crossReview = crossReviewMatch(workflow, threadId);
      if (
        crossReview &&
        (yield* runningDispatchAllows(crossReview.status, crossReview.dispatchCommandId))
      ) {
        const nextWorkflow = withReviewTaskCompleted({
          workflow,
          task: { kind: "cross", ...crossReview },
          turnId: completedTurn.turnId,
          assistantMessageId: completedTurn.assistantMessageId,
          updatedAt,
        });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
        return nextWorkflow;
      }

      const selfReview = selfReviewMatch(workflow, threadId);
      if (
        selfReview &&
        (yield* runningDispatchAllows(
          selfReview.investigator.selfReviewStatus,
          selfReview.investigator.selfReviewDispatchCommandId,
        ))
      ) {
        const nextWorkflow = withReviewTaskCompleted({
          workflow,
          task: { kind: "self", investigatorId: selfReview.investigatorId },
          turnId: completedTurn.turnId,
          assistantMessageId: completedTurn.assistantMessageId,
          updatedAt,
        });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
        }
        return nextWorkflow;
      }

      if (
        workflow.synthesis.threadId === threadId &&
        (yield* runningDispatchAllows(
          workflow.synthesis.status,
          workflow.synthesis.dispatchCommandId,
        ))
      ) {
        const nextWorkflow = withSynthesisCompleted({
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

  /**
   * Launches the review phase once every investigation is completed: cross-reviews, then
   * own-model reviews, admitted in id order while fewer than `WORKFLOW_MAX_ACTIVE_REVIEW_TURNS`
   * reviews are running. One upsert moves the admitted reviews to `pending_start` with their
   * thread ids; each then gets its own upsert to `running` immediately before its dispatch.
   * Later passes pick up `not_started` and `pending_start` reviews, so queued reviews survive
   * a restart. A review that fails to start frees its slot for the next one in the same call.
   */
  const maybeStartReviews = (
    workflow: InvestigationWorkflow,
    snapshotAtCall: OrchestrationReadModel | null,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        isArchivedWorkflow(workflow) ||
        !allInvestigationsCompleted(workflow)
      ) {
        return workflow;
      }

      let current = workflow;
      let snapshotForPass = snapshotAtCall;
      while (true) {
        const states = investigationReviewTasks(current).map((task) => ({
          task,
          state: reviewTaskState(current, task),
        }));
        const running = states.filter(({ state }) => state.status === "running").length;
        const admitted = states
          .filter(({ state }) => state.status === "not_started" || state.status === "pending_start")
          .slice(0, Math.max(0, WORKFLOW_MAX_ACTIVE_REVIEW_TURNS - running));
        if (admitted.length === 0) {
          return current;
        }

        const snapshot = snapshotForPass ?? (yield* orchestrationEngine.getReadModel());
        snapshotForPass = null;
        const reports = new Map<WorkflowParticipantId, string | null>();
        const reportOf = (id: WorkflowParticipantId) => {
          if (!reports.has(id)) {
            reports.set(id, investigationReport(snapshot, requireInvestigator(current, id)));
          }
          return reports.get(id) ?? null;
        };

        let failures = 0;
        const ready: Array<{
          readonly task: InvestigationReviewTask;
          readonly threadId: ThreadId;
          readonly report: string;
        }> = [];
        let pendingWorkflow = current;
        for (const { task, state } of admitted) {
          const report = reportOf(task.kind === "cross" ? task.revieweeId : task.investigatorId);
          if (!report || report.trim().length === 0) {
            pendingWorkflow = withReviewTask(
              pendingWorkflow,
              task,
              {
                status: "error",
                error:
                  task.kind === "cross"
                    ? CROSS_REVIEW_OUTPUT_NOT_FOUND
                    : SELF_REVIEW_OUTPUT_NOT_FOUND,
              },
              updatedAt,
            );
            failures += 1;
            continue;
          }
          const threadId = state.threadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
          pendingWorkflow = withReviewTask(
            pendingWorkflow,
            task,
            { status: "pending_start", threadId, error: null },
            updatedAt,
          );
          ready.push({ task, threadId, report });
        }
        yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
        current = pendingWorkflow;

        for (const { task, threadId, report } of ready) {
          const owner = requireInvestigator(
            current,
            task.kind === "cross" ? task.reviewerId : task.investigatorId,
          );
          let thread = liveThreadById(snapshot, threadId);
          if (!thread) {
            const createOutcome = yield* Effect.exit(
              createInvestigatorThread({
                orchestrationEngine,
                workflow: current,
                threadId,
                investigator: owner,
                title:
                  task.kind === "cross"
                    ? crossReviewTitle(current, task)
                    : `Own-model review ${workflowParticipantLabel(task.investigatorId)}`,
                createdAt: updatedAt,
              }),
            );
            if (createOutcome._tag === "Failure") {
              const latestSnapshot = yield* orchestrationEngine.getReadModel();
              thread = liveThreadById(latestSnapshot, threadId);
              if (!thread) {
                current = withReviewTask(
                  current,
                  task,
                  {
                    status: "error",
                    error: userFacingCauseMessage(
                      createOutcome.cause,
                      "Could not create the review thread.",
                    ),
                  },
                  updatedAt,
                );
                yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
                failures += 1;
                continue;
              }
            }
          }

          const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
          const runningWorkflow = withReviewTask(
            current,
            task,
            { status: "running", threadId, dispatchCommandId, error: null },
            updatedAt,
          );
          yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
          const retry: WorkflowRetryContext = hasPriorThreadWork(thread)
            ? { kind: "retry", reusedThread: true }
            : { kind: "none" };
          const turnOutcome = yield* Effect.exit(
            task.kind === "cross"
              ? startCrossReviewTurn({
                  orchestrationEngine,
                  commandId: dispatchCommandId,
                  workflow: runningWorkflow,
                  investigator: requireInvestigator(runningWorkflow, task.reviewerId),
                  threadId,
                  peerLabel: investigatorLabel(runningWorkflow, task.revieweeId),
                  peerReport: report,
                  retry,
                  createdAt: updatedAt,
                })
              : startSelfReviewTurn({
                  orchestrationEngine,
                  commandId: dispatchCommandId,
                  workflow: runningWorkflow,
                  investigator: requireInvestigator(runningWorkflow, task.investigatorId),
                  investigationReport: report,
                  retry,
                  createdAt: updatedAt,
                }),
          );
          if (turnOutcome._tag === "Failure") {
            current = withReviewTask(
              runningWorkflow,
              task,
              {
                status: "error",
                error: userFacingCauseMessage(turnOutcome.cause, "Could not start the review."),
              },
              updatedAt,
            );
            yield* upsertWorkflow(orchestrationEngine, current, updatedAt);
            failures += 1;
            continue;
          }
          current = runningWorkflow;
        }

        if (failures === 0) {
          return current;
        }
      }
    });

  const maybeStartSynthesis = (
    workflow: InvestigationWorkflow,
    snapshotAtCall: OrchestrationReadModel | null,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        isArchivedWorkflow(workflow) ||
        !allReviewsCompleted(workflow) ||
        workflow.synthesis.status === "running" ||
        workflow.synthesis.status === "completed" ||
        workflow.synthesis.status === "error"
      ) {
        return workflow;
      }

      let pendingWorkflow = workflow;
      if (workflow.synthesis.status === "not_started") {
        pendingWorkflow = withSynthesisPendingStart(workflow, updatedAt);
        yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
      }

      const snapshot = snapshotAtCall ?? (yield* orchestrationEngine.getReadModel());
      const contributions = collectSynthesisContributions(pendingWorkflow, snapshot);
      if (synthesisContributionsMissing(pendingWorkflow, contributions)) {
        const errorWorkflow = withSynthesisError(
          pendingWorkflow,
          SYNTHESIS_OUTPUT_NOT_FOUND,
          updatedAt,
        );
        yield* upsertWorkflow(orchestrationEngine, errorWorkflow, updatedAt);
        return errorWorkflow;
      }

      const synthesisThreadId =
        pendingWorkflow.synthesis.threadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
      if (pendingWorkflow.synthesis.threadId === null) {
        pendingWorkflow = withSynthesisThreadPrepared(
          pendingWorkflow,
          synthesisThreadId,
          updatedAt,
        );
        yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
      }

      let synthesisThread = liveThreadById(snapshot, synthesisThreadId);
      if (!synthesisThread) {
        const createOutcome = yield* Effect.exit(
          createSynthesisThread({
            orchestrationEngine,
            workflow: pendingWorkflow,
            threadId: synthesisThreadId,
            createdAt: updatedAt,
          }),
        );
        if (createOutcome._tag === "Failure") {
          const latestSnapshot = yield* orchestrationEngine.getReadModel();
          synthesisThread = liveThreadById(latestSnapshot, synthesisThreadId);
          if (!synthesisThread) {
            const errorWorkflow = withSynthesisError(
              pendingWorkflow,
              String(createOutcome.cause),
              updatedAt,
            );
            yield* upsertWorkflow(orchestrationEngine, errorWorkflow, updatedAt);
            return errorWorkflow;
          }
        }
      }

      const prepared = yield* Effect.exit(
        prepareSynthesisPrompt({
          workflow: pendingWorkflow,
          contributions: contributions.map((contribution) => ({
            label: contribution.label,
            investigation: contribution.investigation!,
            crossReviews: contribution.crossReviews.map((review) => ({
              reviewerLabel: review.reviewerLabel,
              text: review.text!,
            })),
            selfReview: contribution.selfReview,
          })),
          retry: hasPriorThreadWork(synthesisThread)
            ? { kind: "retry", reusedThread: true }
            : { kind: "none" },
        }),
      );
      if (prepared._tag === "Failure") {
        const errorWorkflow = withSynthesisError(
          pendingWorkflow,
          String(prepared.cause),
          updatedAt,
        );
        yield* upsertWorkflow(orchestrationEngine, errorWorkflow, updatedAt);
        return errorWorkflow;
      }

      const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
      const runningWorkflow = withSynthesisRunning(
        pendingWorkflow,
        synthesisThreadId,
        updatedAt,
        dispatchCommandId,
      );
      yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
      const turnOutcome = yield* Effect.exit(
        startSynthesisTurn({
          orchestrationEngine,
          commandId: dispatchCommandId,
          workflow: runningWorkflow,
          prompt: prepared.value,
          createdAt: updatedAt,
        }),
      );
      if (turnOutcome._tag === "Failure") {
        const errorWorkflow = withSynthesisError(
          runningWorkflow,
          String(turnOutcome.cause),
          updatedAt,
        );
        yield* upsertWorkflow(orchestrationEngine, errorWorkflow, updatedAt);
        return errorWorkflow;
      }
      return runningWorkflow;
    });

  /**
   * A review that failed only because its source report was missing goes back to
   * `not_started` once that report exists.
   */
  const maybeSelfHealReviewSentinels = (
    workflow: InvestigationWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      let nextWorkflow = workflow;
      for (const task of investigationReviewTasks(workflow)) {
        const state = reviewTaskState(nextWorkflow, task);
        const sentinel =
          task.kind === "cross" ? CROSS_REVIEW_OUTPUT_NOT_FOUND : SELF_REVIEW_OUTPUT_NOT_FOUND;
        if (state.status !== "error" || state.error !== sentinel) {
          continue;
        }
        const sourceReport = investigationReport(
          snapshot,
          requireInvestigator(
            nextWorkflow,
            task.kind === "cross" ? task.revieweeId : task.investigatorId,
          ),
        );
        if (isBlank(sourceReport)) {
          continue;
        }
        nextWorkflow = withReviewTask(
          nextWorkflow,
          task,
          { status: "not_started", error: null },
          updatedAt,
        );
      }
      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      }
      return nextWorkflow;
    });

  const maybeSelfHealSynthesisSentinel = (
    workflow: InvestigationWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        workflow.synthesis.status !== "error" ||
        workflow.synthesis.error !== SYNTHESIS_OUTPUT_NOT_FOUND
      ) {
        return workflow;
      }
      if (
        synthesisContributionsMissing(workflow, collectSynthesisContributions(workflow, snapshot))
      ) {
        return workflow;
      }
      const nextWorkflow = {
        ...workflow,
        synthesis: {
          ...workflow.synthesis,
          status: "not_started" as const,
          error: null,
          updatedAt,
        },
        updatedAt,
      };
      yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      return nextWorkflow;
    });

  const reconcileStuckWorkflow = (
    workflow: InvestigationWorkflow,
    snapshot: OrchestrationReadModel,
  ) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow)) {
        return;
      }
      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow;
      let reconciliationSnapshot = snapshot;

      // A restart can leave a stage's delivery `sending` after its turn
      // finished. Rechecking it against provider history records the
      // acceptance so the completion passes can attribute the turn.
      if (providerTurnDeliveryWorker._tag === "Some") {
        const worker = providerTurnDeliveryWorker.value;
        yield* Effect.forEach(
          runningStageDispatches(workflow),
          ({ threadId, dispatchCommandId }) =>
            getFinishedConsumableLatestTurn(snapshot.threads.find((entry) => entry.id === threadId))
              ? worker.recheck(threadId, dispatchCommandId).pipe(
                  // Bounded: this runs before the event subscription starts.
                  Effect.timeout(STARTUP_DISPATCH_RECHECK_TIMEOUT),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Investigation stage dispatch recheck failed", {
                      threadId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                )
              : Effect.void,
          { discard: true },
        );
      }

      const sessionStillRunning = (
        currentSnapshot: OrchestrationReadModel,
        threadId: ThreadId | null,
      ): boolean => {
        const thread =
          threadId === null ? null : currentSnapshot.threads.find((entry) => entry.id === threadId);
        const sessionStatus = thread?.session?.status ?? null;
        return !!thread && sessionStatus !== "error" && sessionStatus !== "stopped";
      };

      const failLostReviewTurns = (
        current: InvestigationWorkflow,
        currentSnapshot: OrchestrationReadModel,
      ) =>
        Effect.gen(function* () {
          let next = current;
          for (const task of investigationReviewTasks(current)) {
            const state = reviewTaskState(next, task);
            if (state.status !== "running") {
              continue;
            }
            // The launcher saves `running` and the command id before dispatching. With no
            // delivery row for that command, the dispatch never happened: queue it again.
            if (state.dispatchCommandId && deliveryRepository._tag === "Some") {
              const delivery = yield* deliveryRepository.value
                .getByCommandId(state.dispatchCommandId)
                .pipe(Effect.orElseSucceed(() => undefined));
              if (delivery === null) {
                next = withReviewTask(
                  next,
                  task,
                  { status: "pending_start", dispatchCommandId: null, error: null },
                  updatedAt,
                );
                yield* upsertWorkflow(orchestrationEngine, next, next.updatedAt);
                continue;
              }
              // A delivery still waiting to send will start its turn later, whatever the
              // previous session's status says; its outcome settles the review.
              if (delivery?.state === "pending" || delivery?.state === "sending") continue;
            }
            if (sessionStillRunning(currentSnapshot, state.threadId)) {
              continue;
            }
            next = withReviewTask(
              next,
              task,
              {
                status: "error",
                error:
                  task.kind === "cross"
                    ? "Cross-review session was not running during reconciliation."
                    : "Own-model review session was not running during reconciliation.",
              },
              updatedAt,
            );
            yield* upsertWorkflow(orchestrationEngine, next, next.updatedAt);
          }
          return next;
        });

      for (const { investigator } of investigationInvestigators(workflow)) {
        reconciledWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          investigator.investigationThreadId,
          updatedAt,
        );
      }

      reconciledWorkflow = yield* startPendingInvestigations(reconciledWorkflow, updatedAt);
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();

      // Review turns that finished across the restart complete first, so their slots are free.
      for (const task of investigationReviewTasks(reconciledWorkflow)) {
        const threadId = reviewTaskState(reconciledWorkflow, task).threadId;
        if (threadId === null) {
          continue;
        }
        reconciledWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          threadId,
          updatedAt,
        );
      }

      // Reviews whose session died across the restart fail before queued reviews launch.
      reconciledWorkflow = yield* failLostReviewTurns(reconciledWorkflow, reconciliationSnapshot);

      reconciledWorkflow = yield* maybeSelfHealReviewSentinels(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciledWorkflow = yield* maybeStartReviews(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();

      reconciledWorkflow = yield* maybeSelfHealSynthesisSentinel(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciledWorkflow = yield* maybeStartSynthesis(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();

      if (reconciledWorkflow.synthesis.threadId !== null) {
        reconciledWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          reconciledWorkflow.synthesis.threadId,
          updatedAt,
        );
      }

      for (const { id: investigatorId } of investigationInvestigators(reconciledWorkflow)) {
        const investigator = requireInvestigator(reconciledWorkflow, investigatorId);
        if (investigator.investigationStatus !== "running") {
          continue;
        }
        if (!sessionStillRunning(reconciliationSnapshot, investigator.investigationThreadId)) {
          reconciledWorkflow = withInvestigationError({
            workflow: reconciledWorkflow,
            investigatorId,
            error: "Investigation session was not running during reconciliation.",
            updatedAt,
          });
          yield* upsertWorkflow(
            orchestrationEngine,
            reconciledWorkflow,
            reconciledWorkflow.updatedAt,
          );
        }
      }
      if (reconciledWorkflow.synthesis.status === "running") {
        if (!sessionStillRunning(reconciliationSnapshot, reconciledWorkflow.synthesis.threadId)) {
          reconciledWorkflow = withSynthesisError(
            reconciledWorkflow,
            "Synthesis session was not running during reconciliation.",
            updatedAt,
          );
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
    yield* Effect.forEach(snapshot.investigationWorkflows, (workflow) =>
      reconcileStuckWorkflow(workflow, snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("InvestigationWorkflowService.reconcileStuckWorkflow failed", {
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
          const workflow = readModel.investigationWorkflows.find(
            (entry) => !isDeletedWorkflow(entry) && labelForThread(entry, event.payload.threadId),
          );
          if (!workflow) {
            return;
          }

          let nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
            workflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
          );
          nextWorkflow = yield* maybeStartReviews(nextWorkflow, readModel, event.occurredAt);
          yield* maybeStartSynthesis(nextWorkflow, readModel, event.occurredAt);
          return;
        }

        case "thread.session-set": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const matchedWorkflow = readModel.investigationWorkflows.find(
            (entry) => !isDeletedWorkflow(entry) && labelForThread(entry, event.payload.threadId),
          );
          if (!matchedWorkflow) {
            return;
          }
          const workflow = applyWorkflowTurnCost(
            matchedWorkflow,
            event.payload.session.turnCostUsd,
            event.occurredAt,
          );
          if (workflow !== matchedWorkflow) {
            yield* upsertWorkflow(orchestrationEngine, workflow, event.occurredAt);
          }

          const investigation = investigationMatch(workflow, event.payload.threadId);
          if (investigation) {
            if (
              event.payload.session.status === "error" &&
              investigation.investigator.investigationStatus === "running"
            ) {
              if (
                event.payload.session.lastErrorRetryability === "retryable" &&
                (investigation.investigator.investigationRetryCount ?? 0) <
                  MAX_PROFILE_TIMEOUT_RETRIES &&
                workflowBudgetError(workflow) === null
              ) {
                const retryWorkflow = setInvestigator(
                  workflow,
                  investigation.investigatorId,
                  {
                    ...investigation.investigator,
                    investigationStatus: "pending",
                    error: null,
                    investigationRetryCount:
                      (investigation.investigator.investigationRetryCount ?? 0) + 1,
                    updatedAt: event.occurredAt,
                  },
                  event.occurredAt,
                );
                yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
                yield* startPendingInvestigations(retryWorkflow, event.occurredAt);
                return;
              }
              yield* upsertWorkflow(
                orchestrationEngine,
                withInvestigationError({
                  workflow,
                  investigatorId: investigation.investigatorId,
                  error: event.payload.session.lastError ?? "Investigation failed.",
                  updatedAt: event.occurredAt,
                }),
                event.occurredAt,
              );
              return;
            }
            if (
              event.payload.session.status === "ready" &&
              investigation.investigator.investigationStatus === "running" &&
              isLatestTurnFinishedAndConsumable(
                readModel.threads.find((entry) => entry.id === event.payload.threadId),
              )
            ) {
              const nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
                workflow,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              yield* maybeStartReviews(nextWorkflow, readModel, event.occurredAt);
            }
            return;
          }

          const crossReview = crossReviewMatch(workflow, event.payload.threadId);
          const selfReview = crossReview ? null : selfReviewMatch(workflow, event.payload.threadId);
          const reviewTask: InvestigationReviewTask | null = crossReview
            ? {
                kind: "cross",
                reviewerId: crossReview.reviewerId,
                revieweeId: crossReview.revieweeId,
              }
            : selfReview
              ? { kind: "self", investigatorId: selfReview.investigatorId }
              : null;
          if (reviewTask) {
            const reviewState = reviewTaskState(workflow, reviewTask);
            if (event.payload.session.status === "error" && reviewState.status === "running") {
              if (
                event.payload.session.lastErrorRetryability === "retryable" &&
                reviewState.retryCount < MAX_PROFILE_TIMEOUT_RETRIES &&
                workflowBudgetError(workflow) === null
              ) {
                const retryWorkflow = withReviewTask(
                  workflow,
                  reviewTask,
                  {
                    status: "pending_start",
                    error: null,
                    retryCount: reviewState.retryCount + 1,
                  },
                  event.occurredAt,
                );
                yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
                yield* maybeStartReviews(retryWorkflow, readModel, event.occurredAt);
                return;
              }
              const failedWorkflow = withReviewTask(
                workflow,
                reviewTask,
                {
                  status: "error",
                  error:
                    event.payload.session.lastError ??
                    (reviewTask.kind === "cross"
                      ? "Cross-review failed."
                      : "Own-model review failed."),
                },
                event.occurredAt,
              );
              yield* upsertWorkflow(orchestrationEngine, failedWorkflow, event.occurredAt);
              // The failed review frees its slot for the next queued one.
              yield* maybeStartReviews(failedWorkflow, readModel, event.occurredAt);
              return;
            }
            if (
              event.payload.session.status === "ready" &&
              reviewState.status === "running" &&
              isLatestTurnFinishedAndConsumable(
                readModel.threads.find((entry) => entry.id === event.payload.threadId),
              )
            ) {
              let nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
                workflow,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              nextWorkflow = yield* maybeStartReviews(nextWorkflow, readModel, event.occurredAt);
              yield* maybeStartSynthesis(nextWorkflow, readModel, event.occurredAt);
            }
            return;
          }

          if (workflow.synthesis.threadId !== event.payload.threadId) {
            return;
          }
          if (event.payload.session.status === "error" && workflow.synthesis.status === "running") {
            if (
              event.payload.session.lastErrorRetryability === "retryable" &&
              (workflow.synthesis.retryCount ?? 0) < MAX_PROFILE_TIMEOUT_RETRIES &&
              workflowBudgetError(workflow) === null
            ) {
              const retryWorkflow: InvestigationWorkflow = {
                ...workflow,
                synthesis: {
                  ...workflow.synthesis,
                  status: "pending_start",
                  error: null,
                  retryCount: (workflow.synthesis.retryCount ?? 0) + 1,
                  updatedAt: event.occurredAt,
                },
                updatedAt: event.occurredAt,
              };
              yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
              yield* maybeStartSynthesis(retryWorkflow, readModel, event.occurredAt);
              return;
            }
            yield* upsertWorkflow(
              orchestrationEngine,
              withSynthesisError(
                workflow,
                event.payload.session.lastError ?? "Synthesis failed.",
                event.occurredAt,
              ),
              event.occurredAt,
            );
            return;
          }
          if (
            event.payload.session.status === "ready" &&
            workflow.synthesis.status === "running" &&
            isLatestTurnFinishedAndConsumable(
              readModel.threads.find((entry) => entry.id === event.payload.threadId),
            )
          ) {
            yield* maybeAdvanceWorkflowFromCompletedThread(
              workflow,
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
        Effect.logError("InvestigationWorkflowService.handleDomainEvent failed", {
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
      const workflow = readModel.investigationWorkflows.find(
        (entry) =>
          !isDeletedWorkflow(entry) &&
          runningStageDispatches(entry).some(
            (stage) => stage.dispatchCommandId === outcome.commandId,
          ),
      );
      if (!workflow) {
        return;
      }
      const updatedAt = new Date().toISOString();
      let nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
        workflow,
        readModel,
        outcome.threadId,
        updatedAt,
      );
      nextWorkflow = yield* maybeStartReviews(nextWorkflow, readModel, updatedAt);
      yield* maybeStartSynthesis(nextWorkflow, readModel, updatedAt);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("InvestigationWorkflowService.handleDeliveryOutcome failed", {
          commandId: outcome.commandId,
          cause,
        }),
      ),
    );

  const start: InvestigationWorkflowServiceShape["start"] = Effect.gen(function* () {
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
    yield* reconcileStuckWorkflows.pipe(
      withWorkflowWriteLock,
      Effect.catchCause((cause) =>
        Effect.logError("InvestigationWorkflowService.reconcileStuckWorkflows failed", {
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
      Effect.logError("InvestigationWorkflowService.start failed", { cause }).pipe(
        Effect.asVoid,
        Effect.flatMap(() => Effect.failCause(cause)),
      ),
    ),
  );

  const createWorkflow: InvestigationWorkflowServiceShape["createWorkflow"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const requestedInvestigatorSlots = investigationInputInvestigatorSlots(rawInput);
      if (requestedInvestigatorSlots.length > WORKFLOW_MESH_MAX_PARTICIPANTS) {
        return yield* Effect.fail(
          new Error(
            `Investigation workflows support up to ${WORKFLOW_MESH_MAX_PARTICIPANTS} investigators.`,
          ),
        );
      }
      const investigatorSlots = requestedInvestigatorSlots.map((slot) =>
        resolveAvailableWorkflowModelSlot(slot, providers),
      );
      const input = {
        ...rawInput,
        ...investigationInputInvestigatorFields(investigatorSlots),
        synthesis: resolveAvailableWorkflowModelSlot(rawInput.synthesis, providers),
      };
      const behavior = yield* Effect.try({
        try: () =>
          resolveWorkflowBehavior({
            runKind: "investigation",
            templateId: input.templateId,
            templateVersion: input.templateVersion ?? LATEST_WORKFLOW_TEMPLATE_VERSION,
          }),
        catch: () =>
          new UnsupportedWorkflowTemplateError(
            "investigation",
            input.templateId ?? "builtin.investigation.dual",
            input.templateVersion ?? 2,
          ),
      });
      yield* Effect.try({
        try: () => {
          for (const slot of investigatorSlots) {
            assertWorkflowStageProviderSupported({
              behavior,
              stage: "investigation",
              provider: slot.provider,
              providers,
            });
          }
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "synthesis",
            provider: input.synthesis.provider,
            providers,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
      if (workflowModelSlotsHaveDuplicate(investigatorSlots)) {
        return yield* Effect.fail(
          new Error(
            investigatorSlots.length === 2
              ? "Investigation investigator models must be different."
              : "Investigation workflows need a different model for every investigator.",
          ),
        );
      }
      const selfReviewEnabled = input.selfReviewEnabled ?? false;
      const snapshot = yield* orchestrationEngine.getReadModel();
      const existingSlugs = new Set(
        snapshot.investigationWorkflows
          .filter(
            (workflow) => workflow.projectId === input.projectId && workflow.deletedAt === null,
          )
          .map((workflow) => workflow.slug),
      );
      const now = new Date().toISOString();
      const workflowId = InvestigationWorkflowId.makeUnsafe(crypto.randomUUID());
      const investigators = investigatorSlots.map((slot) => ({
        slot,
        threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
      }));
      const titleSourceText = input.branch
        ? `Branch: ${input.branch}\n\n${input.problemPrompt}`
        : input.problemPrompt;
      const initialTitle =
        input.title ??
        buildFallbackTitle({
          titleSourceText,
          attachments: [],
          defaultTitle: "New investigation",
        });
      const slug = nextWorkflowSlug(existingSlugs, initialTitle);
      const workflow = buildInvestigationWorkflowRecord({
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        problemPrompt: input.problemPrompt,
        branch: input.branch ?? null,
        selfReviewEnabled,
        createdAt: now,
        investigators,
        synthesis: input.synthesis,
        maxCostUsd: input.maxCostUsd,
      });
      const synthesisShare = investigationSynthesisShareAtCreation({
        problemPrompt: input.problemPrompt,
        investigatorLabels: investigationInvestigators(workflow).map(
          ({ investigator }) => investigator.label,
        ),
        selfReviewEnabled,
        synthesisSlot: input.synthesis,
        renderedMessageCharLimit: WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
      });
      if (synthesisShare !== null && synthesisShare < WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS) {
        return yield* Effect.fail(
          new Error(synthesisShareMessage(investigatorSlots.length, synthesisShare)),
        );
      }

      yield* orchestrationEngine.dispatch({
        type: "project.investigation-workflow.create",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        problemPrompt: input.problemPrompt,
        branch: input.branch ?? null,
        selfReviewEnabled,
        ...investigationCommandInvestigatorFields(investigators),
        synthesis: input.synthesis,
        maxCostUsd: input.maxCostUsd ?? null,
        createdAt: now,
      });

      yield* Effect.all(
        investigationInvestigators(workflow).map(({ id, investigator }) =>
          createInvestigatorThread({
            orchestrationEngine,
            workflow,
            threadId: investigator.investigationThreadId,
            investigator,
            title: `Investigator ${workflowParticipantLabel(id)}`,
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

      // Under the write lock, like the event handler: a completion that lands while later
      // investigators start must not be overwritten by this pass's earlier read.
      yield* withWorkflowWriteLock(
        Effect.gen(function* () {
          const stored = yield* readInvestigationWorkflow(orchestrationEngine, workflowId);
          if (stored) yield* startPendingInvestigations(stored, new Date().toISOString());
        }),
      );
      if (input.title === undefined) {
        yield* titleGenerationWorker.enqueue({
          workflowId,
          titleSourceText,
          expectedCurrentTitle: initialTitle,
          titleGenerationModel: input.titleGenerationModel,
          defaultTitle: "New investigation",
        });
      }
      return workflowId;
    }).pipe(
      Effect.mapError((error) => new Error(error instanceof Error ? error.message : String(error))),
    );

  const deleteWorkflow: InvestigationWorkflowServiceShape["deleteWorkflow"] = (
    workflowId,
    deleteThreads = false,
  ) =>
    changeWorkflowArchive.delete(
      workflowId,
      Effect.gen(function* () {
        const workflow = yield* readInvestigationWorkflow(orchestrationEngine, workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
        }
        const result = yield* orchestrationEngine.dispatch({
          type: "project.investigation-workflow.delete",
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

  const changeWorkflowArchive = makeWorkflowArchiveLifecycle(orchestrationEngine, "investigation");

  const archiveWorkflow: InvestigationWorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.archive(workflowId);

  const unarchiveWorkflow: InvestigationWorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.unarchive(workflowId, () =>
      // Read under the lock: a launch that ran while this waited must not be reconciled from a
      // stale record and written over.
      withWorkflowWriteLock(
        Effect.gen(function* () {
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow = snapshot.investigationWorkflows.find((entry) => entry.id === workflowId);
          if (workflow) yield* reconcileStuckWorkflow(workflow, snapshot);
        }),
      ),
    );

  const retryWorkflow: InvestigationWorkflowServiceShape["retryWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* readInvestigationWorkflow(orchestrationEngine, input.workflowId).pipe(
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
      let nextWorkflow = workflow;
      const scope = input.scope ?? "failed";
      const investigators = investigationInvestigators(workflow);
      const allInvestigationsNoun = investigators.length === 2 ? "Both" : "All";
      if (scope === "crossReview") {
        if (!allInvestigationsCompleted(workflow)) {
          return yield* Effect.fail(
            new Error(
              `${allInvestigationsNoun} investigations must be completed before retrying cross-review.`,
            ),
          );
        }
        nextWorkflow = resetCrossReviewsAndSynthesis(workflow, updatedAt);
      } else if (scope === "selfReview") {
        if (!workflow.selfReviewEnabled || !allInvestigationsCompleted(workflow)) {
          return yield* Effect.fail(
            new Error(
              `${allInvestigationsNoun} investigations must be completed before retrying own-model review.`,
            ),
          );
        }
        nextWorkflow = resetSelfReviewsAndSynthesis(workflow, updatedAt);
      } else if (scope === "synthesis") {
        if (!allReviewsCompleted(workflow)) {
          return yield* Effect.fail(
            new Error("All required reviews must be completed before retrying synthesis."),
          );
        }
        nextWorkflow = {
          ...workflow,
          synthesis: resetSynthesis(workflow.synthesis, updatedAt),
          updatedAt,
        };
      } else {
        // `failed` reruns only what errored. An errored investigation still resets every
        // review, since each review reads investigation reports.
        for (const { id, investigator } of investigators) {
          if (investigator.investigationStatus !== "error") continue;
          nextWorkflow = setInvestigator(
            nextWorkflow,
            id,
            {
              ...requireInvestigator(nextWorkflow, id),
              investigationStatus: "pending",
              investigationTurnId: null,
              investigationMessageId: null,
              error: null,
              updatedAt,
            },
            updatedAt,
          );
        }
        const resetInvestigation = investigators.some(
          ({ investigator }) => investigator.investigationStatus === "error",
        );
        if (resetInvestigation) {
          nextWorkflow = resetAllReviewsAndSynthesis(nextWorkflow, updatedAt);
        } else {
          const erroredCrossReviews = investigationCrossReviews(workflow).filter(
            (view) => view.status === "error",
          );
          const erroredSelfReviews = investigators.filter(
            ({ investigator }) => investigator.selfReviewStatus === "error",
          );
          nextWorkflow = resetCrossReviews(nextWorkflow, updatedAt, (view) =>
            erroredCrossReviews.some((errored) => sameInvestigationCrossReviewEdge(errored, view)),
          );
          for (const { id } of erroredSelfReviews) {
            nextWorkflow = withReviewTask(
              nextWorkflow,
              { kind: "self", investigatorId: id },
              RESET_REVIEW_PATCH,
              updatedAt,
            );
          }
          nextWorkflow = {
            ...nextWorkflow,
            synthesis:
              erroredCrossReviews.length > 0 ||
              erroredSelfReviews.length > 0 ||
              workflow.synthesis.status === "error"
                ? resetSynthesis(nextWorkflow.synthesis, updatedAt)
                : nextWorkflow.synthesis,
            updatedAt,
          };
        }
      }

      yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      nextWorkflow = yield* startPendingInvestigations(nextWorkflow, updatedAt);
      const snapshot = yield* orchestrationEngine.getReadModel();
      nextWorkflow = yield* maybeStartReviews(nextWorkflow, snapshot, updatedAt);
      yield* maybeStartSynthesis(nextWorkflow, snapshot, updatedAt);
    }).pipe(withWorkflowWriteLock);

  const workflowForThread: InvestigationWorkflowServiceShape["workflowForThread"] = (threadId) =>
    orchestrationEngine.getReadModel().pipe(
      Effect.map((snapshot) => {
        for (const workflow of snapshot.investigationWorkflows) {
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
        Effect.logWarning(
          "InvestigationWorkflowService.workflowForThread: snapshot lookup failed",
          {
            threadId,
            cause: error,
          },
        ),
      ),
      Effect.orElseSucceed(() => null),
    );

  yield* registerShutdown(
    "investigation-workflows-titles",
    "drain",
    () => titleGenerationWorker.drain,
    ["provider-ingestion"],
  );

  yield* Effect.addFinalizer(() => sources.stop);

  return {
    start,
    drain: titleGenerationWorker.drain,
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    workflowForThread,
  } satisfies InvestigationWorkflowServiceShape;
});

export const InvestigationWorkflowServiceLive = Layer.effect(
  InvestigationWorkflowService,
  makeInvestigationWorkflowService,
);
