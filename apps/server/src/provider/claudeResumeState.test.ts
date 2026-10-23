import { describe, expect, it } from "vitest";
import { readClaudeResumeState, readClaudeNativeResumeMetadata } from "./claudeResumeState.ts";

describe("Claude resume cost baseline", () => {
  it.each([0, 0.123456789, 4.85])("preserves the unrounded total %s", (lastTotalCostUsd) => {
    expect(readClaudeResumeState({ lastTotalCostUsd })?.lastTotalCostUsd).toBe(lastTotalCostUsd);
  });
  it.each([undefined, null, "0.3", -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid or missing totals: %s",
    (lastTotalCostUsd) => {
      expect(readClaudeResumeState({ lastTotalCostUsd })).not.toHaveProperty("lastTotalCostUsd");
    },
  );
});

it("retains a bounded native task's original turn through resume metadata", () => {
  const tasks = readClaudeNativeResumeMetadata({
    backgroundTasks: [
      { taskId: "older", turnId: "original-turn", model: "claude-sonnet-4-6", effort: "low" },
      { taskId: "legacy" },
      { taskId: "malformed", turnId: " " },
      { taskId: "excessive", turnId: "x".repeat(1025) },
    ],
  }).tasks;
  expect(tasks[0]).toMatchObject({
    taskId: "older",
    turnId: "original-turn",
    model: "claude-sonnet-4-6",
    effort: "low",
  });
  for (const task of tasks.slice(1)) expect(task).not.toHaveProperty("turnId");
});
