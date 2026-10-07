import { ThreadId, type NextTurnQueueSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { describeQueueBlockedState } from "./NextTurnQueuePanel.logic";

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
