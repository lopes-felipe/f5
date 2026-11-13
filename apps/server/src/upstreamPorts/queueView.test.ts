import { describe, expect, it } from "vitest";

import type { UpstreamTopicState } from "@t3tools/contracts";

import type { QueueRecord } from "./queueStore.ts";
import {
  bucketQueue,
  dedupeBlockers,
  queueViewCounts,
  selectQueueView,
  type QueueBucketContext,
  type QueueTopicRow,
} from "./queueView.ts";

let nextPosition = 0;
const record = (
  overrides: Partial<QueueRecord> & { readonly topicIds: ReadonlyArray<string> },
): QueueRecord => {
  const position = overrides.position ?? nextPosition++;
  return {
    projectId: "project",
    entryId: `entry-${position}`,
    position,
    topicEpochs: Object.fromEntries(overrides.topicIds.map((id) => [id, 1])),
    modelSelection: { provider: "codex", model: "gpt" } as never,
    runtimeMode: "full-access",
    requestId: `request-${position}`,
    fileKeys: [],
    ignoreConflicts: false,
    status: "finished",
    threadId: `thread-${position}`,
    result: "completed",
    topicResults: {},
    reason: null,
    createdAt: `2026-11-01T00:00:${String(position).padStart(2, "0")}.000Z`,
    updatedAt: `2026-11-01T00:00:${String(position).padStart(2, "0")}.000Z`,
    finishedAt: null,
    ...overrides,
  };
};

const row = (
  state: UpstreamTopicState,
  topic: Partial<QueueTopicRow["topic"]> = {},
): QueueTopicRow => ({
  state,
  topic: { title: "Title", epoch: 1, decidedBy: null, status: null, reasonKey: null, ...topic },
});

const context = (
  rows: Record<string, QueueTopicRow>,
  overrides: Partial<QueueBucketContext> = {},
): QueueBucketContext => ({
  rows: new Map(Object.entries(rows)),
  onDefaultBranch: () => false,
  blocked: () => false,
  ...overrides,
});

const bucketsOf = (records: ReadonlyArray<QueueRecord>, ctx: QueueBucketContext) =>
  bucketQueue(records, ctx).entries.map((entry) => entry.topics.map((topic) => topic.bucket));

describe("bucketQueue", () => {
  it("supersedes a failed attempt that a later entry retried, so the retry counts once", () => {
    const failed = record({ topicIds: ["pr-1"], status: "dropped", result: "start-failed" });
    const retry = record({ topicIds: ["pr-1"], topicResults: { "pr-1": "pr" } });
    const result = bucketQueue([failed, retry], context({ "pr-1": row("in-progress") }));
    expect(result.entries.map((entry) => entry.bucket)).toEqual(["superseded", "awaiting-review"]);
    expect(result.counts.needsAttention).toBe(0);
    expect(result.counts.awaitingReview).toBe(1);
    expect(result.counts.superseded).toBe(1);
  });

  it("keeps a failure when the later entry never attempted the topic", () => {
    const failed = record({ topicIds: ["pr-1"], topicResults: { "pr-1": "no-outcome" } });
    const cleared = record({ topicIds: ["pr-1"], status: "dropped", result: "canceled" });
    expect(bucketsOf([failed, cleared], context({ "pr-1": row("in-progress") }))).toEqual([
      ["needs-attention"],
      ["cancelled"],
    ]);
  });

  it("resolves topics the user decided outside the queue", () => {
    const entry = record({
      topicIds: ["pr-1", "pr-2", "pr-3", "pr-4"],
      topicResults: { "pr-1": "no-outcome", "pr-2": "no-outcome", "pr-3": "failed", "pr-4": "pr" },
    });
    expect(
      bucketsOf(
        [entry],
        context({
          "pr-1": row("done"),
          "pr-2": row("skipped"),
          "pr-3": row("watch"),
          "pr-4": row("inbox"),
        }),
      ),
    ).toEqual([["resolved", "resolved", "resolved", "resolved"]]);
  });

  it("flags no-outcome on a topic that is still in progress", () => {
    const entry = record({ topicIds: ["pr-1"], topicResults: { "pr-1": "no-outcome" } });
    const result = bucketQueue([entry], context({ "pr-1": row("in-progress") }));
    expect(result.entries[0]!.bucket).toBe("needs-attention");
    expect(result.counts.needsAttention).toBe(1);
  });

  it("marks a topic whose trailer landed as done", () => {
    const entry = record({ topicIds: ["pr-1"], topicResults: { "pr-1": "pr" } });
    const result = bucketQueue(
      [entry],
      context(
        { "pr-1": row("done") },
        { onDefaultBranch: (id, epoch) => id === "pr-1" && epoch === 1 },
      ),
    );
    expect(result.entries[0]!.bucket).toBe("done");
    expect(result.counts.done).toBe(1);
  });

  it("records LLM-recorded equivalents", () => {
    const entry = record({ topicIds: ["pr-1"], topicResults: { "pr-1": "equivalent" } });
    expect(
      bucketsOf(
        [entry],
        context({ "pr-1": row("done", { decidedBy: "llm", status: "equivalent" }) }),
      ),
    ).toEqual([["recorded"]]);
  });

  it("omits dropped not-ready entries and supersedes changed epochs", () => {
    const notReady = record({ topicIds: ["pr-1"], status: "dropped", result: "not-ready" });
    const changed = record({ topicIds: ["pr-2"], status: "dropped", result: "epoch-changed" });
    const stale = record({ topicIds: ["pr-3"], topicEpochs: { "pr-3": 1 } });
    expect(
      bucketsOf(
        [notReady, changed, stale],
        context({
          "pr-1": row("ready"),
          "pr-2": row("ready"),
          "pr-3": row("in-progress", { epoch: 2 }),
        }),
      ),
    ).toEqual([["omitted"], ["superseded"], ["superseded"]]);
  });

  it("separates waiting from queued and counts both as queued topics", () => {
    const waiting = record({ topicIds: ["pr-1"], status: "queued", threadId: null, result: null });
    const queued = record({ topicIds: ["pr-2"], status: "queued", threadId: null, result: null });
    const result = bucketQueue(
      [waiting, queued],
      context(
        { "pr-1": row("ready"), "pr-2": row("ready") },
        { blocked: (entry) => entry === waiting },
      ),
    );
    expect(result.entries.map((entry) => entry.bucket)).toEqual(["waiting", "queued"]);
    expect(result.counts.queued).toBe(2);
  });

  it("gives an entry its most severe topic bucket", () => {
    const entry = record({
      topicIds: ["pr-1", "pr-2"],
      topicEpochs: { "pr-1": 1, "pr-2": 1, "pr-3": 1 },
      topicResults: { "pr-1": "pr", "pr-2": "no-outcome", "pr-3": "canceled" },
    });
    const result = bucketQueue(
      [entry],
      context({ "pr-1": row("in-progress"), "pr-2": row("in-progress"), "pr-3": row("ready") }),
    );
    expect(result.entries[0]!.topics.map((topic) => topic.bucket)).toEqual([
      "awaiting-review",
      "needs-attention",
      "cancelled",
    ]);
    expect(result.entries[0]!.bucket).toBe("needs-attention");
  });
});

describe("selectQueueView", () => {
  const entries = [
    {
      record: record({ topicIds: ["a"], position: 50, status: "queued" }),
      bucket: "queued" as const,
    },
    {
      record: record({ topicIds: ["b"], position: 51, status: "started" }),
      bucket: "executing" as const,
    },
    {
      record: record({ topicIds: ["c"], position: 40, status: "queued" }),
      bucket: "waiting" as const,
    },
    {
      record: record({ topicIds: ["d"], position: 1, finishedAt: "2026-11-02T00:00:00.000Z" }),
      bucket: "awaiting-review" as const,
    },
    {
      record: record({ topicIds: ["e"], position: 2, finishedAt: "2026-11-01T00:00:00.000Z" }),
      bucket: "needs-attention" as const,
    },
    {
      record: record({ topicIds: ["f"], position: 3, finishedAt: "2026-11-01T00:00:00.000Z" }),
      bucket: "done" as const,
    },
    {
      record: record({ topicIds: ["g"], position: 4, finishedAt: "2026-11-03T00:00:00.000Z" }),
      bucket: "done" as const,
    },
    {
      record: record({ topicIds: ["h"], position: 5, status: "dropped" }),
      bucket: "cancelled" as const,
    },
  ];
  const ids = (picked: ReadonlyArray<{ readonly record: QueueRecord }>) =>
    picked.map((entry) => entry.record.topicIds[0]);

  it("orders active jobs running first, then by queue position", () => {
    expect(ids(selectQueueView(entries, "active"))).toEqual(["b", "c", "a"]);
  });

  it("orders needs-you by severity, then newest first", () => {
    expect(ids(selectQueueView(entries, "needs-you"))).toEqual(["e", "d"]);
  });

  it("lists history newest first and hides inactive jobs unless asked", () => {
    expect(ids(selectQueueView(entries, "history"))).toEqual(["g", "f"]);
    expect(ids(selectQueueView(entries, "history", true))).toContain("h");
  });

  it("puts live work on the first page regardless of history size", () => {
    const history = Array.from({ length: 150 }, (_, index) => ({
      record: record({ topicIds: [`old-${index}`], position: index }),
      bucket: "done" as const,
    }));
    const live = {
      record: record({ topicIds: ["live"], position: 500, status: "queued" }),
      bucket: "queued" as const,
    };
    expect(ids(selectQueueView([...history, live], "active").slice(0, 100))).toEqual(["live"]);
  });

  it("counts jobs per tab", () => {
    expect(queueViewCounts(entries)).toEqual({ active: 3, needsYou: 2, history: 2, inactive: 1 });
  });
});

describe("dedupeBlockers", () => {
  it("lists a batched blocking thread once with all its topics", () => {
    const blockers = dedupeBlockers(
      [
        { topicId: "pr-1", threadId: "t-1", needsAttention: false },
        { topicId: "pr-2", threadId: "t-1", needsAttention: true },
        { topicId: "pr-3", threadId: null },
      ],
      (id) => `Title ${id}`,
    );
    expect(blockers).toEqual([
      {
        topicId: "pr-1",
        threadId: "t-1",
        needsAttention: true,
        topicTitles: ["Title pr-1", "Title pr-2"],
      },
      { topicId: "pr-3", threadId: null, needsAttention: false, topicTitles: ["Title pr-3"] },
    ]);
  });
});
