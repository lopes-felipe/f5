import type { ThreadId } from "@t3tools/contracts";

import type { ThreadStatus } from "../threadStatus";
import { bucketThreadsByAttention } from "./threadAttentionBuckets";
import type { ListedThread } from "./threadOrdering";

/** Home's queue groups, in display order. */
export const HOME_QUEUE_GROUPS = ["decision", "review", "running", "pinned"] as const;
export type HomeQueueGroupId = (typeof HOME_QUEUE_GROUPS)[number];

export const HOME_QUEUE_GROUP_LABELS: Record<HomeQueueGroupId, string> = {
  decision: "Needs a decision",
  review: "Ready for review",
  running: "Running",
  pinned: "Pinned",
};

/** What a thread is in the queue for; picks its chip, its preview and its primary action. */
export type HomeThreadItemKind =
  | "approval"
  | "question"
  | "plan"
  | "queue-paused"
  | "failed"
  | "completed"
  | "running"
  | "pinned";

export type HomeQueueThread = ListedThread & {
  readonly status: ThreadStatus;
  /** The latest turn's request time: where a running thread sits in its group. */
  readonly latestTurn?: { readonly requestedAt: string } | null | undefined;
};

/** A workflow as the queue needs it; `active` is "a phase is running". */
export interface HomeQueueWorkflow {
  readonly key: string;
  /** When the workflow was created: where it sits among the running rows. */
  readonly startedAt: string;
  readonly activityAt: string;
  readonly active: boolean;
}

export type HomeQueueItem<T extends HomeQueueThread, W extends HomeQueueWorkflow> =
  | {
      readonly type: "thread";
      readonly id: string;
      readonly group: HomeQueueGroupId;
      readonly kind: HomeThreadItemKind;
      readonly thread: T;
    }
  | {
      readonly type: "workflow";
      readonly id: string;
      readonly group: "running";
      readonly workflow: W;
    };

export interface HomeQueueGroup<T extends HomeQueueThread, W extends HomeQueueWorkflow> {
  readonly id: HomeQueueGroupId;
  readonly label: string;
  readonly items: ReadonlyArray<HomeQueueItem<T, W>>;
}

export interface HomeQueue<T extends HomeQueueThread, W extends HomeQueueWorkflow> {
  /** Non-empty groups, in display order. */
  readonly groups: ReadonlyArray<HomeQueueGroup<T, W>>;
  /** Every item in reading order: the keyboard's ring. */
  readonly items: ReadonlyArray<HomeQueueItem<T, W>>;
}

export function homeThreadItemId(threadId: ThreadId): string {
  return `thread:${threadId}`;
}

export function homeWorkflowItemId(workflowKey: string): string {
  return `workflow:${workflowKey}`;
}

/**
 * A workflow consumes its steps' plans itself, so an owned thread is never a
 * plan to review: it is in the queue for an approval, a question or a paused queue.
 */
function decisionKind(status: ThreadStatus, workflowOwned: boolean): HomeThreadItemKind {
  if (status === "pending-approval") return "approval";
  if (status === "awaiting-input") return "question";
  if (status === "plan-ready" && !workflowOwned) return "plan";
  return "queue-paused";
}

/**
 * Home's triage queue. Each thread appears once, in the first group that fits:
 *
 * 1. decision: waits on the user (approval, question, plan, paused queue), most urgent first;
 * 2. review: an unseen failure, then an unread completion;
 * 3. running: working threads and active workflows, most recently started first. The order
 *    does not follow activity, which moves with every streamed chunk: rows would trade
 *    places under the pointer and the selection;
 * 4. pinned: the remaining pinned threads, in pin order.
 *
 * `threads` are the standalone threads by recency and `workflowThreads` the ones a workflow
 * owns (see `selectStandaloneThreadsByActivity` and `selectVisibleWorkflowThreads`). Both
 * lists already leave out archived, settled and snoozed threads.
 */
export function buildHomeQueue<T extends HomeQueueThread, W extends HomeQueueWorkflow>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly workflowThreads: ReadonlyArray<T>;
  readonly pausedQueueThreadIds: ReadonlySet<ThreadId>;
  /** Pinned thread ids in pin order. */
  readonly pinnedThreadIds: ReadonlyArray<ThreadId>;
  readonly workflows: ReadonlyArray<W>;
}): HomeQueue<T, W> {
  const statusByThreadId = new Map<ThreadId, ThreadStatus>();
  for (const thread of input.threads) statusByThreadId.set(thread.id, thread.status);
  for (const thread of input.workflowThreads) statusByThreadId.set(thread.id, thread.status);
  const workflowThreadIds = new Set(input.workflowThreads.map((thread) => thread.id));

  const buckets = bucketThreadsByAttention(
    input.threads,
    statusByThreadId,
    input.pausedQueueThreadIds,
    input.workflowThreads,
  );
  const threadItem = (
    thread: T,
    group: HomeQueueGroupId,
    kind: HomeThreadItemKind,
  ): HomeQueueItem<T, W> => ({
    type: "thread",
    id: homeThreadItemId(thread.id),
    group,
    kind,
    thread,
  });

  const decision = buckets.attention.map((thread) =>
    threadItem(thread, "decision", decisionKind(thread.status, workflowThreadIds.has(thread.id))),
  );

  const review = [
    ...buckets.remaining.filter((thread) => thread.status === "failed"),
    ...buckets.remaining.filter((thread) => thread.status === "completed"),
  ].map((thread) => threadItem(thread, "review", thread.status as "failed" | "completed"));

  const running = [
    ...buckets.working.map((thread) => ({
      startedAt: thread.latestTurn?.requestedAt ?? thread.createdAt,
      item: threadItem(thread, "running", "running"),
    })),
    ...input.workflows
      .filter((workflow) => workflow.active)
      .map((workflow) => ({
        startedAt: workflow.startedAt,
        item: {
          type: "workflow",
          id: homeWorkflowItemId(workflow.key),
          group: "running",
          workflow,
        } satisfies HomeQueueItem<T, W>,
      })),
  ]
    .toSorted(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || left.item.id.localeCompare(right.item.id),
    )
    .map((entry) => entry.item);

  const listed = new Set([...decision, ...review, ...running].map((item) => item.id));
  const visibleById = new Map<ThreadId, T>();
  for (const thread of input.threads) visibleById.set(thread.id, thread);
  for (const thread of input.workflowThreads) visibleById.set(thread.id, thread);
  const pinned: HomeQueueItem<T, W>[] = [];
  for (const threadId of input.pinnedThreadIds) {
    const thread = visibleById.get(threadId);
    if (!thread || listed.has(homeThreadItemId(threadId))) continue;
    listed.add(homeThreadItemId(threadId));
    pinned.push(threadItem(thread, "pinned", "pinned"));
  }

  const itemsByGroup: Record<HomeQueueGroupId, ReadonlyArray<HomeQueueItem<T, W>>> = {
    decision,
    review,
    running,
    pinned,
  };
  const groups = HOME_QUEUE_GROUPS.filter((id) => itemsByGroup[id].length > 0).map((id) => ({
    id,
    label: HOME_QUEUE_GROUP_LABELS[id],
    items: itemsByGroup[id],
  }));
  return { groups, items: groups.flatMap((group) => group.items) };
}

/**
 * The selection after the queue changed. It stays on its item while that item is listed.
 * When the item left (answered, settled, opened), it moves to the item that followed it,
 * else to the one before it, so triage carries on from the same place. With nothing
 * selected it starts at the top.
 */
export function resolveHomeSelection(
  previousIds: ReadonlyArray<string>,
  nextIds: ReadonlyArray<string>,
  selectedId: string | null,
): string | null {
  if (nextIds.length === 0) return null;
  if (selectedId === null) return nextIds[0]!;
  const next = new Set(nextIds);
  if (next.has(selectedId)) return selectedId;
  const position = previousIds.indexOf(selectedId);
  if (position === -1) return nextIds[0]!;
  for (let index = position + 1; index < previousIds.length; index += 1) {
    if (next.has(previousIds[index]!)) return previousIds[index]!;
  }
  for (let index = position - 1; index >= 0; index -= 1) {
    if (next.has(previousIds[index]!)) return previousIds[index]!;
  }
  return nextIds[0]!;
}

/** The id `delta` steps from the selection, clamped to the list; the first or last from nothing. */
export function stepHomeSelection(
  ids: ReadonlyArray<string>,
  selectedId: string | null,
  delta: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const position = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (position === -1) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, position + delta))]!;
}
