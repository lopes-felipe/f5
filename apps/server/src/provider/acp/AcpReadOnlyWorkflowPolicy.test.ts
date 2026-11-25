import { describe, expect, it } from "vitest";

import { acpExecuteCommand, acpReadOnlyWorkflowDecision } from "./AcpReadOnlyWorkflowPolicy.ts";

const decide = (
  toolCall: Parameters<typeof acpReadOnlyWorkflowDecision>[0]["toolCall"],
  computerRequest = false,
) => acpReadOnlyWorkflowDecision({ toolCall, computerRequest });

describe("acpReadOnlyWorkflowDecision", () => {
  it("allows fetch, search, read and think tools", () => {
    for (const kind of ["fetch", "search", "read", "think"])
      expect(decide({ kind, title: "Fetch https://github.com/x/y/pull/1/" })).toBe("allow");
  });

  it("allows execute only for read-only commands (Cursor shape)", () => {
    expect(
      decide({
        kind: "execute",
        title: "`gh pr view 1 --repo x/y --json title`",
        rawInput: { command: "gh pr view 1 --repo x/y --json title" },
      }),
    ).toBe("allow");
    expect(
      decide({ kind: "execute", title: "`rm -rf x`", rawInput: { command: "rm -rf x" } }),
    ).toBe("deny");
    expect(decide({ kind: "execute", title: "`git status`" })).toBe("deny");
  });

  it("denies edits and unknown kinds", () => {
    for (const kind of ["edit", "delete", "move", "other", "switch_mode", undefined])
      expect(decide({ kind, title: "tool" })).toBe("deny");
  });

  it("denies MCP and computer requests even when the kind reads as read-only", () => {
    expect(decide({ kind: "read", title: "mcp__github__get_issue" })).toBe("deny");
    expect(decide({ kind: "execute", rawInput: { command: "ls", serverName: "x" } })).toBe("deny");
    expect(decide({ kind: "read", title: "screenshot" }, true)).toBe("deny");
  });
});

describe("acpExecuteCommand", () => {
  it("reads only raw-input command strings", () => {
    expect(acpExecuteCommand({ command: "ls" })).toBe("ls");
    expect(acpExecuteCommand({ CommandLine: "git log" })).toBe("git log");
    expect(acpExecuteCommand({ executable: "git", args: ["log"] })).toBeUndefined();
    expect(acpExecuteCommand({ command: ["git", "log"] })).toBeUndefined();
    expect(acpExecuteCommand(undefined)).toBeUndefined();
  });
});
