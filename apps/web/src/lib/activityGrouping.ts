import type { Thread } from "../types";

export type ActivityBucket = "today" | "yesterday" | "this-week" | "earlier";

type ActivityGroupedThread = Pick<Thread, "lastInteractionAt">;

export interface ActivityGroup<T extends ActivityGroupedThread = Thread> {
  readonly bucket: ActivityBucket;
  readonly label: string;
  readonly threads: ReadonlyArray<T>;
}

const BUCKET_ORDER: ReadonlyArray<ActivityBucket> = ["today", "yesterday", "this-week", "earlier"];

const BUCKET_LABELS: Record<ActivityBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "this-week": "This week",
  earlier: "Earlier",
};

/**
 * Classify a timestamp relative to a reference "now" into a coarse activity
 * bucket. We only care about calendar-day distance; wall-clock time within a
 * day does not matter for grouping purposes.
 */
export function bucketActivityAt(iso: string, now: Date = new Date()): ActivityBucket {
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) {
    return "earlier";
  }

  // Zero out time component so we can subtract calendar days cleanly.
  const tsDay = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()).getTime();
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysAgo = Math.round((nowDay - tsDay) / (24 * 60 * 60 * 1000));

  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return "this-week";
  return "earlier";
}

/**
 * Group threads by activity bucket while preserving their input order within
 * each bucket. Empty buckets are omitted so callers can render only groups
 * that have threads.
 */
export function groupThreadsByActivity<T extends ActivityGroupedThread>(
  threads: ReadonlyArray<T>,
  now: Date = new Date(),
  /** Overrides each thread's bucket, for example from live activity times. */
  bucketOf: (thread: T, index: number) => ActivityBucket = (thread) =>
    bucketActivityAt(thread.lastInteractionAt, now),
): ReadonlyArray<ActivityGroup<T>> {
  const grouped = new Map<ActivityBucket, T[]>();
  for (const [index, thread] of threads.entries()) {
    const bucket = bucketOf(thread, index);
    const existing = grouped.get(bucket);
    if (existing) {
      existing.push(thread);
    } else {
      grouped.set(bucket, [thread]);
    }
  }

  const result: ActivityGroup<T>[] = [];
  for (const bucket of BUCKET_ORDER) {
    const bucketThreads = grouped.get(bucket);
    if (bucketThreads && bucketThreads.length > 0) {
      result.push({
        bucket,
        label: BUCKET_LABELS[bucket],
        threads: bucketThreads,
      });
    }
  }
  return result;
}
