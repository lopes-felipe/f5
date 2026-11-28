import { sortThreadsByActivity, type ActivityOrderedThread } from "./threadOrdering";

export type ThreadStatus =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "failed"
  | "plan-ready"
  | "completed"
  | "none";

interface LatestTurn {
  readonly state: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

export function isLatestTurnSettled(
  turn: { readonly startedAt: string | null; readonly completedAt: string | null } | null,
  sessionStatus: string | null,
): boolean {
  return Boolean(turn?.startedAt && turn.completedAt && sessionStatus !== "running");
}

export function findLatestProposedPlan<
  T extends { readonly id: string; readonly turnId: string | null; readonly updatedAt: string },
>(plans: readonly T[], latestTurnId: string | null | undefined): T | null {
  let latest: T | null = null;
  let matching: T | null = null;
  const newer = (plan: T, other: T | null) =>
    !other ||
    (plan.updatedAt.localeCompare(other.updatedAt) || plan.id.localeCompare(other.id)) > 0;
  for (const plan of plans) {
    if (newer(plan, latest)) latest = plan;
    if (latestTurnId && plan.turnId === latestTurnId && newer(plan, matching)) matching = plan;
  }
  return matching ?? latest;
}

export function hasActionableProposedPlan<T extends { readonly implementedAt: string | null }>(
  plan: T | null,
) {
  return plan !== null && plan.implementedAt === null;
}

interface VisitState {
  readonly latestTurn: LatestTurn | null;
  // Null means the user has never visited. Omission disables visit tracking.
  readonly lastVisitedAt?: string | null | undefined;
}

export function hasUnseenCompletion({ latestTurn, lastVisitedAt }: VisitState): boolean {
  if (lastVisitedAt === undefined || !latestTurn?.completedAt) return false;
  const completedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  const visitedAt = Date.parse(lastVisitedAt ?? "");
  return Number.isNaN(visitedAt) || completedAt > visitedAt;
}

export function hasUnseenFailure({ latestTurn, lastVisitedAt }: VisitState): boolean {
  if (lastVisitedAt === undefined || latestTurn?.state !== "error") return false;
  const endedAt = Date.parse(latestTurn.completedAt ?? latestTurn.requestedAt);
  const visitedAt = Date.parse(lastVisitedAt ?? "");
  return Number.isNaN(endedAt) || Number.isNaN(visitedAt) || endedAt > visitedAt;
}

export function resolveThreadStatus(
  input: VisitState & {
    readonly sessionStatus: string | null;
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly planReady: boolean;
  },
): ThreadStatus {
  if (input.hasPendingApprovals) return "pending-approval";
  if (input.hasPendingUserInput) return "awaiting-input";
  if (input.sessionStatus === "running") return "working";
  if (input.sessionStatus === "connecting" || input.sessionStatus === "starting")
    return "connecting";
  if (hasUnseenFailure(input)) return "failed";
  if (input.planReady) return "plan-ready";
  if (hasUnseenCompletion(input)) return "completed";
  return "none";
}
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

export interface ThreadAttentionBuckets<T extends ActivityOrderedThread = ActivityOrderedThread> {
  /** Needs the user, most urgent first, recency preserved within a priority. */
  readonly attention: T[];
  readonly working: T[];
  readonly remaining: T[];
}

/**
 * A workflow step blocks on the user when it asks for an approval or an answer,
 * or its queue is paused. Plans are consumed by the workflow itself, so a
 * plan-ready step is not waiting on the user.
 */
export function isWorkflowThreadBlockedOnUser(status: ThreadStatus, queuePaused: boolean): boolean {
  return queuePaused || status === "pending-approval" || status === "awaiting-input";
}

/**
 * Splits recency-sorted threads into attention, working and the rest.
 * `workflowThreads` (owned by a workflow, any order) only join attention, and
 * only when blocked on the user; otherwise they surface through their workflow.
 */
export function bucketThreadsByAttention<T extends ActivityOrderedThread>(
  sortedThreads: ReadonlyArray<T>,
  statusByThreadId: ReadonlyMap<string, ThreadStatus>,
  pausedQueueThreadIds: ReadonlySet<string>,
  workflowThreads: ReadonlyArray<T> = [],
): ThreadAttentionBuckets<T> {
  const attention: T[] = [];
  const working: T[] = [];
  const remaining: T[] = [];

  const blockedWorkflowThreads = workflowThreads.filter((thread) =>
    isWorkflowThreadBlockedOnUser(
      statusByThreadId.get(thread.id) ?? "none",
      pausedQueueThreadIds.has(thread.id),
    ),
  );
  const ordered =
    blockedWorkflowThreads.length > 0
      ? sortThreadsByActivity([...sortedThreads, ...blockedWorkflowThreads])
      : sortedThreads;
  const workflowThreadIds = new Set(blockedWorkflowThreads.map((thread) => thread.id));

  for (const thread of ordered) {
    if (workflowThreadIds.has(thread.id)) {
      attention.push(thread);
      continue;
    }
    const status = statusByThreadId.get(thread.id) ?? "none";
    if (isAttentionThread(status, pausedQueueThreadIds.has(thread.id))) {
      attention.push(thread);
    } else if (isWorkingStatus(status)) {
      working.push(thread);
    } else {
      remaining.push(thread);
    }
  }

  const candidate = (thread: T): AttentionCandidate => ({
    status: statusByThreadId.get(thread.id) ?? "none",
    queuePaused: pausedQueueThreadIds.has(thread.id),
  });
  attention.sort((left, right) => compareAttentionPriority(candidate(left), candidate(right)));

  return { attention, working, remaining };
}
