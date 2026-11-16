import { timeOrderedUuid } from "@t3tools/shared/ids";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import {
  CommandId,
  InvestigationWorkflowId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type InvestigationInvestigator,
  type InvestigationWorkflow,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import { makeWorkflowArchiveLifecycle } from "../workflowArchiveLifecycle.ts";
import { Cause, Effect, Layer, Scope, Stream } from "effect";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  buildInvestigationCrossReviewPrompt,
  buildInvestigationPrompt,
  buildInvestigationSelfReviewPrompt,
  buildInvestigationSynthesisPrompt,
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
import { buildInvestigationWorkflowRecord } from "../workflowRecordBuilders.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryOutcome,
} from "../Services/ProviderTurnDeliveryWorker.ts";
import {
  makeWorkflowStageDispatchResolver,
  STARTUP_DISPATCH_RECHECK_TIMEOUT,
  stageDispatchAllowsTurn,
} from "../workflowStageDispatch.ts";

type InvestigatorKey = "investigatorA" | "investigatorB";
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

function peerKey(key: InvestigatorKey): InvestigatorKey {
  return key === "investigatorA" ? "investigatorB" : "investigatorA";
}

function updateInvestigator(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  investigator: InvestigationInvestigator,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    [investigatorKey]: investigator,
    updatedAt,
  };
}

function clearInvestigatorErrorForPhase(
  investigator: InvestigationInvestigator,
  phase: "investigation" | "crossReview" | "selfReview",
): string | null {
  const hasOtherPhaseError =
    (phase !== "investigation" && investigator.investigationStatus === "error") ||
    (phase !== "crossReview" && investigator.crossReviewStatus === "error") ||
    (phase !== "selfReview" && investigator.selfReviewStatus === "error");
  return hasOtherPhaseError ? investigator.error : null;
}

function readInvestigationWorkflow(
  orchestrationEngine: OrchestrationEngineShape,
  workflowId: InvestigationWorkflowId,
) {
  return orchestrationEngine
    .getReadModel()
    .pipe(
      Effect.map(
        (snapshot) =>
          snapshot.investigationWorkflows.find(
            (workflow) => workflow.id === workflowId && workflow.deletedAt === null,
          ) ?? null,
      ),
    );
}

function investigationMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { investigatorKey: InvestigatorKey; investigator: InvestigationInvestigator } | null {
  if (workflow.investigatorA.investigationThreadId === threadId) {
    return { investigatorKey: "investigatorA", investigator: workflow.investigatorA };
  }
  if (workflow.investigatorB.investigationThreadId === threadId) {
    return { investigatorKey: "investigatorB", investigator: workflow.investigatorB };
  }
  return null;
}

function crossReviewMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { investigatorKey: InvestigatorKey; investigator: InvestigationInvestigator } | null {
  if (workflow.investigatorA.crossReviewThreadId === threadId) {
    return { investigatorKey: "investigatorA", investigator: workflow.investigatorA };
  }
  if (workflow.investigatorB.crossReviewThreadId === threadId) {
    return { investigatorKey: "investigatorB", investigator: workflow.investigatorB };
  }
  return null;
}

function selfReviewMatch(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { investigatorKey: InvestigatorKey; investigator: InvestigationInvestigator } | null {
  if (workflow.investigatorA.selfReviewThreadId === threadId) {
    return { investigatorKey: "investigatorA", investigator: workflow.investigatorA };
  }
  if (workflow.investigatorB.selfReviewThreadId === threadId) {
    return { investigatorKey: "investigatorB", investigator: workflow.investigatorB };
  }
  return null;
}

function labelForThread(
  workflow: InvestigationWorkflow,
  threadId: ThreadId,
): { workflow: InvestigationWorkflow; label: string } | null {
  if (workflow.investigatorA.investigationThreadId === threadId) {
    return { workflow, label: "Investigator A" };
  }
  if (workflow.investigatorB.investigationThreadId === threadId) {
    return { workflow, label: "Investigator B" };
  }
  if (workflow.investigatorA.crossReviewThreadId === threadId) {
    return { workflow, label: "Cross-review A" };
  }
  if (workflow.investigatorB.crossReviewThreadId === threadId) {
    return { workflow, label: "Cross-review B" };
  }
  if (workflow.investigatorA.selfReviewThreadId === threadId) {
    return { workflow, label: "Own-model review A" };
  }
  if (workflow.investigatorB.selfReviewThreadId === threadId) {
    return { workflow, label: "Own-model review B" };
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
  for (const investigator of [workflow.investigatorA, workflow.investigatorB]) {
    stages.push(
      {
        status: investigator.investigationStatus,
        threadId: investigator.investigationThreadId,
        dispatchCommandId: investigator.investigationDispatchCommandId,
      },
      {
        status: investigator.crossReviewStatus,
        threadId: investigator.crossReviewThreadId,
        dispatchCommandId: investigator.crossReviewDispatchCommandId,
      },
      {
        status: investigator.selfReviewStatus,
        threadId: investigator.selfReviewThreadId,
        dispatchCommandId: investigator.selfReviewDispatchCommandId,
      },
    );
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
  investigatorKey: InvestigatorKey,
  updatedAt: string,
  dispatchCommandId: CommandId,
): InvestigationWorkflow {
  const investigator = workflow[investigatorKey];
  return updateInvestigator(
    workflow,
    investigatorKey,
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
  readonly investigatorKey: InvestigatorKey;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  if (
    current.investigationStatus === "completed" &&
    current.investigationTurnId === input.turnId &&
    current.investigationMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
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
  readonly investigatorKey: InvestigatorKey;
  readonly error: string;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
    {
      ...current,
      investigationStatus: "error",
      error: input.error,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withCrossReviewPendingStart(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  updatedAt: string,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  if (current.crossReviewStatus === "pending_start") {
    return workflow;
  }
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      crossReviewStatus: "pending_start",
      error: clearInvestigatorErrorForPhase(current, "crossReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withCrossReviewRunning(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  threadId: ThreadId,
  updatedAt: string,
  dispatchCommandId: CommandId,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      crossReviewThreadId: threadId,
      crossReviewStatus: "running",
      crossReviewDispatchCommandId: dispatchCommandId,
      error: clearInvestigatorErrorForPhase(current, "crossReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withCrossReviewThreadPrepared(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  threadId: ThreadId,
  updatedAt: string,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      crossReviewThreadId: threadId,
      crossReviewStatus:
        current.crossReviewStatus === "not_started" ? "pending_start" : current.crossReviewStatus,
      error: clearInvestigatorErrorForPhase(current, "crossReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withCrossReviewCompleted(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorKey: InvestigatorKey;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  if (
    current.crossReviewStatus === "completed" &&
    current.crossReviewTurnId === input.turnId &&
    current.crossReviewMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
    {
      ...current,
      crossReviewStatus: "completed",
      crossReviewTurnId: input.turnId,
      crossReviewMessageId: input.assistantMessageId,
      error: clearInvestigatorErrorForPhase(current, "crossReview"),
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withCrossReviewError(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorKey: InvestigatorKey;
  readonly error: string;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
    {
      ...current,
      crossReviewStatus: "error",
      error: input.error,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withSelfReviewPendingStart(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  updatedAt: string,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  if (current.selfReviewStatus === "pending_start") {
    return workflow;
  }
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      selfReviewStatus: "pending_start",
      error: clearInvestigatorErrorForPhase(current, "selfReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withSelfReviewRunning(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  threadId: ThreadId,
  updatedAt: string,
  dispatchCommandId: CommandId,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      selfReviewThreadId: threadId,
      selfReviewStatus: "running",
      selfReviewDispatchCommandId: dispatchCommandId,
      error: clearInvestigatorErrorForPhase(current, "selfReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withSelfReviewThreadPrepared(
  workflow: InvestigationWorkflow,
  investigatorKey: InvestigatorKey,
  threadId: ThreadId,
  updatedAt: string,
): InvestigationWorkflow {
  const current = workflow[investigatorKey];
  return updateInvestigator(
    workflow,
    investigatorKey,
    {
      ...current,
      selfReviewThreadId: threadId,
      selfReviewStatus:
        current.selfReviewStatus === "not_started" ? "pending_start" : current.selfReviewStatus,
      error: clearInvestigatorErrorForPhase(current, "selfReview"),
      updatedAt,
    },
    updatedAt,
  );
}

function withSelfReviewCompleted(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorKey: InvestigatorKey;
  readonly turnId: string | null;
  readonly assistantMessageId: string | null;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  if (
    current.selfReviewStatus === "completed" &&
    current.selfReviewTurnId === input.turnId &&
    current.selfReviewMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
    {
      ...current,
      selfReviewStatus: "completed",
      selfReviewTurnId: input.turnId,
      selfReviewMessageId: input.assistantMessageId,
      error: clearInvestigatorErrorForPhase(current, "selfReview"),
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
  );
}

function withSelfReviewError(input: {
  readonly workflow: InvestigationWorkflow;
  readonly investigatorKey: InvestigatorKey;
  readonly error: string;
  readonly updatedAt: string;
}): InvestigationWorkflow {
  const current = input.workflow[input.investigatorKey];
  return updateInvestigator(
    input.workflow,
    input.investigatorKey,
    {
      ...current,
      selfReviewStatus: "error",
      error: input.error,
      updatedAt: input.updatedAt,
    },
    input.updatedAt,
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
    synthesis: {
      ...workflow.synthesis,
      status: "pending_start",
      error: null,
      updatedAt,
    },
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
    synthesis: {
      ...workflow.synthesis,
      threadId,
      status: "running",
      dispatchCommandId,
      error: null,
      updatedAt,
    },
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
  if (
    current.status === "completed" &&
    current.pinnedTurnId === input.turnId &&
    current.pinnedAssistantMessageId === input.assistantMessageId
  ) {
    return input.workflow;
  }
  return {
    ...input.workflow,
    synthesis: {
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

function withSynthesisError(
  workflow: InvestigationWorkflow,
  error: string,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    synthesis: {
      ...workflow.synthesis,
      status: "error",
      error,
      updatedAt,
    },
    updatedAt,
  };
}

function resetCrossReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    investigatorA: resetCrossReview(workflow.investigatorA, updatedAt),
    investigatorB: resetCrossReview(workflow.investigatorB, updatedAt),
    synthesis: resetSynthesis(workflow.synthesis, updatedAt),
    updatedAt,
  };
}

function resetSelfReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    investigatorA: resetSelfReview(workflow.investigatorA, updatedAt),
    investigatorB: resetSelfReview(workflow.investigatorB, updatedAt),
    synthesis: resetSynthesis(workflow.synthesis, updatedAt),
    updatedAt,
  };
}

function resetAllReviewsAndSynthesis(
  workflow: InvestigationWorkflow,
  updatedAt: string,
): InvestigationWorkflow {
  return {
    ...workflow,
    investigatorA: resetSelfReview(resetCrossReview(workflow.investigatorA, updatedAt), updatedAt),
    investigatorB: resetSelfReview(resetCrossReview(workflow.investigatorB, updatedAt), updatedAt),
    synthesis: resetSynthesis(workflow.synthesis, updatedAt),
    updatedAt,
  };
}

function resetCrossReview(
  investigator: InvestigationInvestigator,
  updatedAt: string,
): InvestigationInvestigator {
  return {
    ...investigator,
    crossReviewStatus: "not_started",
    crossReviewTurnId: null,
    crossReviewMessageId: null,
    error: clearInvestigatorErrorForPhase(investigator, "crossReview"),
    updatedAt,
  };
}

function resetSelfReview(
  investigator: InvestigationInvestigator,
  updatedAt: string,
): InvestigationInvestigator {
  return {
    ...investigator,
    selfReviewStatus: "not_started",
    selfReviewTurnId: null,
    selfReviewMessageId: null,
    error: clearInvestigatorErrorForPhase(investigator, "selfReview"),
    updatedAt,
  };
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

function upsertWorkflow(
  orchestrationEngine: OrchestrationEngineShape,
  workflow: InvestigationWorkflow,
  updatedAt: string,
) {
  return orchestrationEngine.dispatch({
    type: "project.investigation-workflow.upsert",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    projectId: workflow.projectId,
    workflow,
    updatedAt,
  });
}

function dispatchWorkflowDeleteCompensation(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflowId: InvestigationWorkflowId;
  readonly projectId: InvestigationWorkflow["projectId"];
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "project.investigation-workflow.delete",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    workflowId: input.workflowId,
    projectId: input.projectId,
    createdAt: input.createdAt,
  });
}

function createInvestigationThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflow: InvestigationWorkflow;
  readonly threadId: ThreadId;
  readonly investigator: InvestigationInvestigator;
  readonly title: string;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: input.title,
    model: input.investigator.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
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

function createCrossReviewThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflow: InvestigationWorkflow;
  readonly threadId: ThreadId;
  readonly investigator: InvestigationInvestigator;
  readonly title: string;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: input.title,
    model: input.investigator.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
    createdAt: input.createdAt,
  });
}

function startCrossReviewTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  readonly investigator: InvestigationInvestigator;
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
    threadId: input.investigator.crossReviewThreadId!,
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

function createSelfReviewThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly workflow: InvestigationWorkflow;
  readonly threadId: ThreadId;
  readonly investigator: InvestigationInvestigator;
  readonly title: string;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: input.title,
    model: input.investigator.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
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
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.workflow.projectId,
    title: "RCA Synthesis",
    model: input.workflow.synthesis.slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.workflow.branch,
    worktreePath: null,
    createdAt: input.createdAt,
  });
}

function startSynthesisTurn(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandId: CommandId;
  readonly workflow: InvestigationWorkflow;
  readonly contributions: ReadonlyArray<{
    readonly label: string;
    readonly investigation: string;
    readonly crossReviewOfThis: string;
    readonly selfReview?: string | null;
  }>;
  readonly retry: WorkflowRetryContext;
  readonly createdAt: string;
}) {
  const budgetError = workflowBudgetError(input.workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildInvestigationSynthesisPrompt({
    workflowId: input.workflow.id,
    problemPrompt: input.workflow.problemPrompt,
    targetSlot: input.workflow.synthesis.slot,
    retry: input.retry,
    contributions: input.contributions,
  });
  const promptError = investigationPromptInvariant(prompt, "Investigation synthesis");
  if (promptError) return Effect.fail(promptError);
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.workflow.synthesis.threadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
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
  investigator: InvestigationInvestigator,
): string | null {
  if (investigator.crossReviewThreadId === null) {
    return null;
  }
  const thread = snapshot.threads.find((entry) => entry.id === investigator.crossReviewThreadId);
  return thread
    ? (latestAssistantFeedback(thread, investigator.crossReviewMessageId, {
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

function collectSynthesisContributions(
  workflow: InvestigationWorkflow,
  snapshot: OrchestrationReadModel,
): ReadonlyArray<{
  readonly label: string;
  readonly investigation: string | null;
  readonly crossReviewOfThis: string | null;
  readonly selfReview: string | null;
}> {
  return [
    {
      label: workflow.investigatorA.label,
      investigation: investigationReport(snapshot, workflow.investigatorA),
      crossReviewOfThis: crossReviewReport(snapshot, workflow.investigatorB),
      selfReview: workflow.selfReviewEnabled
        ? selfReviewReport(snapshot, workflow.investigatorA)
        : null,
    },
    {
      label: workflow.investigatorB.label,
      investigation: investigationReport(snapshot, workflow.investigatorB),
      crossReviewOfThis: crossReviewReport(snapshot, workflow.investigatorA),
      selfReview: workflow.selfReviewEnabled
        ? selfReviewReport(snapshot, workflow.investigatorB)
        : null,
    },
  ];
}

function liveThreadById(snapshot: OrchestrationReadModel, threadId: ThreadId) {
  return (
    snapshot.threads.find((thread) => thread.id === threadId && thread.deletedAt === null) ?? null
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
      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = nextWorkflow[investigatorKey];
        if (investigator.investigationStatus !== "pending") {
          continue;
        }
        let snapshot = yield* orchestrationEngine.getReadModel();
        let investigationThread = liveThreadById(snapshot, investigator.investigationThreadId);
        if (!investigationThread) {
          const createOutcome = yield* Effect.exit(
            createInvestigationThread({
              orchestrationEngine,
              workflow: nextWorkflow,
              threadId: investigator.investigationThreadId,
              investigator,
              title: investigatorKey === "investigatorA" ? "Investigator A" : "Investigator B",
              createdAt: updatedAt,
            }),
          );
          if (createOutcome._tag === "Failure") {
            snapshot = yield* orchestrationEngine.getReadModel();
            investigationThread = liveThreadById(snapshot, investigator.investigationThreadId);
            if (!investigationThread) {
              nextWorkflow = withInvestigationError({
                workflow: nextWorkflow,
                investigatorKey,
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
            lensBranch: investigatorKey === "investigatorA" ? "a" : "b",
            retry: hasPriorThreadWork(investigationThread)
              ? { kind: "retry", reusedThread: true }
              : { kind: "none" },
            createdAt: updatedAt,
          }),
        );
        if (outcome._tag === "Failure") {
          nextWorkflow = withInvestigationError({
            workflow: nextWorkflow,
            investigatorKey,
            error: String(outcome.cause),
            updatedAt,
          });
        } else {
          nextWorkflow = withInvestigationRunning(
            nextWorkflow,
            investigatorKey,
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
          investigatorKey: investigation.investigatorKey,
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
        (yield* runningDispatchAllows(
          crossReview.investigator.crossReviewStatus,
          crossReview.investigator.crossReviewDispatchCommandId,
        ))
      ) {
        const nextWorkflow = withCrossReviewCompleted({
          workflow,
          investigatorKey: crossReview.investigatorKey,
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
        const nextWorkflow = withSelfReviewCompleted({
          workflow,
          investigatorKey: selfReview.investigatorKey,
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

  const maybeStartCrossReviews = (
    workflow: InvestigationWorkflow,
    snapshotAtCall: OrchestrationReadModel | null,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        isArchivedWorkflow(workflow) ||
        workflow.investigatorA.investigationStatus !== "completed" ||
        workflow.investigatorB.investigationStatus !== "completed"
      ) {
        return workflow;
      }

      let nextWorkflow = workflow;
      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = nextWorkflow[investigatorKey];
        if (
          investigator.crossReviewStatus === "running" ||
          investigator.crossReviewStatus === "completed" ||
          investigator.crossReviewStatus === "error"
        ) {
          continue;
        }

        let pendingWorkflow = nextWorkflow;
        if (investigator.crossReviewStatus === "not_started") {
          pendingWorkflow = withCrossReviewPendingStart(nextWorkflow, investigatorKey, updatedAt);
          yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
        }

        let pendingInvestigator = pendingWorkflow[investigatorKey];
        const peer = pendingWorkflow[peerKey(investigatorKey)];
        const snapshot = snapshotAtCall ?? (yield* orchestrationEngine.getReadModel());
        const peerReport = investigationReport(snapshot, peer);
        if (!peerReport || peerReport.trim().length === 0) {
          nextWorkflow = withCrossReviewError({
            workflow: pendingWorkflow,
            investigatorKey,
            error: CROSS_REVIEW_OUTPUT_NOT_FOUND,
            updatedAt,
          });
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
          continue;
        }

        const crossReviewThreadId =
          pendingInvestigator.crossReviewThreadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
        if (pendingInvestigator.crossReviewThreadId === null) {
          pendingWorkflow = withCrossReviewThreadPrepared(
            pendingWorkflow,
            investigatorKey,
            crossReviewThreadId,
            updatedAt,
          );
          pendingInvestigator = pendingWorkflow[investigatorKey];
          yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
        }

        let crossReviewThread = liveThreadById(snapshot, crossReviewThreadId);
        if (!crossReviewThread) {
          const createOutcome = yield* Effect.exit(
            createCrossReviewThread({
              orchestrationEngine,
              workflow: pendingWorkflow,
              threadId: crossReviewThreadId,
              investigator: pendingInvestigator,
              title: investigatorKey === "investigatorA" ? "Cross-review A" : "Cross-review B",
              createdAt: updatedAt,
            }),
          );
          if (createOutcome._tag === "Failure") {
            const latestSnapshot = yield* orchestrationEngine.getReadModel();
            crossReviewThread = liveThreadById(latestSnapshot, crossReviewThreadId);
            if (!crossReviewThread) {
              nextWorkflow = withCrossReviewError({
                workflow: pendingWorkflow,
                investigatorKey,
                error: String(createOutcome.cause),
                updatedAt,
              });
              yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
              continue;
            }
          }
        }

        const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
        const runningWorkflow = withCrossReviewRunning(
          pendingWorkflow,
          investigatorKey,
          crossReviewThreadId,
          updatedAt,
          dispatchCommandId,
        );
        yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
        const turnOutcome = yield* Effect.exit(
          startCrossReviewTurn({
            orchestrationEngine,
            commandId: dispatchCommandId,
            workflow: runningWorkflow,
            investigator: runningWorkflow[investigatorKey],
            peerLabel: peer.label,
            peerReport,
            retry: hasPriorThreadWork(crossReviewThread)
              ? { kind: "retry", reusedThread: true }
              : { kind: "none" },
            createdAt: updatedAt,
          }),
        );
        if (turnOutcome._tag === "Failure") {
          nextWorkflow = withCrossReviewError({
            workflow: runningWorkflow,
            investigatorKey,
            error: String(turnOutcome.cause),
            updatedAt,
          });
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
          continue;
        }
        nextWorkflow = runningWorkflow;
      }
      return nextWorkflow;
    });

  const maybeStartSelfReviews = (
    workflow: InvestigationWorkflow,
    snapshotAtCall: OrchestrationReadModel | null,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        isArchivedWorkflow(workflow) ||
        !workflow.selfReviewEnabled ||
        workflow.investigatorA.investigationStatus !== "completed" ||
        workflow.investigatorB.investigationStatus !== "completed"
      ) {
        return workflow;
      }

      let nextWorkflow = workflow;
      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = nextWorkflow[investigatorKey];
        if (
          investigator.selfReviewStatus === "running" ||
          investigator.selfReviewStatus === "completed" ||
          investigator.selfReviewStatus === "error"
        ) {
          continue;
        }

        let pendingWorkflow = nextWorkflow;
        if (investigator.selfReviewStatus === "not_started") {
          pendingWorkflow = withSelfReviewPendingStart(nextWorkflow, investigatorKey, updatedAt);
          yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
        }

        let pendingInvestigator = pendingWorkflow[investigatorKey];
        const snapshot = snapshotAtCall ?? (yield* orchestrationEngine.getReadModel());
        const ownReport = investigationReport(snapshot, pendingInvestigator);
        if (!ownReport || ownReport.trim().length === 0) {
          nextWorkflow = withSelfReviewError({
            workflow: pendingWorkflow,
            investigatorKey,
            error: SELF_REVIEW_OUTPUT_NOT_FOUND,
            updatedAt,
          });
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
          continue;
        }

        const selfReviewThreadId =
          pendingInvestigator.selfReviewThreadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
        if (pendingInvestigator.selfReviewThreadId === null) {
          pendingWorkflow = withSelfReviewThreadPrepared(
            pendingWorkflow,
            investigatorKey,
            selfReviewThreadId,
            updatedAt,
          );
          pendingInvestigator = pendingWorkflow[investigatorKey];
          yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);
        }

        let selfReviewThread = liveThreadById(snapshot, selfReviewThreadId);
        if (!selfReviewThread) {
          const createOutcome = yield* Effect.exit(
            createSelfReviewThread({
              orchestrationEngine,
              workflow: pendingWorkflow,
              threadId: selfReviewThreadId,
              investigator: pendingInvestigator,
              title:
                investigatorKey === "investigatorA" ? "Own-model review A" : "Own-model review B",
              createdAt: updatedAt,
            }),
          );
          if (createOutcome._tag === "Failure") {
            const latestSnapshot = yield* orchestrationEngine.getReadModel();
            selfReviewThread = liveThreadById(latestSnapshot, selfReviewThreadId);
            if (!selfReviewThread) {
              nextWorkflow = withSelfReviewError({
                workflow: pendingWorkflow,
                investigatorKey,
                error: String(createOutcome.cause),
                updatedAt,
              });
              yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
              continue;
            }
          }
        }

        const dispatchCommandId = CommandId.makeUnsafe(timeOrderedUuid());
        const runningWorkflow = withSelfReviewRunning(
          pendingWorkflow,
          investigatorKey,
          selfReviewThreadId,
          updatedAt,
          dispatchCommandId,
        );
        yield* upsertWorkflow(orchestrationEngine, runningWorkflow, updatedAt);
        const turnOutcome = yield* Effect.exit(
          startSelfReviewTurn({
            orchestrationEngine,
            commandId: dispatchCommandId,
            workflow: runningWorkflow,
            investigator: runningWorkflow[investigatorKey],
            investigationReport: ownReport,
            retry: hasPriorThreadWork(selfReviewThread)
              ? { kind: "retry", reusedThread: true }
              : { kind: "none" },
            createdAt: updatedAt,
          }),
        );
        if (turnOutcome._tag === "Failure") {
          nextWorkflow = withSelfReviewError({
            workflow: runningWorkflow,
            investigatorKey,
            error: String(turnOutcome.cause),
            updatedAt,
          });
          yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
          continue;
        }
        nextWorkflow = runningWorkflow;
      }
      return nextWorkflow;
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
        workflow.investigatorA.crossReviewStatus !== "completed" ||
        workflow.investigatorB.crossReviewStatus !== "completed" ||
        (workflow.selfReviewEnabled &&
          (workflow.investigatorA.selfReviewStatus !== "completed" ||
            workflow.investigatorB.selfReviewStatus !== "completed")) ||
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
      if (
        contributions.some(
          (contribution) =>
            !contribution.investigation ||
            contribution.investigation.trim().length === 0 ||
            !contribution.crossReviewOfThis ||
            contribution.crossReviewOfThis.trim().length === 0 ||
            (pendingWorkflow.selfReviewEnabled &&
              (!contribution.selfReview || contribution.selfReview.trim().length === 0)),
        )
      ) {
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
          contributions: contributions.map((contribution) => ({
            label: contribution.label,
            investigation: contribution.investigation!,
            crossReviewOfThis: contribution.crossReviewOfThis!,
            selfReview: contribution.selfReview,
          })),
          retry: hasPriorThreadWork(synthesisThread)
            ? { kind: "retry", reusedThread: true }
            : { kind: "none" },
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

  const maybeSelfHealCrossReviewSentinels = (
    workflow: InvestigationWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      let nextWorkflow = workflow;
      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = nextWorkflow[investigatorKey];
        if (
          investigator.crossReviewStatus !== "error" ||
          investigator.error !== CROSS_REVIEW_OUTPUT_NOT_FOUND
        ) {
          continue;
        }
        const peer = nextWorkflow[peerKey(investigatorKey)];
        const peerReport = investigationReport(snapshot, peer);
        if (!peerReport || peerReport.trim().length === 0) {
          continue;
        }
        nextWorkflow = updateInvestigator(
          nextWorkflow,
          investigatorKey,
          {
            ...investigator,
            crossReviewStatus: "not_started",
            error: null,
            updatedAt,
          },
          updatedAt,
        );
      }
      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      }
      return nextWorkflow;
    });

  const maybeSelfHealSelfReviewSentinels = (
    workflow: InvestigationWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.selfReviewEnabled) {
        return workflow;
      }
      let nextWorkflow = workflow;
      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = nextWorkflow[investigatorKey];
        if (
          investigator.selfReviewStatus !== "error" ||
          investigator.error !== SELF_REVIEW_OUTPUT_NOT_FOUND
        ) {
          continue;
        }
        const ownReport = investigationReport(snapshot, investigator);
        if (!ownReport || ownReport.trim().length === 0) {
          continue;
        }
        nextWorkflow = updateInvestigator(
          nextWorkflow,
          investigatorKey,
          {
            ...investigator,
            selfReviewStatus: "not_started",
            error: null,
            updatedAt,
          },
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
      const contributions = collectSynthesisContributions(workflow, snapshot);
      if (
        contributions.some(
          (contribution) =>
            !contribution.investigation ||
            contribution.investigation.trim().length === 0 ||
            !contribution.crossReviewOfThis ||
            contribution.crossReviewOfThis.trim().length === 0 ||
            (workflow.selfReviewEnabled &&
              (!contribution.selfReview || contribution.selfReview.trim().length === 0)),
        )
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

      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = reconciledWorkflow[investigatorKey];
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          investigator.investigationThreadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
        }
      }

      reconciledWorkflow = yield* startPendingInvestigations(reconciledWorkflow, updatedAt);
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();
      reconciledWorkflow = yield* maybeSelfHealCrossReviewSentinels(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciledWorkflow = yield* maybeStartCrossReviews(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();
      reconciledWorkflow = yield* maybeSelfHealSelfReviewSentinels(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciledWorkflow = yield* maybeStartSelfReviews(
        reconciledWorkflow,
        reconciliationSnapshot,
        updatedAt,
      );
      reconciliationSnapshot = yield* orchestrationEngine.getReadModel();

      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = reconciledWorkflow[investigatorKey];
        if (investigator.crossReviewThreadId === null) {
          continue;
        }
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          investigator.crossReviewThreadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
        }
      }

      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = reconciledWorkflow[investigatorKey];
        if (investigator.selfReviewThreadId === null) {
          continue;
        }
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          investigator.selfReviewThreadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
        }
      }

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
        const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
          reconciledWorkflow,
          reconciliationSnapshot,
          reconciledWorkflow.synthesis.threadId,
          updatedAt,
        );
        if (advancedWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = advancedWorkflow;
        }
      }

      for (const investigatorKey of ["investigatorA", "investigatorB"] as const) {
        const investigator = reconciledWorkflow[investigatorKey];
        if (investigator.investigationStatus === "running") {
          const thread = reconciliationSnapshot.threads.find(
            (entry) => entry.id === investigator.investigationThreadId,
          );
          const sessionStatus = thread?.session?.status ?? null;
          if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
            reconciledWorkflow = withInvestigationError({
              workflow: reconciledWorkflow,
              investigatorKey,
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
        if (investigator.crossReviewStatus === "running") {
          const thread =
            investigator.crossReviewThreadId === null
              ? null
              : reconciliationSnapshot.threads.find(
                  (entry) => entry.id === investigator.crossReviewThreadId,
                );
          const sessionStatus = thread?.session?.status ?? null;
          if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
            reconciledWorkflow = withCrossReviewError({
              workflow: reconciledWorkflow,
              investigatorKey,
              error: "Cross-review session was not running during reconciliation.",
              updatedAt,
            });
            yield* upsertWorkflow(
              orchestrationEngine,
              reconciledWorkflow,
              reconciledWorkflow.updatedAt,
            );
          }
        }
        if (investigator.selfReviewStatus === "running") {
          const thread =
            investigator.selfReviewThreadId === null
              ? null
              : reconciliationSnapshot.threads.find(
                  (entry) => entry.id === investigator.selfReviewThreadId,
                );
          const sessionStatus = thread?.session?.status ?? null;
          if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
            reconciledWorkflow = withSelfReviewError({
              workflow: reconciledWorkflow,
              investigatorKey,
              error: "Own-model review session was not running during reconciliation.",
              updatedAt,
            });
            yield* upsertWorkflow(
              orchestrationEngine,
              reconciledWorkflow,
              reconciledWorkflow.updatedAt,
            );
          }
        }
      }

      if (reconciledWorkflow.synthesis.status === "running") {
        const thread =
          reconciledWorkflow.synthesis.threadId === null
            ? null
            : reconciliationSnapshot.threads.find(
                (entry) => entry.id === reconciledWorkflow.synthesis.threadId,
              );
        const sessionStatus = thread?.session?.status ?? null;
        if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
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
          nextWorkflow = yield* maybeStartCrossReviews(nextWorkflow, readModel, event.occurredAt);
          nextWorkflow = yield* maybeStartSelfReviews(nextWorkflow, readModel, event.occurredAt);
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
                const retryWorkflow = updateInvestigator(
                  workflow,
                  investigation.investigatorKey,
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
                  investigatorKey: investigation.investigatorKey,
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
              const crossReviewWorkflow = yield* maybeStartCrossReviews(
                nextWorkflow,
                readModel,
                event.occurredAt,
              );
              yield* maybeStartSelfReviews(crossReviewWorkflow, readModel, event.occurredAt);
            }
            return;
          }

          const crossReview = crossReviewMatch(workflow, event.payload.threadId);
          if (crossReview) {
            if (
              event.payload.session.status === "error" &&
              crossReview.investigator.crossReviewStatus === "running"
            ) {
              if (
                event.payload.session.lastErrorRetryability === "retryable" &&
                (crossReview.investigator.crossReviewRetryCount ?? 0) <
                  MAX_PROFILE_TIMEOUT_RETRIES &&
                workflowBudgetError(workflow) === null
              ) {
                const retryWorkflow = updateInvestigator(
                  workflow,
                  crossReview.investigatorKey,
                  {
                    ...crossReview.investigator,
                    crossReviewStatus: "pending_start",
                    error: null,
                    crossReviewRetryCount:
                      (crossReview.investigator.crossReviewRetryCount ?? 0) + 1,
                    updatedAt: event.occurredAt,
                  },
                  event.occurredAt,
                );
                yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
                yield* maybeStartCrossReviews(retryWorkflow, readModel, event.occurredAt);
                return;
              }
              yield* upsertWorkflow(
                orchestrationEngine,
                withCrossReviewError({
                  workflow,
                  investigatorKey: crossReview.investigatorKey,
                  error: event.payload.session.lastError ?? "Cross-review failed.",
                  updatedAt: event.occurredAt,
                }),
                event.occurredAt,
              );
              return;
            }
            if (
              event.payload.session.status === "ready" &&
              crossReview.investigator.crossReviewStatus === "running" &&
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
              yield* maybeStartSynthesis(nextWorkflow, readModel, event.occurredAt);
            }
            return;
          }

          const selfReview = selfReviewMatch(workflow, event.payload.threadId);
          if (selfReview) {
            if (
              event.payload.session.status === "error" &&
              selfReview.investigator.selfReviewStatus === "running"
            ) {
              if (
                event.payload.session.lastErrorRetryability === "retryable" &&
                (selfReview.investigator.selfReviewRetryCount ?? 0) < MAX_PROFILE_TIMEOUT_RETRIES &&
                workflowBudgetError(workflow) === null
              ) {
                const retryWorkflow = updateInvestigator(
                  workflow,
                  selfReview.investigatorKey,
                  {
                    ...selfReview.investigator,
                    selfReviewStatus: "pending_start",
                    error: null,
                    selfReviewRetryCount: (selfReview.investigator.selfReviewRetryCount ?? 0) + 1,
                    updatedAt: event.occurredAt,
                  },
                  event.occurredAt,
                );
                yield* upsertWorkflow(orchestrationEngine, retryWorkflow, event.occurredAt);
                yield* maybeStartSelfReviews(retryWorkflow, readModel, event.occurredAt);
                return;
              }
              yield* upsertWorkflow(
                orchestrationEngine,
                withSelfReviewError({
                  workflow,
                  investigatorKey: selfReview.investigatorKey,
                  error: event.payload.session.lastError ?? "Own-model review failed.",
                  updatedAt: event.occurredAt,
                }),
                event.occurredAt,
              );
              return;
            }
            if (
              event.payload.session.status === "ready" &&
              selfReview.investigator.selfReviewStatus === "running" &&
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
      nextWorkflow = yield* maybeStartCrossReviews(nextWorkflow, readModel, updatedAt);
      nextWorkflow = yield* maybeStartSelfReviews(nextWorkflow, readModel, updatedAt);
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
      item.kind === "event" ? handleDomainEvent(item.event) : handleDeliveryOutcome(item.outcome),
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
      const input = {
        ...rawInput,
        investigatorA: resolveAvailableWorkflowModelSlot(rawInput.investigatorA, providers),
        investigatorB: resolveAvailableWorkflowModelSlot(rawInput.investigatorB, providers),
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
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "investigation",
            provider: input.investigatorA.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "investigation",
            provider: input.investigatorB.provider,
          });
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "synthesis",
            provider: input.synthesis.provider,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
      if (
        input.investigatorA.provider === input.investigatorB.provider &&
        input.investigatorA.model === input.investigatorB.model
      ) {
        return yield* Effect.fail(
          new Error("Investigation investigator models must be different."),
        );
      }

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
      const investigationThreadIdA = ThreadId.makeUnsafe(crypto.randomUUID());
      const investigationThreadIdB = ThreadId.makeUnsafe(crypto.randomUUID());
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
        selfReviewEnabled: input.selfReviewEnabled ?? false,
        createdAt: now,
        investigationThreadIdA,
        investigationThreadIdB,
        investigatorA: input.investigatorA,
        investigatorB: input.investigatorB,
        synthesis: input.synthesis,
        maxCostUsd: input.maxCostUsd,
      });

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
        selfReviewEnabled: input.selfReviewEnabled ?? false,
        investigatorA: input.investigatorA,
        investigatorB: input.investigatorB,
        synthesis: input.synthesis,
        maxCostUsd: input.maxCostUsd ?? null,
        investigationThreadIdA,
        investigationThreadIdB,
        createdAt: now,
      });

      yield* Effect.all([
        createInvestigationThread({
          orchestrationEngine,
          workflow,
          threadId: investigationThreadIdA,
          investigator: workflow.investigatorA,
          title: "Investigator A",
          createdAt: now,
        }),
        createInvestigationThread({
          orchestrationEngine,
          workflow,
          threadId: investigationThreadIdB,
          investigator: workflow.investigatorB,
          title: "Investigator B",
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

      yield* startPendingInvestigations(workflow, new Date().toISOString());
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
    changeWorkflowArchive.unarchive(workflowId, (snapshot) =>
      Effect.gen(function* () {
        const workflow = snapshot.investigationWorkflows.find((entry) => entry.id === workflowId);
        if (workflow) yield* reconcileStuckWorkflow(workflow, snapshot);
      }),
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
      if (scope === "crossReview") {
        if (
          workflow.investigatorA.investigationStatus !== "completed" ||
          workflow.investigatorB.investigationStatus !== "completed"
        ) {
          return yield* Effect.fail(
            new Error("Both investigations must be completed before retrying cross-review."),
          );
        }
        nextWorkflow = resetCrossReviewsAndSynthesis(workflow, updatedAt);
      } else if (scope === "selfReview") {
        if (
          !workflow.selfReviewEnabled ||
          workflow.investigatorA.investigationStatus !== "completed" ||
          workflow.investigatorB.investigationStatus !== "completed"
        ) {
          return yield* Effect.fail(
            new Error("Both investigations must be completed before retrying own-model review."),
          );
        }
        nextWorkflow = resetSelfReviewsAndSynthesis(workflow, updatedAt);
      } else if (scope === "synthesis") {
        if (
          workflow.investigatorA.crossReviewStatus !== "completed" ||
          workflow.investigatorB.crossReviewStatus !== "completed" ||
          (workflow.selfReviewEnabled &&
            (workflow.investigatorA.selfReviewStatus !== "completed" ||
              workflow.investigatorB.selfReviewStatus !== "completed"))
        ) {
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
        let resetInvestigation = false;
        nextWorkflow = {
          ...workflow,
          investigatorA:
            workflow.investigatorA.investigationStatus === "error"
              ? {
                  ...workflow.investigatorA,
                  investigationStatus: "pending",
                  investigationTurnId: null,
                  investigationMessageId: null,
                  error: null,
                  updatedAt,
                }
              : workflow.investigatorA,
          investigatorB:
            workflow.investigatorB.investigationStatus === "error"
              ? {
                  ...workflow.investigatorB,
                  investigationStatus: "pending",
                  investigationTurnId: null,
                  investigationMessageId: null,
                  error: null,
                  updatedAt,
                }
              : workflow.investigatorB,
          updatedAt,
        };
        resetInvestigation =
          workflow.investigatorA.investigationStatus === "error" ||
          workflow.investigatorB.investigationStatus === "error";
        if (resetInvestigation) {
          nextWorkflow = resetAllReviewsAndSynthesis(nextWorkflow, updatedAt);
        } else {
          const shouldResetCrossReview =
            workflow.investigatorA.crossReviewStatus === "error" ||
            workflow.investigatorB.crossReviewStatus === "error";
          const shouldResetSelfReview =
            workflow.investigatorA.selfReviewStatus === "error" ||
            workflow.investigatorB.selfReviewStatus === "error";
          let investigatorA = nextWorkflow.investigatorA;
          let investigatorB = nextWorkflow.investigatorB;
          if (workflow.investigatorA.crossReviewStatus === "error") {
            investigatorA = resetCrossReview(investigatorA, updatedAt);
          }
          if (workflow.investigatorB.crossReviewStatus === "error") {
            investigatorB = resetCrossReview(investigatorB, updatedAt);
          }
          if (workflow.investigatorA.selfReviewStatus === "error") {
            investigatorA = resetSelfReview(investigatorA, updatedAt);
          }
          if (workflow.investigatorB.selfReviewStatus === "error") {
            investigatorB = resetSelfReview(investigatorB, updatedAt);
          }
          nextWorkflow = {
            ...nextWorkflow,
            investigatorA,
            investigatorB,
            synthesis:
              shouldResetCrossReview ||
              shouldResetSelfReview ||
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
      nextWorkflow = yield* maybeStartCrossReviews(nextWorkflow, snapshot, updatedAt);
      nextWorkflow = yield* maybeStartSelfReviews(nextWorkflow, snapshot, updatedAt);
      yield* maybeStartSynthesis(nextWorkflow, snapshot, updatedAt);
    });

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
