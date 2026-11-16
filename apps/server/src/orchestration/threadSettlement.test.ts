import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { OrchestrationThread } from "@t3tools/contracts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementCandidate,
} from "./threadSettlement.ts";
const at = "2026-10-01T12:00:00.000Z";
const now = Date.parse("2026-10-19T12:00:00.000Z");
const thread = Schema.decodeUnknownSync(OrchestrationThread)({
  id: "thread",
  projectId: "project",
  title: "Work",
  model: "model",
  runtimeMode: "approval-required",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  lastInteractionAt: at,
  updatedAt: at,
  deletedAt: null,
  messages: [],
  tasksTurnId: null,
  tasksUpdatedAt: null,
  activities: [],
  checkpoints: [],
  session: null,
});
const input = {
  thread,
  nowMs: now,
  latestUserAuthoredMessageAt: at,
  pullRequests: [],
  autoSettleOnPullRequestMerge: false,
  autoSettleAfterDays: null,
  autoSettleKeepPullRequests: true,
};
describe("settlement rules", () => {
  it("keeps all automatic settlement off by default", () =>
    expect(resolveAutoSettlementAt(input)).toBeNull());
  it.each([
    ["archived", { thread: { ...thread, archivedAt: at } }],
    ["deleted", { thread: { ...thread, deletedAt: at } }],
    ["already settled", { thread: { ...thread, settledAt: at, settledBy: "user" as const } }],
    ["pinned", { thread: { ...thread, pinnedAt: at } }],
    ["future snooze", { thread: { ...thread, snoozedUntil: "2026-10-20T12:00:00.000Z" } }],
    ["disabled", { thread: { ...thread, autoSettleDisabled: true } }],
    ["queued work", { hasQueuedWork: true }],
    ["pending request", { hasPendingRequest: true }],
    ["background work", { hasBackgroundWork: true }],
    ["PR watch", { hasWatch: true }],
    [
      "user input",
      {
        thread: {
          ...thread,
          pendingUserInputs: [
            { requestId: "one" },
          ] as unknown as OrchestrationThread["pendingUserInputs"],
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, Partial<SettlementCandidate>]>)(
    "excludes %s",
    (_name, patch) => expect(isAutoSettlementCandidate({ thread, ...patch }, now)).toBe(false),
  );
  it("does not settle a turn whose terminal processing has not quiesced", () => {
    const current = {
      ...thread,
      latestTurn: {
        turnId: "turn" as NonNullable<OrchestrationThread["latestTurn"]>["turnId"],
        state: "completed" as const,
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        processingQuiescedAt: null,
        assistantMessageId: null,
      },
    };
    expect(isAutoSettlementCandidate({ thread: current }, now)).toBe(false);
    expect(
      isAutoSettlementCandidate(
        { thread: { ...current, latestTurn: { ...current.latestTurn, processingQuiescedAt: at } } },
        now,
      ),
    ).toBe(true);
    expect(
      isAutoSettlementCandidate(
        { thread: { ...current, latestTurn: { ...current.latestTurn, state: "running" } } },
        now,
      ),
    ).toBe(false);
  });
  it("settles inactivity using the latest activity and allows an expired snooze", () => {
    expect(resolveAutoSettlementAt({ ...input, autoSettleAfterDays: 7 })).toBe(at);
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleAfterDays: 7,
        thread: { ...thread, lastInteractionAt: "2026-10-18T12:00:00.000Z" },
      }),
    ).toBeNull();
    expect(isAutoSettlementCandidate({ thread: { ...thread, snoozedUntil: at } }, now)).toBe(true);
  });
  it("requires every linked PR to be known and terminal before a PR wake settles", () => {
    const merged = { state: "merged" as const, mergedAt: "2026-10-02T12:00:00.000Z" };
    const enabled = { ...input, autoSettleOnPullRequestMerge: true };
    expect(resolveAutoSettlementAt({ ...enabled, pullRequests: [merged] })).toBe(at);
    expect(resolveAutoSettlementAt({ ...enabled, pullRequests: [merged, null] })).toBeNull();
    expect(
      resolveAutoSettlementAt({ ...enabled, pullRequests: [merged, { state: "open" }] }),
    ).toBeNull();
    expect(resolveAutoSettlementAt({ ...enabled, pullRequests: [{ state: "closed" }] })).toBeNull();
    expect(
      resolveAutoSettlementAt({
        ...enabled,
        pullRequests: [{ state: "closed", closedAt: merged.mergedAt }],
      }),
    ).toBe(at);
  });
  it("does not settle a human follow-up after PR closure or enable closed-PR settlement by default", () => {
    const pr = { state: "closed" as const, closedAt: "2026-10-02T12:00:00.000Z" };
    expect(resolveAutoSettlementAt({ ...input, pullRequests: [pr] })).toBeNull();
    expect(
      resolveAutoSettlementAt({
        ...input,
        autoSettleOnPullRequestMerge: true,
        pullRequests: [pr],
        latestUserAuthoredMessageAt: "2026-10-03T12:00:00.000Z",
      }),
    ).toBeNull();
  });
  it("does not reuse an old merge after a persisted wake, but permits a new terminal PR", () => {
    const enabled = {
      ...input,
      autoSettleOnPullRequestMerge: true,
      lastUnsettledAt: "2026-10-04T12:00:00.000Z",
    };
    expect(
      resolveAutoSettlementAt({
        ...enabled,
        pullRequests: [{ state: "merged", mergedAt: "2026-10-03T12:00:00.000Z" }],
      }),
    ).toBeNull();
    expect(
      resolveAutoSettlementAt({
        ...enabled,
        pullRequests: [{ state: "merged", mergedAt: "2026-10-05T12:00:00.000Z" }],
      }),
    ).toBe(at);
  });
  it("keeps linked PRs during inactivity unless the user disables that policy", () => {
    const linked = { ...input, autoSettleAfterDays: 7, pullRequests: [{ state: "open" as const }] };
    expect(resolveAutoSettlementAt(linked)).toBeNull();
    expect(resolveAutoSettlementAt({ ...linked, autoSettleKeepPullRequests: false })).toBe(at);
  });
});
