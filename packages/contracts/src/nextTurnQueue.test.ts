import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  NextTurnQueueItem,
  NextTurnQueueSnapshot,
  NextTurnQueueThreadSummary,
} from "./nextTurnQueue";

describe("usage recovery wire compatibility", () => {
  it("decodes absent recovery metadata in older snapshots to null", () => {
    const snapshot = Schema.decodeUnknownSync(NextTurnQueueSnapshot)({
      threadId: "thread",
      items: [],
      revision: 0,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
    });
    expect(snapshot.usageLimitResume).toBeNull();
    const summary = Schema.decodeUnknownSync(NextTurnQueueThreadSummary)({
      threadId: "thread",
      queuedCount: 0,
      dispatchingCount: 0,
      failedCount: 0,
      paused: false,
    });
    expect(summary.scheduledResumeAt).toBeNull();
    expect(Schema.decodeUnknownSync(NextTurnQueueItem.fields.scheduleReason)(undefined)).toBeNull();
  });
});
