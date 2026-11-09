import { CommandId, ThreadId, TurnId, type OrchestrationSession } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { makeHistoryRecoveredSessionSet } from "./providerTerminalLifecycle.ts";

describe("makeHistoryRecoveredSessionSet", () => {
  const threadId = ThreadId.makeUnsafe("thread");
  const session: OrchestrationSession = {
    threadId,
    status: "stopped",
    providerName: "codex",
    providerInstanceId: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "Provider output is incomplete.",
    lastErrorId: "incomplete:lost",
    lastErrorOccurredAt: "2026-11-08T00:00:00.000Z",
    lastErrorRetryability: null,
    updatedAt: "2026-11-08T00:00:00.000Z",
  };
  const make = (overrides: Partial<OrchestrationSession> | null, markerId = "incomplete:lost") =>
    makeHistoryRecoveredSessionSet({
      thread: { id: threadId, session: overrides === null ? null : { ...session, ...overrides } },
      markerId,
      commandId: CommandId.makeUnsafe("clear"),
      createdAt: "2026-11-09T00:00:00.000Z",
    });

  it("clears the accepted marker's warning and keeps the session's status", () => {
    // Manual accept stops the session first; the warning must still go.
    expect(make({})?.session).toMatchObject({
      status: "stopped",
      lastError: null,
      lastErrorId: null,
      lastErrorOccurredAt: null,
      updatedAt: "2026-11-09T00:00:00.000Z",
    });
    expect(make({ status: "error" })?.session.status).toBe("ready");
  });

  it("leaves other errors and sessions with a started turn alone", () => {
    expect(make({}, "incomplete:other")).toBeUndefined();
    expect(make({ lastErrorId: "turn-failed" })).toBeUndefined();
    expect(make({ activeTurnId: TurnId.makeUnsafe("next") })).toBeUndefined();
    expect(make({ status: "running" })).toBeUndefined();
    expect(make({ status: "starting" })).toBeUndefined();
    expect(make(null)).toBeUndefined();
  });
});
