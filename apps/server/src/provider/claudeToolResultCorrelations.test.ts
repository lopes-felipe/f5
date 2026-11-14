import { expect, it } from "vitest";
import { TurnId } from "@t3tools/contracts";
import {
  rememberClaudeToolResultCorrelation,
  MAX_CLAUDE_TOOL_RESULT_CORRELATIONS,
  type ClaudeToolResultCorrelation,
} from "./claudeToolResultCorrelations.ts";

it("bounds notification-only completions without retaining tool inputs", () => {
  const pending = new Map<string, ClaudeToolResultCorrelation>();
  for (let index = 0; index < 1024; index++) {
    const tool = {
      itemId: String(index),
      itemType: "command_execution" as const,
      turnId: TurnId.makeUnsafe("launch-turn"),
      input: { command: "x".repeat(8192) },
    };
    rememberClaudeToolResultCorrelation(pending, tool);
    // Completion refreshes the grace window without growing it.
    rememberClaudeToolResultCorrelation(pending, tool);
    expect(pending.size).toBeLessThanOrEqual(MAX_CLAUDE_TOOL_RESULT_CORRELATIONS);
  }
  expect(pending.has("0")).toBe(false);
  expect(pending.get("1023")).toEqual({
    itemId: "1023",
    itemType: "command_execution",
    turnId: "launch-turn",
  });
  pending.clear();
  expect(pending.size).toBe(0);
});

it("does not retain subagent prompts for tools that have no output stream", () => {
  const pending = new Map<string, ClaudeToolResultCorrelation>();
  rememberClaudeToolResultCorrelation(pending, {
    itemId: "agent",
    itemType: "collab_agent_tool_call",
  });
  expect(pending.size).toBe(0);
});
