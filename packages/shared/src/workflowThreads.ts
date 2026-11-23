import type {
  CodeReviewWorkflowSummary as CodeReviewWorkflow,
  InvestigationWorkflowSummary as InvestigationWorkflow,
  PlanningWorkflowSummary as PlanningWorkflow,
  ThreadId,
} from "@t3tools/contracts";

import { isArchivedWorkflow } from "./workflowArchive";
import {
  codeReviewReviewers,
  investigationCrossReviews,
  investigationInvestigators,
  planningBranches,
} from "./workflowParticipants";

function compactThreadIds(threadIds: ReadonlyArray<ThreadId | null>): ThreadId[] {
  return threadIds.filter((threadId): threadId is ThreadId => threadId !== null);
}

export function threadIdsForPlanningWorkflow(workflow: PlanningWorkflow): ThreadId[] {
  const branches = planningBranches(workflow);
  return compactThreadIds([
    ...branches.map((branch) => branch.authorThreadId),
    workflow.merge.threadId,
    workflow.readerPass?.readerThreadId ?? null,
    ...(workflow.readerPass?.previousReaderThreadIds ?? []),
    ...branches.flatMap((branch) => branch.reviews.map((review) => review.threadId)),
    workflow.implementation?.threadId ?? null,
    ...(workflow.implementation?.codeReviews.map((review) => review.threadId) ?? []),
  ]);
}

export function threadIdsForCodeReviewWorkflow(workflow: CodeReviewWorkflow): ThreadId[] {
  return compactThreadIds([
    ...codeReviewReviewers(workflow).map((entry) => entry.reviewer.threadId),
    workflow.consolidation.threadId,
  ]);
}

export function threadIdsForInvestigationWorkflow(workflow: InvestigationWorkflow): ThreadId[] {
  const investigators = investigationInvestigators(workflow).map((entry) => entry.investigator);
  return compactThreadIds([
    ...investigators.map((investigator) => investigator.investigationThreadId),
    ...investigationCrossReviews(workflow).map((review) => review.threadId),
    ...investigators.map((investigator) => investigator.selfReviewThreadId),
    workflow.synthesis.threadId,
  ]);
}

export function archivedWorkflowThreadIds(
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
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

  for (const workflow of investigationWorkflows) {
    if (!isArchivedWorkflow(workflow)) {
      continue;
    }
    for (const threadId of threadIdsForInvestigationWorkflow(workflow)) {
      threadIds.add(threadId);
    }
  }

  return threadIds;
}
