import { ThreadId, type NextTurnQueueSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { describeQueueBlockedState } from "./NextTurnQueuePanel.logic";

describe("describeQueueBlockedState", () => {
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
