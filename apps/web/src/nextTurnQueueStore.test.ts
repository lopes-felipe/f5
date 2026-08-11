import { ThreadId, type NextTurnQueueSnapshot } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useNextTurnQueueStore } from "./nextTurnQueueStore";

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
