import { afterEach, describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  dismissThreadSessionError,
  resetThreadErrorDismissalsForTests,
  visibleThreadSessionError,
} from "./threadErrorDismissals";

afterEach(resetThreadErrorDismissalsForTests);

describe("thread error dismissals", () => {
  const threadId = ThreadId.make("thread-1");
  const session = {
    threadId,
    status: "error",
    providerName: "codex",
    providerInstanceId: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "Provider failed",
    lastErrorId: "error-1",
    lastErrorOccurredAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
  } as const;

  it("keeps a dismissed occurrence hidden across snapshot remaps", () => {
    expect(visibleThreadSessionError(threadId, session)).toBe("Provider failed");
    dismissThreadSessionError(threadId, "error-1");
    expect(visibleThreadSessionError(threadId, { ...session })).toBeNull();
  });

  it("shows a distinct occurrence even when the text is identical", () => {
    dismissThreadSessionError(threadId, "error-1");
    expect(visibleThreadSessionError(threadId, { ...session, lastErrorId: "error-2" })).toBe(
      "Provider failed",
    );
  });

  it("keeps legacy message-only errors visible", () => {
    expect(
      visibleThreadSessionError(threadId, {
        ...session,
        lastErrorId: null,
        lastErrorOccurredAt: null,
      }),
    ).toBe("Provider failed");
  });
});
