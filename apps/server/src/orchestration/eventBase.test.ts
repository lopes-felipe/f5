import { CommandId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import { withEventBase } from "./eventBase.ts";

const VERSION_7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("withEventBase", () => {
  it("gives every event a time-ordered ID", () => {
    const before = Date.now();
    const event = withEventBase({
      commandId: CommandId.makeUnsafe("command-1"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      occurredAt: new Date().toISOString(),
    });
    const after = Date.now();

    assert.match(event.eventId, VERSION_7);
    // The first 48 bits are the creation time, which is what keeps index inserts in order.
    const createdAt = Number.parseInt(event.eventId.replaceAll("-", "").slice(0, 12), 16);
    assert.isAtLeast(createdAt, before);
    assert.isAtMost(createdAt, after);
  });
});
