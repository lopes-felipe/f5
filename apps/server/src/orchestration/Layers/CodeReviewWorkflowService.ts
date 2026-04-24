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
  type OrchestrationCreateCodeReviewWorkflowInput,
  type OrchestrationEvent,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
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
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  CodeReviewWorkflowService,
  type CodeReviewWorkflowServiceShape,
} from "../Services/CodeReviewWorkflowService.ts";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import {
  getFinishedConsumableLatestTurn,
  isLatestTurnFinishedAndConsumable,
  latestAssistantFeedback,
  nextWorkflowSlug,
  slotLabel,
} from "../workflowSharedUtils.ts";

type CodeReviewWorkflowTitleGenerationWorkItem = {
  readonly workflowId: CodeReviewWorkflowId;
  readonly titleSourceText: string;
  readonly expectedCurrentTitle: string;
  readonly titleGenerationModel?: string | undefined;
  readonly defaultTitle: string;
};

function buildWorkflowRecord(input: {
  workflowId: CodeReviewWorkflowId;
  title: CodeReviewWorkflow["title"];
  slug: string;
  createdAt: string;
  reviewThreadIdA: ThreadId;
  reviewThreadIdB: ThreadId;
  reviewerA: WorkflowModelSlot;
  reviewerB: WorkflowModelSlot;
  consolidation: WorkflowModelSlot;
  request: OrchestrationCreateCodeReviewWorkflowInput;
}): CodeReviewWorkflow {
  return {
    id: input.workflowId,
    projectId: input.request.projectId,
    title: input.title,
    slug: input.slug,
    reviewPrompt: input.request.reviewPrompt,
    branch: input.request.branch ?? null,
    reviewerA: {
      label: `Reviewer A (${slotLabel(input.reviewerA)})`,
      slot: input.reviewerA,
      threadId: input.reviewThreadIdA,
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: input.createdAt,
    },
    reviewerB: {
      label: `Reviewer B (${slotLabel(input.reviewerB)})`,
      slot: input.reviewerB,
      threadId: input.reviewThreadIdB,
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: input.createdAt,
    },
    consolidation: {
      slot: input.consolidation,
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: input.createdAt,
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
  };
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
  snapshotQuery: ProjectionSnapshotQueryShape,
  workflowId: CodeReviewWorkflowId,
) {
  return snapshotQuery
    .getSnapshot()
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
  updatedAt: string,
): CodeReviewWorkflow {
  if (workflow.consolidation.status === "pending_start") {
    return workflow;
  }
  return {
    ...workflow,
    consolidation: {
      ...workflow.consolidation,
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
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: input.reviewer.threadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildCodeReviewReviewerPrompt({
        reviewPrompt: input.workflow.reviewPrompt,
        reviewerLabel: input.reviewer.label,
        branch: input.workflow.branch,
        provider: input.reviewer.slot.provider,
      }),
      attachments: [],
    },
    provider: input.reviewer.slot.provider,
    model: input.reviewer.slot.model,
    ...(input.reviewer.slot.modelOptions ? { modelOptions: input.reviewer.slot.modelOptions } : {}),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
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
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    threadId: input.workflow.consolidation.threadId!,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: buildCodeReviewConsolidationPrompt({
        reviewPrompt: input.workflow.reviewPrompt,
        reviews: input.reviews,
      }),
      attachments: [],
    },
    provider: input.workflow.consolidation.slot.provider,
    model: input.workflow.consolidation.slot.model,
    ...(input.workflow.consolidation.slot.modelOptions
      ? { modelOptions: input.workflow.consolidation.slot.modelOptions }
      : {}),
    titleSourceText: input.workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: input.createdAt,
  });
}

export const makeCodeReviewWorkflowService = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;

  const titleGenerationWorker = yield* makeDrainableWorker(
    (item: CodeReviewWorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshotQuery.getSnapshot();
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

        const latestSnapshot = yield* snapshotQuery.getSnapshot();
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
  ) =>
    Effect.gen(function* () {
      if (
        isDeletedWorkflow(workflow) ||
        workflow.reviewerA.status !== "completed" ||
        workflow.reviewerB.status !== "completed" ||
        workflow.consolidation.status === "pending_start" ||
        workflow.consolidation.status === "running" ||
        workflow.consolidation.status === "completed"
      ) {
        return;
      }

      const pendingWorkflow = withConsolidationPendingStart(workflow, updatedAt);
      yield* upsertWorkflow(orchestrationEngine, pendingWorkflow, updatedAt);

      const snapshot = snapshotAtCall ?? (yield* snapshotQuery.getSnapshot());
      const reviewerInputs = [pendingWorkflow.reviewerA, pendingWorkflow.reviewerB].map(
        (reviewer) => {
          const thread = snapshot.threads.find((entry) => entry.id === reviewer.threadId);
          const text = thread
            ? (latestAssistantFeedback(thread, reviewer.pinnedAssistantMessageId)?.text ?? null)
            : null;
          return {
            label: reviewer.label,
            text,
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

      const consolidationThreadId =
        pendingWorkflow.consolidation.threadId ?? ThreadId.makeUnsafe(crypto.randomUUID());
      yield* createConsolidationThread({
        orchestrationEngine,
        workflow: pendingWorkflow,
        threadId: consolidationThreadId,
        createdAt: updatedAt,
      });

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
          })),
          createdAt: updatedAt,
        }),
      );
      if (consolidationOutcome._tag === "Failure") {
        yield* upsertWorkflow(
          orchestrationEngine,
          withConsolidationError(runningWorkflow, String(consolidationOutcome.cause), updatedAt),
          updatedAt,
        );
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
      let nextWorkflow = workflow;
      for (const reviewer of pendingReviewers) {
        const outcome = yield* Effect.exit(
          startReviewerTurn({
            orchestrationEngine,
            workflow,
            reviewer,
            createdAt: updatedAt,
          }),
        );
        if (outcome._tag === "Failure") {
          nextWorkflow = withReviewerError({
            workflow: nextWorkflow,
            reviewerKey:
              reviewer.threadId === workflow.reviewerA.threadId ? "reviewerA" : "reviewerB",
            error: String(outcome.cause),
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
      if (
        reviewer &&
        (reviewer.reviewer.status === "running" ||
          (reviewer.reviewer.status === "completed" &&
            (reviewer.reviewer.pinnedTurnId === null ||
              reviewer.reviewer.pinnedAssistantMessageId === null)))
      ) {
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
        workflow.consolidation.status === "running"
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

      if (
        reconciledWorkflow.consolidation.status === "pending_start" &&
        reconciledWorkflow.consolidation.threadId === null
      ) {
        yield* maybeStartConsolidation(reconciledWorkflow, snapshot, updatedAt);
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
        yield* maybeStartConsolidation(retriableWorkflow, snapshot, retriableWorkflow.updatedAt);
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
        const sessionStatus = thread?.session?.status ?? null;
        if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
          reconciledWorkflow = withReviewerError({
            workflow: reconciledWorkflow,
            reviewerKey,
            error: "Reviewer session was not running during reconciliation.",
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
        if (reconciledWorkflow.consolidation.threadId) {
          const advancedWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
            reconciledWorkflow,
            snapshot,
            reconciledWorkflow.consolidation.threadId,
            updatedAt,
          );
          if (advancedWorkflow !== reconciledWorkflow) {
            return;
          }
        }

        const thread = reconciledWorkflow.consolidation.threadId
          ? snapshot.threads.find((entry) => entry.id === reconciledWorkflow.consolidation.threadId)
          : null;
        const sessionStatus = thread?.session?.status ?? null;
        if (!thread || sessionStatus === "error" || sessionStatus === "stopped") {
          reconciledWorkflow = withConsolidationError(
            reconciledWorkflow,
            "Consolidation session was not running during reconciliation.",
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
    const snapshot = yield* snapshotQuery.getSnapshot();
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
          const workflow = readModel.codeReviewWorkflows.find(
            (entry) => !isDeletedWorkflow(entry) && reviewerMatch(entry, event.payload.threadId),
          );
          if (workflow) {
            const match = reviewerMatch(workflow, event.payload.threadId)!;
            const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
            if (event.payload.session.status === "error") {
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
              match.reviewer.status === "running" &&
              isLatestTurnFinishedAndConsumable(thread)
            ) {
              const nextWorkflow = yield* maybeAdvanceWorkflowFromCompletedThread(
                workflow,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              yield* maybeStartConsolidation(nextWorkflow, readModel, event.occurredAt);
            }
            return;
          }

          const consolidationWorkflow = readModel.codeReviewWorkflows.find(
            (entry) =>
              !isDeletedWorkflow(entry) && entry.consolidation.threadId === event.payload.threadId,
          );
          if (!consolidationWorkflow) {
            return;
          }
          if (event.payload.session.status === "error") {
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
            consolidationWorkflow.consolidation.status === "running" &&
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

  const createWorkflow: CodeReviewWorkflowServiceShape["createWorkflow"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getSnapshot();
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
      const workflow = buildWorkflowRecord({
        workflowId,
        title: initialTitle,
        slug,
        createdAt: now,
        reviewThreadIdA,
        reviewThreadIdB,
        reviewerA: input.reviewerA,
        reviewerB: input.reviewerB,
        consolidation: input.consolidation,
        request: input,
      });

      yield* orchestrationEngine.dispatch({
        type: "project.code-review-workflow.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        reviewPrompt: input.reviewPrompt,
        branch: input.branch ?? null,
        reviewerA: input.reviewerA,
        reviewerB: input.reviewerB,
        consolidation: input.consolidation,
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
      const workflow = yield* readCodeReviewWorkflow(snapshotQuery, workflowId).pipe(
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
      const workflow = yield* readCodeReviewWorkflow(snapshotQuery, workflowId).pipe(
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
      const workflow = yield* readCodeReviewWorkflow(snapshotQuery, workflowId).pipe(
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
      const workflow = yield* readCodeReviewWorkflow(snapshotQuery, input.workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }

      const updatedAt = new Date().toISOString();
      let nextWorkflow = workflow;
      if ((input.scope ?? "failed") === "consolidation") {
        if (
          workflow.reviewerA.status !== "completed" ||
          workflow.reviewerB.status !== "completed"
        ) {
          return yield* Effect.fail(
            new Error("Both reviewers must be completed before retrying consolidation."),
          );
        }
        nextWorkflow = {
          ...workflow,
          consolidation: {
            ...workflow.consolidation,
            threadId: null,
            status: "not_started",
            pinnedTurnId: null,
            pinnedAssistantMessageId: null,
            error: null,
            updatedAt,
          },
          updatedAt,
        };
      } else {
        nextWorkflow = {
          ...workflow,
          reviewerA:
            workflow.reviewerA.status === "error"
              ? {
                  ...workflow.reviewerA,
                  status: "pending",
                  pinnedTurnId: null,
                  pinnedAssistantMessageId: null,
                  error: null,
                  updatedAt,
                }
              : workflow.reviewerA,
          reviewerB:
            workflow.reviewerB.status === "error"
              ? {
                  ...workflow.reviewerB,
                  status: "pending",
                  pinnedTurnId: null,
                  pinnedAssistantMessageId: null,
                  error: null,
                  updatedAt,
                }
              : workflow.reviewerB,
          consolidation:
            workflow.consolidation.status === "error"
              ? {
                  ...workflow.consolidation,
                  threadId: null,
                  status: "not_started",
                  pinnedTurnId: null,
                  pinnedAssistantMessageId: null,
                  error: null,
                  updatedAt,
                }
              : workflow.consolidation,
          updatedAt,
        };
      }

      yield* upsertWorkflow(orchestrationEngine, nextWorkflow, updatedAt);
      yield* startPendingReviewers(nextWorkflow, updatedAt);
      if (
        nextWorkflow.reviewerA.status === "completed" &&
        nextWorkflow.reviewerB.status === "completed" &&
        nextWorkflow.consolidation.status === "not_started"
      ) {
        const snapshot = yield* snapshotQuery.getSnapshot();
        yield* maybeStartConsolidation(nextWorkflow, snapshot, updatedAt);
      }
    });

  const workflowForThread: CodeReviewWorkflowServiceShape["workflowForThread"] = (threadId) =>
    snapshotQuery.getSnapshot().pipe(
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
