import { EventId, type OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isNewerWorktreeSetup, persistedWorktreeSetup } from "../../hooks/useWorktreeSetup";
import { shouldShowWorktreeSetupCard, worktreeSetupHeadline } from "./WorktreeSetupCard";
import { makeWorktreeSetupSnapshot } from "./worktreeSetupFixtures";

describe("worktree setup card logic", () => {
  it("shows running setups and settled ones that still hold the first turn", () => {
    const running = makeWorktreeSetupSnapshot();
    expect(shouldShowWorktreeSetupCard(running, { firstTurnQueued: true })).toBe(true);
    const failed = makeWorktreeSetupSnapshot({ phase: "failed", error: "boom" });
    expect(shouldShowWorktreeSetupCard(failed, { firstTurnQueued: true })).toBe(true);
    expect(shouldShowWorktreeSetupCard(failed, { firstTurnQueued: false })).toBe(false);
    const done = makeWorktreeSetupSnapshot({ phase: "done" });
    expect(shouldShowWorktreeSetupCard(done, { firstTurnQueued: false })).toBe(false);
    const doneWithScriptFailure = makeWorktreeSetupSnapshot({
      phase: "done",
      stages: done.stages.map((stage) =>
        stage.id === "setup-script" ? { ...stage, status: "failed" } : stage,
      ),
    });
    expect(shouldShowWorktreeSetupCard(doneWithScriptFailure, { firstTurnQueued: false })).toBe(
      true,
    );
    expect(worktreeSetupHeadline(doneWithScriptFailure)).toBe(
      "Worktree ready; setup script failed",
    );
  });

  it("accepts newer sequences and a newer retry, never an older snapshot", () => {
    const first = makeWorktreeSetupSnapshot({ sequence: 4 });
    expect(isNewerWorktreeSetup(first, { ...first, sequence: 5 })).toBe(true);
    expect(isNewerWorktreeSetup(first, { ...first, sequence: 3 })).toBe(false);
    const retry = makeWorktreeSetupSnapshot({
      operationId: "op-2",
      sequence: 1,
      startedAt: "2026-10-01T10:05:00.000Z",
    });
    expect(isNewerWorktreeSetup(first, retry)).toBe(true);
    expect(isNewerWorktreeSetup(retry, first)).toBe(false);
  });

  it("reads the persisted setup snapshot from the thread activity", () => {
    const threadId = ThreadId.makeUnsafe("setup-thread");
    const snapshot = makeWorktreeSetupSnapshot({ phase: "failed", error: "restart" });
    const activity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe(`worktree-setup:${threadId}`),
      tone: "error",
      kind: "worktree-setup",
      summary: "Worktree setup failed",
      payload: snapshot,
      turnId: null,
      createdAt: snapshot.startedAt,
    };
    expect(persistedWorktreeSetup(threadId, [activity])).toEqual(snapshot);
    expect(
      persistedWorktreeSetup(threadId, [{ ...activity, payload: { bogus: true } }]),
    ).toBeNull();
  });
});
