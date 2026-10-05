import type {
  CodeReviewWorkflow,
  InvestigationWorkflow,
  PlanningWorkflow,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadIdsForCodeReviewWorkflow,
  threadIdsForInvestigationWorkflow,
  threadIdsForPlanningWorkflow,
} from "@t3tools/shared/workflowThreads";

import type { ThreadStatus } from "../threadStatus";
import type { Thread } from "../types";
import { getVisibleThreads, sortThreadsByActivity } from "./threadOrdering";

/** Statuses that need the user; lower sorts first. A paused queue sorts last. */
const ATTENTION_PRIORITY = {
  "pending-approval": 0,
  "awaiting-input": 1,
  "plan-ready": 2,
} as const satisfies Partial<Record<ThreadStatus, number>>;

const PAUSED_QUEUE_PRIORITY = 3;

export type AttentionStatus = keyof typeof ATTENTION_PRIORITY;

export function isAttentionStatus(status: ThreadStatus): status is AttentionStatus {
  return status in ATTENTION_PRIORITY;
}

export function isWorkingStatus(status: ThreadStatus): boolean {
  return status === "working" || status === "connecting";
}

/** A thread needs the user when it waits on them or its next-turn queue is paused. */
export function isAttentionThread(status: ThreadStatus, queuePaused: boolean): boolean {
  return queuePaused || isAttentionStatus(status);
}

export function attentionPriority(status: ThreadStatus, queuePaused: boolean): number {
  if (queuePaused) return PAUSED_QUEUE_PRIORITY;
  return isAttentionStatus(status) ? ATTENTION_PRIORITY[status] : Number.POSITIVE_INFINITY;
}

export interface AttentionCandidate {
  readonly status: ThreadStatus;
  readonly queuePaused: boolean;
}

/** Comparator for `toSorted`/`sort`; stable sorts keep recency within a priority. */
export function compareAttentionPriority(
  left: AttentionCandidate,
  right: AttentionCandidate,
): number {
  return (
    attentionPriority(left.status, left.queuePaused) -
    attentionPriority(right.status, right.queuePaused)
  );
}

export interface ThreadAttentionBuckets {
  /** Needs the user, most urgent first, recency preserved within a priority. */
  readonly attention: Thread[];
  readonly working: Thread[];
  readonly remaining: Thread[];
}

/** Splits recency-sorted threads into attention, working and the rest. */
export function bucketThreadsByAttention(
  sortedThreads: ReadonlyArray<Thread>,
  statusByThreadId: ReadonlyMap<ThreadId, ThreadStatus>,
  pausedQueueThreadIds: ReadonlySet<ThreadId>,
): ThreadAttentionBuckets {
  const attention: Thread[] = [];
  const working: Thread[] = [];
  const remaining: Thread[] = [];

  for (const thread of sortedThreads) {
    const status = statusByThreadId.get(thread.id) ?? "none";
    if (isAttentionThread(status, pausedQueueThreadIds.has(thread.id))) {
      attention.push(thread);
    } else if (isWorkingStatus(status)) {
      working.push(thread);
    } else {
      remaining.push(thread);
    }
  }

  const candidate = (thread: Thread): AttentionCandidate => ({
    status: statusByThreadId.get(thread.id) ?? "none",
    queuePaused: pausedQueueThreadIds.has(thread.id),
  });
  attention.sort((left, right) => compareAttentionPriority(candidate(left), candidate(right)));

  return { attention, working, remaining };
}

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
export function selectStandaloneThreadsByActivity(input: {
  threads: ReadonlyArray<Thread>;
  planningWorkflows: ReadonlyArray<PlanningWorkflow>;
  codeReviewWorkflows: ReadonlyArray<CodeReviewWorkflow>;
  investigationWorkflows: ReadonlyArray<InvestigationWorkflow>;
}): Thread[] {
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
