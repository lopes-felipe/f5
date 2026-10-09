import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
  type OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveUsageLimitNotice } from "./UsageLimitNotice.logic";

const threadId = ThreadId.makeUnsafe("usage-notice-logic");
const resumeId = CommandId.makeUnsafe("resume");
const limit: OrchestrationUsageLimit = {
  windows: [{ id: "five_hour", label: "5-hour", resetsAt: "2026-10-08T12:00:00.000Z" }],
  resetsAt: "2026-10-08T12:00:00.000Z",
  resetSource: "provider",
  evidence: "typed",
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("failed-turn"),
  deliveryId: null,
};

function snapshot(
  status: NextTurnQueueItem["status"] | null,
  ledgerState: "scheduled" | "completed" = "scheduled",
  limitKey = "instance:claude:turn:failed-turn",
): NextTurnQueueSnapshot {
  return {
    threadId,
    revision: 1,
    paused: false,
    blockedKind: null,
    reasonCode: null,
    reasonDetail: null,
    maxItems: 20,
    quarantinedCount: 0,
    usageLimitResume: {
      limitKey,
      resetsAt: limit.resetsAt,
      source: "auto",
      state: ledgerState,
      itemId: resumeId,
    },
    items: status
      ? [{ itemId: resumeId, scheduleReason: "usage_limit_reset", status } as NextTurnQueueItem]
      : [],
  };
}

describe("resolveUsageLimitNotice", () => {
  it("folds the pending continue the card shows", () => {
    expect(resolveUsageLimitNotice(limit, snapshot("queued")).foldedItemId).toBe(resumeId);
    expect(resolveUsageLimitNotice(limit, snapshot("dispatching")).foldedItemId).toBe(resumeId);
  });

  it("leaves a continue in the queue when the card does not own it", () => {
    const otherKey = snapshot("queued", "scheduled", "instance:claude:turn:previous-turn");
    expect(resolveUsageLimitNotice(limit, otherKey).foldedItemId).toBeNull();
    const rejected = { ...limit, turnId: null, deliveryId: "delivery" };
    expect(resolveUsageLimitNotice(rejected, snapshot("queued")).foldedItemId).toBeNull();
    expect(resolveUsageLimitNotice(limit, snapshot("failed")).foldedItemId).toBeNull();
  });

  it("hides the card once the continue has been sent", () => {
    expect(resolveUsageLimitNotice(limit, snapshot(null, "completed")).hidden).toBe(true);
    expect(resolveUsageLimitNotice(limit, snapshot(null)).hidden).toBe(true);
    expect(resolveUsageLimitNotice(limit, snapshot("queued")).hidden).toBe(false);
    expect(resolveUsageLimitNotice(limit, null).hidden).toBe(false);
  });
});
