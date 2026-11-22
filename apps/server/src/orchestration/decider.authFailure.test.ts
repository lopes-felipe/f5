import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { carryAuthFailure } from "./decider.ts";

const threadId = ThreadId.makeUnsafe("auth-thread");
const failure = {
  providerInstanceId: ProviderInstanceId.makeUnsafe("claude"),
  turnId: TurnId.makeUnsafe("failed-turn"),
  occurredAt: "2026-11-22T12:59:00.000Z",
};
const previous = {
  threadId,
  status: "error" as const,
  providerName: "claudeAgent",
  providerInstanceId: failure.providerInstanceId,
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: "Claude login expired",
  lastErrorId: "runtime-error",
  authFailure: failure,
  updatedAt: failure.occurredAt,
};
const next = (patch: Record<string, unknown>) =>
  ({ ...previous, authFailure: undefined, ...patch }) as Parameters<typeof carryAuthFailure>[0];

describe("carryAuthFailure", () => {
  it("keeps the failure while the failed turn completes with an error", () => {
    expect(carryAuthFailure(next({ lastErrorId: "turn-completed" }), previous)).toEqual(failure);
  });

  it("uses an explicit value, including an explicit clear", () => {
    expect(carryAuthFailure(next({ authFailure: null }), previous)).toBeNull();
  });

  it("ends when a different turn starts", () => {
    expect(
      carryAuthFailure(next({ status: "running", activeTurnId: "next-turn" }), previous),
    ).toBeNull();
  });

  it("ends when the error clears", () => {
    expect(carryAuthFailure(next({ status: "ready", lastError: null }), previous)).toBeNull();
  });

  it("ends when the session moves to another provider account", () => {
    expect(
      carryAuthFailure(
        next({ providerInstanceId: ProviderInstanceId.makeUnsafe("other") }),
        previous,
      ),
    ).toBeNull();
  });
});
