import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadStatus } from "../threadStatus";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import {
  attentionPriority,
  bucketThreadsByAttention,
  compareAttentionPriority,
  isAttentionThread,
  selectStandaloneThreadsByActivity,
} from "./threadAttentionBuckets";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: id,
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

describe("threadAttentionBuckets", () => {
  it("treats waiting statuses and paused queues as attention", () => {
    expect(isAttentionThread("pending-approval", false)).toBe(true);
    expect(isAttentionThread("awaiting-input", false)).toBe(true);
    expect(isAttentionThread("plan-ready", false)).toBe(true);
    expect(isAttentionThread("working", false)).toBe(false);
    expect(isAttentionThread("completed", false)).toBe(false);
    expect(isAttentionThread("none", true)).toBe(true);
  });

  it("orders approval, then input, then plan ready, then paused queues", () => {
    const order: Array<[ThreadStatus, boolean]> = [
      ["none", true],
      ["plan-ready", false],
      ["awaiting-input", false],
      ["pending-approval", false],
    ];
    const sorted = order.toSorted(([leftStatus, leftPaused], [rightStatus, rightPaused]) =>
      compareAttentionPriority(
        { status: leftStatus, queuePaused: leftPaused },
        { status: rightStatus, queuePaused: rightPaused },
      ),
    );
    expect(sorted.map(([status]) => status)).toEqual([
      "pending-approval",
      "awaiting-input",
      "plan-ready",
      "none",
    ]);
    expect(attentionPriority("pending-approval", true)).toBe(3);
  });

  it("buckets threads and keeps recency within a priority", () => {
    const threads = ["a", "b", "c", "d", "e", "f"].map((id) => makeThread(id));
    const statusById = new Map<ThreadId, ThreadStatus>([
      [ThreadId.makeUnsafe("a"), "plan-ready"],
      [ThreadId.makeUnsafe("b"), "working"],
      [ThreadId.makeUnsafe("c"), "pending-approval"],
      [ThreadId.makeUnsafe("d"), "plan-ready"],
      [ThreadId.makeUnsafe("e"), "completed"],
    ]);
    const paused = new Set([ThreadId.makeUnsafe("f")]);

    const buckets = bucketThreadsByAttention(threads, statusById, paused);

    expect(buckets.attention.map((thread) => thread.id)).toEqual(["c", "a", "d", "f"]);
    expect(buckets.working.map((thread) => thread.id)).toEqual(["b"]);
    expect(buckets.remaining.map((thread) => thread.id)).toEqual(["e"]);
  });

  it("selects standalone threads newest first, hiding archived and snoozed ones", () => {
    const threads = [
      makeThread("old", { lastInteractionAt: "2026-03-01T00:00:00.000Z" }),
      makeThread("new", { lastInteractionAt: "2026-03-03T00:00:00.000Z" }),
      makeThread("archived", {
        lastInteractionAt: "2026-03-04T00:00:00.000Z",
        archivedAt: "2026-03-04T00:00:00.000Z",
      }),
    ];
    const selected = selectStandaloneThreadsByActivity({
      threads,
      planningWorkflows: [],
      codeReviewWorkflows: [],
      investigationWorkflows: [],
    });
    expect(selected.map((thread) => thread.id)).toEqual(["new", "old"]);
  });
});
