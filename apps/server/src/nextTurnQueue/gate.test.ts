import { describe, expect, it } from "vitest";

import { resolveNextTurnQueueGate } from "./gate.ts";

const now = "2026-01-01T00:10:00.000Z";
const item = {
  itemId: "item-1",
  threadId: "thread-1",
  submissionId: "submission-1",
  position: 0,
  status: "queued",
  command: {} as never,
  attemptCount: 0,
  notBefore: null,
  dispatchStartedAt: null,
  lastErrorCode: null,
  lastErrorDetail: null,
  createdAt: now,
  updatedAt: now,
};
const state = {
  threadId: "thread-1",
  paused: false,
  pauseReasonCode: null,
  pauseDetail: null,
  resumedAt: null,
  interruptSuppressionCommandId: null,
  worktreeBlockToken: null,
  revision: 1,
  updatedAt: now,
};
const thread = {
  threadId: "thread-1",
  archivedAt: null,
  deletedAt: null,
  worktreePath: null,
};

function gate(overrides: Record<string, unknown> = {}) {
  return resolveNextTurnQueueGate({
    item,
    state,
    thread,
    session: null,
    pendingTurnStart: null,
    runningTurn: null,
    terminalTurn: null,
    hasDispatchingItem: false,
    automaticCompaction: false,
    worktreeExists: null,
    nowMs: Date.parse(now),
    ...overrides,
  } as never);
}

describe("resolveNextTurnQueueGate", () => {
  it("is ready without a session row", () => {
    expect(gate()).toEqual({ kind: "ready" });
  });

  it("waits for a pending turn-start barrier", () => {
    expect(gate({ pendingTurnStart: { requestedAt: "2026-01-01T00:09:00.000Z" } })).toEqual({
      kind: "wait",
      reasonCode: "turn_starting",
    });
  });

  it("prioritizes a newer terminal session error over busy markers", () => {
    expect(
      gate({
        session: {
          status: "error",
          activeTurnId: "turn-1",
          lastError: "adapter failed",
          updatedAt: now,
        },
        pendingTurnStart: { requestedAt: now },
      }),
    ).toEqual({ kind: "autoPause", reasonCode: "turn_failed", detail: "adapter failed" });
  });

  it("does not re-pause for an acknowledged error", () => {
    expect(
      gate({
        state: { ...state, resumedAt: "2026-01-01T00:11:00.000Z" },
        session: {
          status: "error",
          activeTurnId: null,
          lastError: "old error",
          updatedAt: now,
        },
      }),
    ).toEqual({ kind: "ready" });
  });

  it("turns stale pending starts and stalled post-processing into visible pauses", () => {
    expect(gate({ pendingTurnStart: { requestedAt: "2026-01-01T00:04:00.000Z" } })).toEqual({
      kind: "autoPause",
      reasonCode: "turn_never_started",
    });
    expect(
      gate({
        terminalTurn: {
          processingQuiescedAt: null,
          completedAt: "2026-01-01T00:08:00.000Z",
          startedAt: null,
          requestedAt: "2026-01-01T00:07:00.000Z",
        },
      }),
    ).toEqual({ kind: "autoPause", reasonCode: "post_processing_stalled" });
  });
});
