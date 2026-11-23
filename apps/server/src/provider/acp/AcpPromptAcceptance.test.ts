import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { firePendingAcceptance, isAcpPromptProgress } from "./AcpPromptAcceptance.ts";

describe("isAcpPromptProgress", () => {
  it("counts the agent's work on a prompt, never session-level notices", () => {
    expect(isAcpPromptProgress({ _tag: "ContentDelta", text: "hi", rawPayload: {} })).toBe(true);
    expect(isAcpPromptProgress({ _tag: "AssistantItemStarted", itemId: "a" })).toBe(true);
    expect(
      isAcpPromptProgress({
        _tag: "ToolCallUpdated",
        toolCall: { toolCallId: "t", data: {} },
        rawPayload: {},
      }),
    ).toBe(true);
    expect(
      isAcpPromptProgress({ _tag: "PlanUpdated", payload: { plan: [] }, rawPayload: {} }),
    ).toBe(true);
    expect(isAcpPromptProgress({ _tag: "SlashCommandsUpdated", commands: [] })).toBe(false);
    expect(isAcpPromptProgress({ _tag: "ModeChanged", modeId: "plan" })).toBe(false);
    expect(isAcpPromptProgress({ _tag: "UsageUpdated", used: 1, size: 2 })).toBe(false);
  });
});

describe("firePendingAcceptance", () => {
  it("runs the acceptance once and forgets it", async () => {
    let calls = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const ctx = {
          pendingAcceptance: Effect.sync(() => {
            calls += 1;
          }) as Effect.Effect<void> | undefined,
          scope,
        };
        yield* firePendingAcceptance(ctx);
        yield* firePendingAcceptance(ctx);
        yield* Effect.yieldNow;
        expect(ctx.pendingAcceptance).toBeUndefined();
        yield* Scope.close(scope, Exit.void);
      }),
    );
    expect(calls).toBe(1);
  });
});
