import type { ProjectId, ThreadId } from "@t3tools/contracts";

import { isWorkingStatus } from "../../lib/threadAttentionBuckets";
import type { ThreadStatus } from "../../threadStatus";
import type { ThreadListItem } from "../../types";
import type { WorkflowOverallState } from "../workflow/workflowTimelineTypes";
import {
  type ProjectSidebarLists,
  type SidebarWorkflowEntry,
  workflowEntryKey,
} from "./sidebarLists";
import { workflowActivityAt } from "./sidebarWorkflowGroups";

/** The Recent view's buckets, in display order. */
export const RECENT_SIDEBAR_BUCKETS = [
  "pinned",
  "running",
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
] as const;
export type RecentSidebarBucket = (typeof RECENT_SIDEBAR_BUCKETS)[number];

export const RECENT_SIDEBAR_BUCKET_LABELS: Record<RecentSidebarBucket, string> = {
  pinned: "Pinned",
  running: "Running",
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  earlier: "Earlier",
};

export type RecentSidebarItem<T extends ThreadListItem = ThreadListItem> =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly projectId: ProjectId;
      readonly thread: T;
      /** Sort key within a bucket. */
      readonly activityAt: string;
      /** Picks the day bucket; the live activity time when it is newer than the sort key. */
      readonly bucketAt?: string | undefined;
    }
  | {
      readonly kind: "workflow";
      readonly key: string;
      readonly projectId: ProjectId;
      readonly entry: SidebarWorkflowEntry;
      readonly activityAt: string;
      readonly bucketAt?: string | undefined;
      readonly overallState: WorkflowOverallState;
    };

export function recentThreadItemKey(threadId: ThreadId): string {
  return `thread:${threadId}`;
}

/**
 * A thread's activity time for day buckets and idle folding: the summary's ordering key,
 * or the live activity hour when that is later (the summary key lags while the activity
 * order holds, e.g. for a project's only thread).
 */
export function liveSidebarActivityAt(
  thread: Pick<ThreadListItem, "id" | "lastInteractionAt">,
  liveActivityHours: Readonly<Record<string, number>> | undefined,
): string {
  const liveHour = liveActivityHours?.[thread.id];
  if (liveHour === undefined) return thread.lastInteractionAt;
  const summaryMs = Date.parse(thread.lastInteractionAt);
  return Number.isFinite(summaryMs) && summaryMs >= liveHour
    ? thread.lastInteractionAt
    : new Date(liveHour).toISOString();
}

/**
 * Everything the Recent view lists, across projects: each project's live threads (not
 * archived, snoozed, settled or scheduled), its draft, and its active workflows.
 */
export function collectRecentSidebarItems<T extends ThreadListItem>(
  listsByProjectId: ReadonlyMap<ProjectId, ProjectSidebarLists<T>>,
  liveActivityHours?: Readonly<Record<string, number>>,
): RecentSidebarItem<T>[] {
  const items: RecentSidebarItem<T>[] = [];
  for (const [projectId, lists] of listsByProjectId) {
    for (const thread of lists.activeThreads) {
      items.push({
        kind: "thread",
        key: recentThreadItemKey(thread.id),
        projectId,
        // Draft placeholders are full `Thread`s; the row only reads list fields.
        thread: thread as T,
        activityAt: thread.lastInteractionAt,
        bucketAt: liveSidebarActivityAt(thread, liveActivityHours),
      });
    }
    for (const entry of lists.projectWorkflows) {
      const key = workflowEntryKey(entry);
      const overallState = lists.workflowMetaByKey.get(key)?.overallState ?? "pending";
      const activity = {
        updatedAt: entry.workflow.updatedAt,
        threads: lists.workflowThreadsByKey.get(key) ?? [],
        finished: overallState === "completed",
      };
      items.push({
        kind: "workflow",
        key,
        projectId,
        entry,
        activityAt: workflowActivityAt(activity),
        // As for threads: the live activity picks the day while the summary key lags.
        bucketAt: workflowActivityAt({
          ...activity,
          activityOf: (thread) => liveSidebarActivityAt(thread, liveActivityHours),
        }),
        overallState,
      });
    }
  }
  return items;
}

function startOfLocalDay(now: number, daysBack: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date.getTime();
}

function compareByActivityDesc(
  left: RecentSidebarItem<ThreadListItem>,
  right: RecentSidebarItem<ThreadListItem>,
): number {
  return right.activityAt.localeCompare(left.activityAt) || left.key.localeCompare(right.key);
}

/**
 * Sorts each item into exactly one bucket: pinned threads (in pin order), then running work
 * (working or connecting threads, active workflows), then by local-time activity: today,
 * yesterday, the rest of the last seven days, and earlier. Buckets keep newest first.
 */
export function bucketRecentSidebarItems<T extends ThreadListItem>(
  items: readonly RecentSidebarItem<T>[],
  statusById: ReadonlyMap<ThreadId, ThreadStatus>,
  now: number,
): Record<RecentSidebarBucket, RecentSidebarItem<T>[]> {
  const buckets: Record<RecentSidebarBucket, RecentSidebarItem<T>[]> = {
    pinned: [],
    running: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  const todayStart = startOfLocalDay(now, 0);
  const yesterdayStart = startOfLocalDay(now, 1);
  const weekStart = startOfLocalDay(now, 6);
  for (const item of items) {
    if (item.kind === "thread" && item.thread.pinnedAt != null) {
      buckets.pinned.push(item);
      continue;
    }
    const running =
      item.kind === "thread"
        ? isWorkingStatus(statusById.get(item.thread.id) ?? "none")
        : item.overallState === "active";
    if (running) {
      buckets.running.push(item);
      continue;
    }
    const activityMs = Date.parse(item.bucketAt ?? item.activityAt);
    const bucket: RecentSidebarBucket = !Number.isFinite(activityMs)
      ? "earlier"
      : activityMs >= todayStart
        ? "today"
        : activityMs >= yesterdayStart
          ? "yesterday"
          : activityMs >= weekStart
            ? "thisWeek"
            : "earlier";
    buckets[bucket].push(item);
  }
  buckets.pinned.sort((left, right) => {
    const leftThread = left.kind === "thread" ? left.thread : null;
    const rightThread = right.kind === "thread" ? right.thread : null;
    return (
      (leftThread?.pinOrderKey ?? Number.MAX_SAFE_INTEGER) -
        (rightThread?.pinOrderKey ?? Number.MAX_SAFE_INTEGER) ||
      (leftThread?.pinnedAt ?? "").localeCompare(rightThread?.pinnedAt ?? "") ||
      left.key.localeCompare(right.key)
    );
  });
  for (const bucket of RECENT_SIDEBAR_BUCKETS) {
    if (bucket !== "pinned") buckets[bucket].sort(compareByActivityDesc);
  }
  return buckets;
}
