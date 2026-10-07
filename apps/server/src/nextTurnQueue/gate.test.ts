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
  it("allows only the recovery that owns the current failed turn", () => {
    const usageLimit = {
      providerInstanceId: "codex",
      turnId: "limited",
      deliveryId: null,
      windows: [],
      resetsAt: null,
      resetSource: null,
      evidence: "typed",
    };
    const recovery = { ...item, scheduleReason: "usage_limit_reset" };
    const session = {
      status: "error",
      lastError: "Usage limit reached",
      activeTurnId: null,
      updatedAt: now,
      usageLimit,
      providerInstanceId: "codex",
    };
    expect(
      gate({
        item: recovery,
        session,
        scheduleLimitKey: "instance:codex:turn:limited",
        scheduleProviderInstanceId: "codex",
      }),
    ).toEqual({ kind: "ready" });
    expect(
      gate({
        item: recovery,
        session,
        scheduleLimitKey: "instance:codex:turn:other",
        scheduleProviderInstanceId: "codex",
      }),
    ).toEqual(expect.objectContaining({ kind: "autoPause", reasonCode: "turn_failed" }));
    expect(
      gate({
        item: recovery,
        session: { ...session, usageLimit: null },
        scheduleLimitKey: "instance:codex:turn:limited",
      }),
    ).toEqual(expect.objectContaining({ kind: "autoPause", reasonCode: "turn_failed" }));
  });
  it("reports the reset wait separately from transport backoff", () => {
    const future = "2026-01-02T00:00:00.000Z";
    expect(
      gate({ item: { ...item, scheduleReason: "usage_limit_reset", notBefore: future } }),
    ).toEqual({ kind: "wait", reasonCode: "usage_limit_reset" });
    expect(
      gate({
        item: { ...item, scheduleReason: "usage_limit_reset", notBefore: future, attemptCount: 1 },
      }),
    ).toEqual({ kind: "wait", reasonCode: "delivery_retrying" });
  });
  it("pauses when the provider changes while preserving manual pauses", () => {
    const recovery = { ...item, scheduleReason: "usage_limit_reset" };
    expect(gate({ item: recovery, providerContextChanged: true })).toEqual({
      kind: "autoPause",
      reasonCode: "usage_limit_context_changed",
    });
    expect(
      gate({
        item: recovery,
        providerContextChanged: true,
        state: { ...state, paused: true, pauseReasonCode: "manual_pause" },
      }),
    ).toEqual({ kind: "wait", reasonCode: "manual_pause" });
  });

  it("is ready without a session row", () => {
    expect(gate()).toEqual({ kind: "ready" });
  });

  it("waits while a worktree setup is still preparing the first turn", () => {
    expect(gate({ worktreeSetup: "gating" })).toEqual({
      kind: "wait",
      reasonCode: "worktree_setup",
    });
  });

  it("pauses a first turn whose worktree setup was interrupted", () => {
    expect(gate({ worktreeSetup: "orphaned" })).toEqual(
      expect.objectContaining({ kind: "autoPause", reasonCode: "worktree_setup_failed" }),
    );
  });

  it("keeps a setup failure pause ahead of the worktree setup gate", () => {
    expect(
      gate({
        worktreeSetup: "gating",
        state: { ...state, paused: true, pauseReasonCode: "worktree_setup_failed" },
      }),
    ).toEqual({ kind: "wait", reasonCode: "worktree_setup_failed" });
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

  it("releases queued work after a repaired terminal turn reaches quiescence", () => {
    const repairedSession = {
      status: "ready",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    };
    const terminalTurn = {
      processingQuiescedAt: null,
      completedAt: "2026-01-01T00:09:59.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(gate({ session: repairedSession, terminalTurn })).toEqual({
      kind: "wait",
      reasonCode: "turn_post_processing",
    });
    expect(
      gate({
        session: repairedSession,
        terminalTurn: { ...terminalTurn, processingQuiescedAt: now },
      }),
    ).toEqual({ kind: "ready" });
  });
});
