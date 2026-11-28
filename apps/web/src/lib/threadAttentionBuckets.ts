import type {
  CodeReviewWorkflowSummary as CodeReviewWorkflow,
  InvestigationWorkflowSummary as InvestigationWorkflow,
  PlanningWorkflowSummary as PlanningWorkflow,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadIdsForCodeReviewWorkflow,
  threadIdsForInvestigationWorkflow,
  threadIdsForPlanningWorkflow,
} from "@t3tools/shared/workflowThreads";

export {
  attentionPriority,
  bucketThreadsByAttention,
  compareAttentionPriority,
  isAttentionStatus,
  isAttentionThread,
  isWorkingStatus,
  isWorkflowThreadBlockedOnUser,
  type AttentionCandidate,
  type AttentionStatus,
  type ThreadAttentionBuckets,
} from "@t3tools/shared/threadAttention";
import { getVisibleThreads, type ListedThread, sortThreadsByActivity } from "./threadOrdering";

/** Every thread owned by a workflow (branches, reviews, merges...). */
export function collectWorkflowThreadIds(
  planningWorkflows: ReadonlyArray<PlanningWorkflow>,
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>,
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>,
): Set<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const workflow of planningWorkflows) {
    for (const id of threadIdsForPlanningWorkflow(workflow)) ids.add(id);
  }
  for (const workflow of codeReviewWorkflows) {
    for (const id of threadIdsForCodeReviewWorkflow(workflow)) ids.add(id);
  }
  for (const workflow of investigationWorkflows) {
    for (const id of threadIdsForInvestigationWorkflow(workflow)) ids.add(id);
  }
  return ids;
}

/**
 * Threads Home and the sidebar surface: not archived or snoozed, not owned by
 * a workflow (those surface through their workflow), most recent first.
 */
export function selectStandaloneThreadsByActivity<T extends ListedThread>(input: {
  threads: ReadonlyArray<T>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
}): T[] {
  const workflowThreadIds = collectWorkflowThreadIds(
    input.planningWorkflows,
    input.codeReviewWorkflows,
    input.investigationWorkflows,
  );
  const visible = getVisibleThreads(
    input.threads,
    input.planningWorkflows,
    input.codeReviewWorkflows,
    input.investigationWorkflows,
  ).filter((thread) => !workflowThreadIds.has(thread.id));
  return sortThreadsByActivity(visible);
}

/**
 * Visible threads owned by an active workflow. Pass them to
 * `bucketThreadsByAttention` so a step blocked on the user reaches Needs you.
 */
export function selectVisibleWorkflowThreads<T extends ListedThread>(input: {
  threads: ReadonlyArray<T>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
}): T[] {
  const workflowThreadIds = collectWorkflowThreadIds(
    input.planningWorkflows,
    input.codeReviewWorkflows,
    input.investigationWorkflows,
  );
  if (workflowThreadIds.size === 0) return [];
  return getVisibleThreads(
    input.threads,
    input.planningWorkflows,
    input.codeReviewWorkflows,
    input.investigationWorkflows,
  ).filter((thread) => workflowThreadIds.has(thread.id));
}
