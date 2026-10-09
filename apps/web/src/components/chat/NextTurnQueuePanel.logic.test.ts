import {
  CommandId,
  ThreadId,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeQueueBlockedState,
  isFoldedUsageLimitItem,
  mergeVisibleOrder,
} from "./NextTurnQueuePanel.logic";

describe("isFoldedUsageLimitItem", () => {
  const folded = CommandId.makeUnsafe("folded");
  const item = (
    scheduleReason: NextTurnQueueItem["scheduleReason"],
    status: NextTurnQueueItem["status"],
    itemId = folded,
  ) => ({ itemId, scheduleReason, status }) as NextTurnQueueItem;

  it("folds only the pending continue the card shows", () => {
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "queued"), folded)).toBe(true);
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "dispatching"), folded)).toBe(true);
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "queued"), null)).toBe(false);
    expect(
      isFoldedUsageLimitItem(
        item("usage_limit_reset", "queued", CommandId.makeUnsafe("leftover")),
        folded,
      ),
    ).toBe(false);
  });

  it("keeps failed continues and ordinary turns visible", () => {
    expect(isFoldedUsageLimitItem(item("usage_limit_reset", "failed"), folded)).toBe(false);
    expect(isFoldedUsageLimitItem(item(undefined, "queued"), folded)).toBe(false);
  });
});

describe("mergeVisibleOrder", () => {
  const [a, b, c, hidden] = ["a", "b", "c", "hidden"].map((id) => CommandId.makeUnsafe(id)) as [
    CommandId,
    CommandId,
    CommandId,
    CommandId,
  ];
  const hiddenIds = new Set([hidden]);

  it.each([
    ["front", [hidden, a, b, c], [hidden, c, a, b]],
    ["middle", [a, hidden, b, c], [c, hidden, a, b]],
    ["end", [a, b, c, hidden], [c, a, b, hidden]],
  ] as const)("keeps a hidden item at the %s", (_position, fullOrder, expected) => {
    expect(mergeVisibleOrder(fullOrder, hiddenIds, [c, a, b])).toEqual(expected);
  });
});

describe("describeQueueBlockedState", () => {
  it.each([
    ["usage_limit_reset", "Waiting for the usage limit to reset."],
    ["usage_limit_context_changed", "Provider changed since the limit; review before continuing."],
  ] as const)("describes %s", (reasonCode, message) => {
    expect(
      describeQueueBlockedState({
        threadId: ThreadId.makeUnsafe("limited"),
        items: [],
        revision: 1,
        paused: false,
        blockedKind: "waiting",
        reasonCode,
        reasonDetail: null,
        maxItems: 20,
        quarantinedCount: 0,
      }),
    ).toBe(message);
  });

  it("directs previously paused queues to Resume without promising delivery recovery", () => {
    const snapshot: NextTurnQueueSnapshot = {
      threadId: ThreadId.makeUnsafe("previously-paused"),
      items: [],
      revision: 1,
      paused: true,
      blockedKind: "error",
      reasonCode: "turn_never_started",
      reasonDetail: null,
      maxItems: 10,
      quarantinedCount: 0,
    };
    expect(describeQueueBlockedState(snapshot)).toBe(
      "Resume to recheck the previous message. If the queue pauses again, its delivery is still unconfirmed.",
    );
  });
});
