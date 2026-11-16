import { describe, expect, it } from "vitest";

import { claudeSkillToolTitle, deriveToolActivityPresentation } from "./toolActivity";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});

it.each([
  ["Skill", { skill: " team:review " }, "Skill: team:review"],
  ["Skill", { skill: "" }, undefined],
  ["Skill", { skill: 42 }, undefined],
  ["Skill", { skill: "a".repeat(513) }, undefined],
  ["Bash", { skill: "review" }, undefined],
  ["Skill", null, undefined],
])("derives bounded skill titles for %s", (toolName, input, expected) => {
  expect(claudeSkillToolTitle(toolName as string, input)).toBe(expected);
});
