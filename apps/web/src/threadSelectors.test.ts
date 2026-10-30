import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  selectLiveActivityBuckets,
  selectThreadActivityOrder,
  selectThreadById,
  selectThreadIds,
  selectThreadIndexById,
  selectThreadSummaries,
  selectThreadSummaryById,
  toThreadSummary,
} from "./threadSelectors";
import type { ChatMessage, Thread } from "./types";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");

function makeThread(
  id: ThreadId,
  lastInteractionAt: string,
  overrides: Partial<Thread> = {},
): Thread {
  return {
    id,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt,
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    ...overrides,
  };
}

function streamDelta(thread: Thread, text: string, at: string): Thread {
  const message: ChatMessage = {
    id: MessageId.makeUnsafe(`${thread.id}-assistant`),
    role: "assistant",
    text,
    createdAt: at,
    streaming: true,
  };
  return { ...thread, messages: [message], lastInteractionAt: at };
}

function approvalActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe("approval-1"),
    createdAt: "2026-03-01T00:10:00.000Z",
    kind: "approval.requested",
    summary: "Command approval requested",
    tone: "approval",
    payload: { requestId: "req-1", requestKind: "command", detail: "bun run lint" },
    turnId: null,
  };
}

function replaceThread(threads: ReadonlyArray<Thread>, next: Thread): Thread[] {
  return threads.map((thread) => (thread.id === next.id ? next : thread));
}

describe("threadSelectors", () => {
  it("keeps summaries, order and other threads referentially equal across streaming deltas", () => {
    const initial = [
      makeThread(THREAD_A, "2026-03-01T00:05:00.000Z"),
      makeThread(THREAD_B, "2026-03-01T00:04:00.000Z"),
      makeThread(THREAD_C, "2026-03-01T00:03:00.000Z"),
    ];
    let state = { threads: initial };
    const summaries = selectThreadSummaries(state);
    const order = selectThreadActivityOrder(state);
    const index = selectThreadIndexById(state);
    const ids = selectThreadIds(state);
    const threadB = selectThreadById(state, THREAD_B);
    expect(order).toEqual([THREAD_A, THREAD_B, THREAD_C]);

    for (let second = 1; second <= 3; second += 1) {
      const at = `2026-03-01T00:05:0${second}.000Z`;
      const current = selectThreadById(state, THREAD_A)!;
      state = {
        threads: replaceThread(state.threads, streamDelta(current, "x".repeat(second), at)),
      };
      expect(selectThreadSummaries(state)).toBe(summaries);
      expect(selectThreadActivityOrder(state)).toBe(order);
      expect(selectThreadIndexById(state)).toBe(index);
      expect(selectThreadIds(state)).toBe(ids);
      expect(selectThreadById(state, THREAD_B)).toBe(threadB);
    }
    // The ordering key stays put while the order holds; the live value moves.
    expect(selectThreadSummaryById(state).get(THREAD_A)?.lastInteractionAt).toBe(
      "2026-03-01T00:05:00.000Z",
    );
    expect(selectThreadById(state, THREAD_A)?.lastInteractionAt).toBe("2026-03-01T00:05:03.000Z");
  });

  it("buckets by live activity when activity crosses midnight without reordering", () => {
    const yesterday = new Date(2026, 2, 1, 23, 50).toISOString();
    const earlierYesterday = new Date(2026, 2, 1, 23, 40).toISOString();
    const today = new Date(2026, 2, 2, 0, 5).toISOString();
    const now = new Date(2026, 2, 2, 0, 10).getTime();
    // Own ids: the summary list caches its order across calls.
    const threadD = ThreadId.makeUnsafe("thread-d");
    let state = {
      threads: [makeThread(THREAD_C, yesterday), makeThread(threadD, earlierYesterday)],
    };
    selectThreadSummaries(state);
    state = {
      threads: replaceThread(
        state.threads,
        streamDelta(selectThreadById(state, THREAD_C)!, "after midnight", today),
      ),
    };

    // The order held, so the summary keeps yesterday's ordering key...
    const summaries = selectThreadSummaries(state);
    expect(summaries[0]?.lastInteractionAt).toBe(yesterday);
    // ...but grouping reads the live value.
    expect(selectLiveActivityBuckets(state, summaries, now)).toEqual(["today", "yesterday"]);
  });

  it("gives a thread a new summary when an approval request changes its status", () => {
    let state = {
      threads: [
        makeThread(THREAD_A, "2026-03-01T00:05:00.000Z"),
        makeThread(THREAD_B, "2026-03-01T00:04:00.000Z"),
      ],
    };
    const before = selectThreadSummaryById(state);
    const threadA = selectThreadById(state, THREAD_A)!;
    state = {
      threads: replaceThread(state.threads, {
        ...threadA,
        activities: [approvalActivity()],
      }),
    };
    const after = selectThreadSummaryById(state);
    expect(after.get(THREAD_A)).not.toBe(before.get(THREAD_A));
    expect(after.get(THREAD_A)?.status).toBe("pending-approval");
    expect(after.get(THREAD_B)).toBe(before.get(THREAD_B));
  });

  it("recomputes the status when only the omitted-plans flag changes", () => {
    const threadD = ThreadId.makeUnsafe("thread-plan-omitted");
    const planReady = makeThread(threadD, "2026-03-01T00:05:00.000Z", {
      interactionMode: "plan",
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        assistantMessageId: null,
        requestedAt: "2026-03-01T00:00:00.000Z",
        startedAt: "2026-03-01T00:00:00.000Z",
        completedAt: "2026-03-01T00:05:00.000Z",
      },
      lastVisitedAt: "2026-03-01T00:06:00.000Z",
      proposedPlans: [
        {
          id: "plan-1" as never,
          turnId: "turn-1" as never,
          createdAt: "2026-03-01T00:01:00.000Z",
          updatedAt: "2026-03-01T00:05:00.000Z",
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
        },
      ],
    });
    expect(selectThreadSummaryById({ threads: [planReady] }).get(threadD)?.status).toBe(
      "plan-ready",
    );
    // A reconnect keeps the plans array but flags it stale.
    const omitted = { ...planReady, proposedPlansOmitted: true };
    expect(selectThreadSummaryById({ threads: [omitted] }).get(threadD)?.status).toBe("none");
  });

  it("refreshes the ordering key and the order when a thread moves", () => {
    let state = {
      threads: [
        makeThread(THREAD_A, "2026-03-01T00:05:00.000Z"),
        makeThread(THREAD_B, "2026-03-01T00:04:00.000Z"),
      ],
    };
    const before = selectThreadSummaryById(state);
    const threadB = selectThreadById(state, THREAD_B)!;
    state = {
      threads: replaceThread(state.threads, {
        ...threadB,
        lastInteractionAt: "2026-03-01T00:06:00.000Z",
      }),
    };
    expect(selectThreadActivityOrder(state)).toEqual([THREAD_B, THREAD_A]);
    const after = selectThreadSummaryById(state);
    expect(after.get(THREAD_B)?.lastInteractionAt).toBe("2026-03-01T00:06:00.000Z");
    expect(after.get(THREAD_A)).toBe(before.get(THREAD_A));
  });

  it("rebuilds the index and ids when threads are added", () => {
    let state = { threads: [makeThread(THREAD_A, "2026-03-01T00:05:00.000Z")] };
    const index = selectThreadIndexById(state);
    const ids = selectThreadIds(state);
    state = { threads: [...state.threads, makeThread(THREAD_B, "2026-03-01T00:06:00.000Z")] };
    expect(selectThreadIndexById(state)).not.toBe(index);
    expect(selectThreadIndexById(state).get(THREAD_B)).toBe(1);
    expect(selectThreadIds(state)).not.toBe(ids);
    expect(selectThreadActivityOrder(state)).toEqual([THREAD_B, THREAD_A]);
  });

  it("derives standalone summaries with status and unread state", () => {
    const summary = toThreadSummary(
      makeThread(THREAD_A, "2026-03-01T00:05:00.000Z", {
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: "2026-03-01T00:04:00.000Z",
          startedAt: "2026-03-01T00:04:00.000Z",
          completedAt: "2026-03-01T00:05:00.000Z",
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-03-01T00:01:00.000Z",
      }),
    );
    expect(summary.unread).toBe(true);
    expect(summary.status).toBe("completed");
    expect("messages" in summary).toBe(false);
  });
});
