import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { nextClaudeGoal, readClaudeGoal } from "./claudeGoal.ts";

const active = { objective: "All tests pass", status: "active", checks: 2 } as const;
const output = (text: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { model: "<synthetic>", content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

describe("Claude goal transcript updates", () => {
  it.each(["Goal cleared: All tests pass", "No goal set. Use /goal to set one."])(
    "clears on native output %s",
    (text) => {
      expect(nextClaudeGoal(active, output(text))).toBeNull();
    },
  );
  it.each([
    ["Goal active: All tests pass (not yet evaluated)", 0],
    ["Goal active: All tests pass (1 turn)", 1],
    ["Goal active: All tests pass (8 turns)", 8],
  ] as const)("reads native status %s", (text, checks) => {
    expect(nextClaudeGoal(active, output(text))).toEqual({ ...active, checks });
  });
  it("keeps multiline objectives and check feedback", () => {
    expect(nextClaudeGoal(null, output("Goal set: Tests pass\nand build succeeds"))).toEqual({
      objective: "Tests pass\nand build succeeds",
      status: "active",
      checks: 0,
    });
    expect(
      nextClaudeGoal(
        { ...active, lastCheck: "Try again" },
        output("Goal active: All tests pass (2 turns)"),
      ),
    ).toEqual({ ...active, lastCheck: "Try again" });
  });
  it.each([
    "Goal set: ",
    "Goal active: Tests pass (999999999999999999999 turns)",
    "All done",
    `Goal set: ${"x".repeat(16001)}`,
  ])("ignores malformed or unrelated native output", (text) => {
    expect(nextClaudeGoal(active, output(text))).toBeUndefined();
  });
  it.each([
    null,
    {},
    { ...active, status: "bogus" },
    { ...active, checks: -1 },
    { ...active, checks: 1.5 },
    { ...active, objective: " " },
  ])("rejects invalid persisted state", (value) => {
    expect(readClaudeGoal(value)).toBeNull();
  });
  it("restores valid bounded state", () => {
    expect(readClaudeGoal(active)).toEqual(active);
    expect(readClaudeGoal({ ...active, lastCheck: "a".repeat(20000) })?.lastCheck).toHaveLength(
      16000,
    );
  });
  it("does not count a real user quoting hook feedback or a child hook", () => {
    const feedback = {
      type: "user",
      parent_tool_use_id: null,
      isSynthetic: false,
      message: { content: "Stop hook feedback:\n[All tests pass]: Try harder" },
    };
    expect(nextClaudeGoal(active, feedback as unknown as SDKMessage)).toBeUndefined();
    expect(
      nextClaudeGoal(active, {
        ...feedback,
        isSynthetic: true,
        parent_tool_use_id: "child",
      } as unknown as SDKMessage),
    ).toBeUndefined();
  });
});
