import {
  CommandId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  makeHistoryRecoveredSessionSet,
  makeCompletedTurnUsageFact,
  type TurnCompletedRuntimeEvent,
} from "./providerTerminalLifecycle.ts";

it("captures Muse identity from the terminal event rather than a replaceable session", () => {
  const thread = {
    id: "thread",
    projectId: "project",
    model: "muse",
    latestTurn: {
      turnId: "turn",
      startedAt: "2026-08-01T12:00:00.000Z",
      requestedAt: "2026-08-01T11:59:00.000Z",
    },
  } as unknown as OrchestrationThread;
  const event = {
    provider: "muse",
    type: "turn.completed",
    turnId: "turn",
    eventId: "completion",
    resumeCursor: { mspSessionId: "original-session" },
    createdAt: "2026-08-01T12:01:00.000Z",
    payload: { state: "completed", usage: { inputTokens: 100, outputTokens: 20 } },
  } as unknown as TurnCompletedRuntimeEvent;
  expect(makeCompletedTurnUsageFact({ event, thread })).toMatchObject({
    nativeSessionId: "original-session",
    startedAt: "2026-08-01T12:00:00.000Z",
  });
});

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
