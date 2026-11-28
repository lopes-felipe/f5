import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type CodeReviewWorkflow,
  type CodeReviewWorkflowId,
  type InvestigationWorkflow,
  type InvestigationWorkflowId,
  type OrchestrationReadModel,
  type PlanningWorkflow,
  type PlanningWorkflowId,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

/**
 * Looks up a non-deleted thread from an orchestration read model snapshot.
 */
export function liveThreadById(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  const thread = snapshot.threads.find((entry) => entry.id === threadId);
  return thread && thread.deletedAt === null ? thread : null;
}

/**
 * Dispatches `thread.create` for a workflow stage thread with standard defaults.
 */
export function createWorkflowStageThread(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: string;
  readonly branch: string | null;
  readonly worktreePath?: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  /** A PR the thread is about, linked in the same event that creates it. */
  readonly pullRequest?: ThreadPullRequestLink | null;
  readonly createdAt: string;
}) {
  return input.orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    model: input.model,
    runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: input.branch,
    worktreePath: input.worktreePath ?? null,
    ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
    createdAt: input.createdAt,
  });
}

export function readActivePlanningWorkflow(
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

export function readActiveCodeReviewWorkflow(
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

export function readActiveInvestigationWorkflow(
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

export function upsertCodeReviewWorkflowRecord(
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

export function upsertInvestigationWorkflowRecord(
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

export function upsertPlanningWorkflowRecord(
  orchestrationEngine: OrchestrationEngineShape,
  workflow: PlanningWorkflow,
  createdAt: string,
) {
  return orchestrationEngine.dispatch({
    type: "project.workflow.upsert",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    projectId: workflow.projectId,
    workflow,
    createdAt,
  });
}

export type WorkflowDeleteCompensationInput =
  | {
      readonly kind: "planning";
      readonly orchestrationEngine: OrchestrationEngineShape;
      readonly workflowId: PlanningWorkflowId;
      readonly projectId: ProjectId;
      readonly createdAt: string;
    }
  | {
      readonly kind: "codeReview";
      readonly orchestrationEngine: OrchestrationEngineShape;
      readonly workflowId: CodeReviewWorkflowId;
      readonly projectId: ProjectId;
      readonly createdAt: string;
    }
  | {
      readonly kind: "investigation";
      readonly orchestrationEngine: OrchestrationEngineShape;
      readonly workflowId: InvestigationWorkflowId;
      readonly projectId: ProjectId;
      readonly createdAt: string;
    };

/**
 * Dispatches compensating workflow deletion when initial workflow bootstrap fails
 * after persisting the initial record.
 */
export function dispatchWorkflowDeleteCompensationCommand(input: WorkflowDeleteCompensationInput) {
  const commandId = CommandId.makeUnsafe(timeOrderedUuid());
  switch (input.kind) {
    case "planning":
      return input.orchestrationEngine.dispatch({
        type: "project.workflow.delete",
        commandId,
        workflowId: input.workflowId,
        projectId: input.projectId,
        createdAt: input.createdAt,
      });
    case "codeReview":
      return input.orchestrationEngine.dispatch({
        type: "project.code-review-workflow.delete",
        commandId,
        workflowId: input.workflowId,
        projectId: input.projectId,
        createdAt: input.createdAt,
      });
    case "investigation":
      return input.orchestrationEngine.dispatch({
        type: "project.investigation-workflow.delete",
        commandId,
        workflowId: input.workflowId,
        projectId: input.projectId,
        createdAt: input.createdAt,
      });
  }
}
