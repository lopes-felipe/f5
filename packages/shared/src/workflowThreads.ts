import type { CodeReviewWorkflow, PlanningWorkflow, ThreadId } from "@t3tools/contracts";

import { isArchivedWorkflow } from "./workflowArchive";

function compactThreadIds(threadIds: ReadonlyArray<ThreadId | null>): ThreadId[] {
  return threadIds.filter((threadId): threadId is ThreadId => threadId !== null);
}

export function threadIdsForPlanningWorkflow(workflow: PlanningWorkflow): ThreadId[] {
  return compactThreadIds([
    workflow.branchA.authorThreadId,
    workflow.branchB.authorThreadId,
    workflow.merge.threadId,
    ...workflow.branchA.reviews.map((review) => review.threadId),
    ...workflow.branchB.reviews.map((review) => review.threadId),
    workflow.implementation?.threadId ?? null,
    ...(workflow.implementation?.codeReviews.map((review) => review.threadId) ?? []),
  ]);
}

export function threadIdsForCodeReviewWorkflow(workflow: CodeReviewWorkflow): ThreadId[] {
  return compactThreadIds([
    workflow.reviewerA.threadId,
    workflow.reviewerB.threadId,
    workflow.consolidation.threadId,
  ]);
}

export function archivedWorkflowThreadIds(
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
): Set<ThreadId> {
  const threadIds = new Set<ThreadId>();

  for (const workflow of planningWorkflows) {
    if (!isArchivedWorkflow(workflow)) {
      continue;
    }
    for (const threadId of threadIdsForPlanningWorkflow(workflow)) {
      threadIds.add(threadId);
    }
  }

  for (const workflow of codeReviewWorkflows) {
    if (!isArchivedWorkflow(workflow)) {
      continue;
    }
    for (const threadId of threadIdsForCodeReviewWorkflow(workflow)) {
      threadIds.add(threadId);
    }
  }

  return threadIds;
}
