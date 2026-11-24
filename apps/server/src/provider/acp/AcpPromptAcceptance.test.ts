import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AcpPromptProgressGate, firePendingAcceptance } from "./AcpPromptAcceptance.ts";

const tool = (toolCallId: string) =>
  ({ _tag: "ToolCallUpdated", toolCall: { toolCallId, data: {} }, rawPayload: {} }) as const;

describe("AcpPromptProgressGate", () => {
  it("counts the agent's work on a prompt, never session-level notices", () => {
    const gate = new AcpPromptProgressGate();
    expect(gate.observe({ _tag: "ContentDelta", text: "hi", rawPayload: {} })).toBe(true);
    expect(gate.observe({ _tag: "AssistantItemStarted", itemId: "a" })).toBe(true);
    expect(gate.observe(tool("t"))).toBe(true);
    expect(gate.observe({ _tag: "PlanUpdated", payload: { plan: [] }, rawPayload: {} })).toBe(true);
    expect(gate.observe({ _tag: "SlashCommandsUpdated", commands: [] })).toBe(false);
    expect(gate.observe({ _tag: "ModeChanged", modeId: "plan" })).toBe(false);
    expect(gate.observe({ _tag: "UsageUpdated", used: 1, size: 2 })).toBe(false);
  });

  it("counts a tool call only the first time, so a late update of an earlier tool proves nothing", () => {
    const gate = new AcpPromptProgressGate();
    expect(gate.observe(tool("earlier"))).toBe(true);
    // The previous turn's tool completes after the next prompt was sent.
    expect(gate.observe(tool("earlier"))).toBe(false);
    expect(gate.observe(tool("new"))).toBe(true);
  });
});

describe("firePendingAcceptance", () => {
  it("runs the acceptance once and forgets it", async () => {
    let calls = 0;
    const ctx = {
      pendingAcceptance: Effect.sync(() => {
        calls += 1;
      }) as Effect.Effect<void> | undefined,
    };
    await Effect.runPromise(firePendingAcceptance(ctx));
    await Effect.runPromise(firePendingAcceptance(ctx));
    expect(ctx.pendingAcceptance).toBeUndefined();
    expect(calls).toBe(1);
  });
});
