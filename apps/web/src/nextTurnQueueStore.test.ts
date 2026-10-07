import { CommandId, MessageId, ThreadId, type NextTurnQueueSnapshot } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { getNextTurnQueueScheduledResumeAt, useNextTurnQueueStore } from "./nextTurnQueueStore";

const threadId = ThreadId.makeUnsafe("queue-store-thread");

function snapshot(
  revision: number,
  overrides: Partial<NextTurnQueueSnapshot> = {},
): NextTurnQueueSnapshot {
  return {
    threadId,
    items: [],
    revision,
    paused: false,
    blockedKind: "waiting",
    reasonCode: "active_turn",
    reasonDetail: null,
    maxItems: 20,
    quarantinedCount: 0,
    ...overrides,
  };
}

describe("nextTurnQueueStore", () => {
  beforeEach(() => {
    useNextTurnQueueStore.setState({ byThreadId: {}, summary: { threads: [] } });
  });

  it("accepts same-revision snapshots when gate state changed", () => {
    const store = useNextTurnQueueStore.getState();
    store.applySnapshot(snapshot(4));
    store.applySnapshot(
      snapshot(4, {
        paused: true,
        blockedKind: "error",
        reasonCode: "delivery_ambiguous",
        reasonDetail: "The provider outcome is unknown.",
      }),
    );

    expect(useNextTurnQueueStore.getState().byThreadId[threadId]?.snapshot).toEqual(
      expect.objectContaining({
        revision: 4,
        paused: true,
        reasonCode: "delivery_ambiguous",
      }),
    );
  });

  it("rejects lower revisions and invalidates cached snapshots on reconnect", () => {
    const store = useNextTurnQueueStore.getState();
    store.applySnapshot(snapshot(7, { reasonCode: "turn_starting" }));
    store.applySnapshot(snapshot(6, { reasonCode: "worktree_missing" }));
    expect(useNextTurnQueueStore.getState().byThreadId[threadId]?.snapshot?.reasonCode).toBe(
      "turn_starting",
    );

    useNextTurnQueueStore.getState().invalidateSnapshots();
    const invalidated = useNextTurnQueueStore.getState().byThreadId[threadId];
    expect(invalidated?.snapshot).toBeNull();
    expect(invalidated?.hydrated).toBe(false);
  });
});

describe("scheduled usage resume indicator", () => {
  it("uses the summary until a local snapshot is available", () => {
    const store = useNextTurnQueueStore.getState();
    store.applySummary({
      threads: [
        {
          threadId,
          queuedCount: 1,
          dispatchingCount: 0,
          failedCount: 0,
          paused: false,
          scheduledResumeAt: "2026-10-08T12:01:00.000Z",
        },
      ],
    });
    expect(getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId)).toBe(
      "2026-10-08T12:01:00.000Z",
    );
    store.applySnapshot(snapshot(10));
    expect(
      getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId),
    ).toBeNull();
  });

  it("shows only a queued recovery from the local snapshot", () => {
    const recovery = {
      itemId: CommandId.makeUnsafe("resume"),
      threadId,
      submissionId: CommandId.makeUnsafe("submission"),
      position: 0,
      status: "queued" as const,
      command: {
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe("command"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("message"),
          role: "user" as const,
          text: "continue",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-10-08T12:00:00.000Z",
      },
      attemptCount: 0,
      notBefore: "2026-10-08T12:01:00.000Z",
      scheduleReason: "usage_limit_reset" as const,
      dispatchStartedAt: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    };
    const store = useNextTurnQueueStore.getState();
    store.applySnapshot(snapshot(20, { items: [recovery] }));
    expect(getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId)).toBe(
      recovery.notBefore,
    );
    store.applySnapshot(snapshot(21, { items: [{ ...recovery, status: "dispatching" }] }));
    expect(
      getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId),
    ).toBeNull();
    store.applySnapshot(snapshot(22, { items: [{ ...recovery, status: "failed" }] }));
    expect(
      getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId),
    ).toBeNull();
    store.applySnapshot(snapshot(23, { items: [recovery], paused: true }));
    expect(
      getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId),
    ).toBeNull();
  });

  it("does not show the summary clock for a paused queue", () => {
    useNextTurnQueueStore.setState({
      byThreadId: {},
      summary: {
        threads: [
          {
            threadId,
            queuedCount: 1,
            dispatchingCount: 0,
            failedCount: 0,
            paused: true,
            scheduledResumeAt: "2026-10-08T12:01:00.000Z",
          },
        ],
      },
    });
    expect(
      getNextTurnQueueScheduledResumeAt(useNextTurnQueueStore.getState(), threadId),
    ).toBeNull();
  });
});
