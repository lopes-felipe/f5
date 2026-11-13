import type {
  UpstreamGetPortQueueResult,
  UpstreamPortQueueBucket,
  UpstreamPortQueueView,
  UpstreamTopicState,
} from "@t3tools/contracts";

import type { QueueRecord } from "./queueStore.ts";

/** The parts of a derived topic row the queue reads. */
export interface QueueTopicRow {
  readonly state: UpstreamTopicState;
  readonly topic: {
    readonly title: string;
    readonly epoch: number;
    readonly decidedBy?: string | null | undefined;
    readonly status?: string | null | undefined;
    readonly reasonKey?: string | null | undefined;
  };
}

export interface QueueBucketContext {
  readonly rows: ReadonlyMap<string, QueueTopicRow>;
  /** The topic's trailer for this epoch reached the default branch, or the base ledger records it equivalent. */
  readonly onDefaultBranch: (topicId: string, epoch: number) => boolean;
  /** A queued entry is held back by another port's files. */
  readonly blocked: (entry: QueueRecord) => boolean;
}

export interface BucketedTopic {
  readonly topicId: string;
  readonly epoch: number;
  readonly superseded: boolean;
  readonly result: string | null;
  readonly bucket: UpstreamPortQueueBucket;
}

export interface BucketedEntry {
  readonly record: QueueRecord;
  readonly topics: ReadonlyArray<BucketedTopic>;
  readonly bucket: UpstreamPortQueueBucket;
}

export type QueueCounts = UpstreamGetPortQueueResult["counts"];

/** Most severe first; an entry takes its most severe topic's bucket. */
const SEVERITY: ReadonlyArray<UpstreamPortQueueBucket> = [
  "needs-attention",
  "executing",
  "waiting",
  "queued",
  "awaiting-review",
  "done",
  "recorded",
  "resolved",
  "superseded",
  "omitted",
  "cancelled",
];

const COUNT_KEY: Record<UpstreamPortQueueBucket, keyof QueueCounts> = {
  queued: "queued",
  waiting: "queued",
  executing: "executing",
  "needs-attention": "needsAttention",
  "awaiting-review": "awaitingReview",
  done: "done",
  recorded: "recorded",
  resolved: "resolved",
  superseded: "superseded",
  omitted: "omitted",
  cancelled: "cancelled",
};

/** States a user reaches by deciding the topic outside the queue. */
const DECIDED_STATES: ReadonlySet<UpstreamTopicState> = new Set([
  "done",
  "skipped",
  "watch",
  "inbox",
]);
const INACTIVE_BUCKETS: ReadonlySet<UpstreamPortQueueBucket> = new Set([
  "superseded",
  "omitted",
  "cancelled",
]);

export const emptyQueueCounts = (): { -readonly [Key in keyof QueueCounts]: number } => ({
  queued: 0,
  executing: 0,
  awaitingReview: 0,
  recorded: 0,
  needsAttention: 0,
  omitted: 0,
  cancelled: 0,
  done: 0,
  resolved: 0,
  superseded: 0,
});

/** A dropped entry whose result means it never really attempted its topics. */
const dropWithoutAttempt = (record: QueueRecord) =>
  record.status === "dropped" &&
  (record.result === "canceled" ||
    record.result === "not-ready" ||
    record.result === "epoch-changed");

function topicBucket(
  record: QueueRecord,
  topicId: string,
  context: QueueBucketContext,
  retried: boolean,
): BucketedTopic {
  const row = context.rows.get(topicId);
  const epoch = record.topicEpochs[topicId]!;
  const superseded = row?.topic.epoch !== epoch;
  const result = record.topicResults[topicId] ?? record.result;
  const out = (bucket: UpstreamPortQueueBucket): BucketedTopic => ({
    topicId,
    epoch,
    superseded,
    result: result ?? null,
    bucket,
  });
  if (!record.topicIds.includes(topicId))
    return out(record.topicResults[topicId] === "canceled" ? "cancelled" : "omitted");
  if (record.status === "queued") return out(context.blocked(record) ? "waiting" : "queued");
  if (record.status === "started") return out("executing");
  // A topic that left the ledger was not replaced by anything, so it is left out.
  if (!row) return out("omitted");
  if (superseded || retried) return out("superseded");
  if (record.status === "dropped") {
    if (record.result === "canceled") return out("cancelled");
    if (record.result === "not-ready") return out("omitted");
    if (record.result === "epoch-changed") return out("superseded");
  }
  if (context.onDefaultBranch(topicId, epoch)) return out("done");
  if (
    row.topic.decidedBy === "llm" &&
    ((result === "equivalent" && row.topic.status === "equivalent") ||
      (result === "not-applicable" &&
        row.topic.status === "skip" &&
        row.topic.reasonKey === "not-applicable"))
  )
    return out("recorded");
  if (DECIDED_STATES.has(row.state)) return out("resolved");
  if (result === "pr" || result === "equivalent" || result === "not-applicable")
    return out("awaiting-review");
  return out("needs-attention");
}

const entryBucket = (
  record: QueueRecord,
  topics: ReadonlyArray<BucketedTopic>,
): UpstreamPortQueueBucket => {
  if (topics.length === 0)
    return record.status === "queued"
      ? "queued"
      : record.status === "started"
        ? "executing"
        : "omitted";
  return topics.reduce(
    (worst, topic) =>
      SEVERITY.indexOf(topic.bucket) < SEVERITY.indexOf(worst) ? topic.bucket : worst,
    topics[0]!.bucket,
  );
};

/**
 * Sorts every topic of every queue entry into one bucket, and tallies topics
 * per bucket. A topic that a later entry attempted again at the same epoch is
 * superseded, so only its latest attempt counts.
 */
export function bucketQueue(
  records: ReadonlyArray<QueueRecord>,
  context: QueueBucketContext,
): { readonly entries: ReadonlyArray<BucketedEntry>; readonly counts: QueueCounts } {
  // The latest real attempt of each topic epoch, by queue position.
  const latest = new Map<string, number>();
  for (const record of records) {
    if (dropWithoutAttempt(record)) continue;
    for (const topicId of record.topicIds) {
      const key = `${topicId}#${record.topicEpochs[topicId]}`;
      latest.set(key, Math.max(latest.get(key) ?? -1, record.position));
    }
  }
  const counts = emptyQueueCounts();
  const entries = records.map((record) => {
    const topics = Object.keys(record.topicEpochs).map((topicId) => {
      const later = latest.get(`${topicId}#${record.topicEpochs[topicId]}`);
      const topic = topicBucket(
        record,
        topicId,
        context,
        later !== undefined && later > record.position,
      );
      counts[COUNT_KEY[topic.bucket]]++;
      return topic;
    });
    return { record, topics, bucket: entryBucket(record, topics) };
  });
  return { entries, counts };
}

export function queueViewOf(bucket: UpstreamPortQueueBucket): UpstreamPortQueueView {
  if (bucket === "queued" || bucket === "waiting" || bucket === "executing") return "active";
  if (bucket === "needs-attention" || bucket === "awaiting-review") return "needs-you";
  return "history";
}

export const isInactiveBucket = (bucket: UpstreamPortQueueBucket) => INACTIVE_BUCKETS.has(bucket);

const recency = (record: QueueRecord) => record.finishedAt ?? record.updatedAt;
const byRecency = (left: QueueRecord, right: QueueRecord) =>
  recency(right).localeCompare(recency(left)) || right.position - left.position;
const rank = (bucket: UpstreamPortQueueBucket) => SEVERITY.indexOf(bucket);

/** Jobs per tab. */
export function queueViewCounts(
  entries: ReadonlyArray<{ readonly bucket: UpstreamPortQueueBucket }>,
) {
  const counts = { active: 0, needsYou: 0, history: 0, inactive: 0 };
  for (const entry of entries) {
    const view = queueViewOf(entry.bucket);
    if (view === "active") counts.active++;
    else if (view === "needs-you") counts.needsYou++;
    else if (isInactiveBucket(entry.bucket)) counts.inactive++;
    else counts.history++;
  }
  return counts;
}

/**
 * One tab's entries in display order: running before queued by position;
 * needs attention before awaiting review, newest first; history newest first.
 */
export function selectQueueView<
  T extends { readonly record: QueueRecord; readonly bucket: UpstreamPortQueueBucket },
>(entries: ReadonlyArray<T>, view: UpstreamPortQueueView, includeInactive = false): T[] {
  const picked = entries.filter(
    (entry) =>
      queueViewOf(entry.bucket) === view &&
      (view !== "history" || includeInactive || !isInactiveBucket(entry.bucket)),
  );
  if (view === "active")
    return picked.sort(
      (left, right) =>
        Number(right.bucket === "executing") - Number(left.bucket === "executing") ||
        left.record.position - right.record.position ||
        left.record.entryId.localeCompare(right.record.entryId),
    );
  if (view === "needs-you")
    return picked.sort(
      (left, right) =>
        rank(left.bucket) - rank(right.bucket) || byRecency(left.record, right.record),
    );
  return picked.sort((left, right) => byRecency(left.record, right.record));
}

/**
 * One blocker per thread: a batched port blocks with every topic it carries,
 * but the user acts on the thread or its PR.
 */
export function dedupeBlockers<
  T extends {
    readonly topicId: string;
    readonly threadId: string | null;
    readonly needsAttention?: boolean;
  },
>(blockers: ReadonlyArray<T>, titleOf: (topicId: string) => string) {
  const byKey = new Map<string, T & { needsAttention: boolean; topicTitles: string[] }>();
  for (const blocker of blockers) {
    const key = blocker.threadId ? `thread:${blocker.threadId}` : `topic:${blocker.topicId}`;
    const current = byKey.get(key);
    if (current) {
      current.needsAttention ||= blocker.needsAttention === true;
      const title = titleOf(blocker.topicId);
      if (!current.topicTitles.includes(title)) current.topicTitles.push(title);
    } else
      byKey.set(key, {
        ...blocker,
        needsAttention: blocker.needsAttention === true,
        topicTitles: [titleOf(blocker.topicId)],
      });
  }
  return [...byKey.values()];
}
