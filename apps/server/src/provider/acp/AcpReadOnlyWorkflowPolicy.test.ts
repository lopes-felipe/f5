import { describe, expect, it } from "vitest";

import {
  acpExecuteCommand,
  acpReadOnlyRefusalDetail,
  acpReadOnlyWorkflowDecision,
  acpReadOnlyWorkflowVerdict,
  acpRequestWithoutToolCallId,
} from "./AcpReadOnlyWorkflowPolicy.ts";

const decide = (
  toolCall: Parameters<typeof acpReadOnlyWorkflowDecision>[0]["toolCall"],
  computerRequest = false,
) => acpReadOnlyWorkflowDecision({ toolCall, computerRequest });

const reasonOf = (toolCall: Parameters<typeof acpReadOnlyWorkflowVerdict>[0]["toolCall"]) => {
  const verdict = acpReadOnlyWorkflowVerdict({ toolCall, computerRequest: false });
  return verdict.decision === "deny" ? verdict.reason : undefined;
};

describe("acpRequestWithoutToolCallId", () => {
  it("drops only the tool call's id, so a repeated request reads the same", () => {
    const request = (toolCallId: string) => ({
      sessionId: "s1",
      toolCall: { toolCallId, kind: "other", title: "Do something", rawInput: { a: 1 } },
      options: [{ optionId: "reject-once", kind: "reject_once" }],
    });
    expect(acpRequestWithoutToolCallId(request("call-1"))).toEqual({
      sessionId: "s1",
      toolCall: { kind: "other", title: "Do something", rawInput: { a: 1 } },
      options: [{ optionId: "reject-once", kind: "reject_once" }],
    });
    expect(JSON.stringify(acpRequestWithoutToolCallId(request("call-1")))).toBe(
      JSON.stringify(acpRequestWithoutToolCallId(request("call-2"))),
    );
  });

  it("returns anything that isn't a request with a tool call as it is", () => {
    for (const value of [undefined, null, "text", [1], { sessionId: "s1" }, { toolCall: "x" }])
      expect(acpRequestWithoutToolCallId(value)).toBe(value);
  });
});

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

  it("denies a read-only command that asks to leave the sandbox (Antigravity shape)", () => {
    // The live certification run on 2026-11-25: the model retried a sandboxed `gh api zen`
    // with BypassSandbox, and approving it reached GitHub from outside the sandbox.
    const toolCall = (rawInput: Record<string, unknown>) => ({
      kind: "execute",
      title: "gh api zen",
      rawInput: { CommandLine: "gh api zen", WaitMsBeforeAsync: 10000, ...rawInput },
    });
    expect(decide(toolCall({ BypassSandbox: false }))).toBe("allow");
    expect(decide(toolCall({}))).toBe("allow");
    expect(decide(toolCall({ BypassSandbox: true }))).toBe("deny");
    expect(decide(toolCall({ BypassSandbox: "true" }))).toBe("deny");
    expect(decide(toolCall({ bypass_sandbox: 1 }))).toBe("deny");
    expect(decide(toolCall({ dangerouslyDisableSandbox: true }))).toBe("deny");
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

  it("classifies a shell command that only mentions an MCP name as the command it is", () => {
    // Recorded on 2026-11-26: a command's title is its own text, so a path under `src/mcp/`
    // read as an MCP tool call and was refused.
    for (const command of [
      "git log --oneline -3 -- apps/server/src/mcp/OrchestratorMcpService.test.ts",
      "rg -n 'mcp__github__get_issue' docs",
      "git show abc:apps/server/src/mcp_tools.ts | head",
      "cat mcp.json",
    ]) {
      expect(decide({ kind: "execute", title: command, rawInput: { command } })).toBe("allow");
      expect(decide({ kind: "execute", title: command, rawInput: { CommandLine: command } })).toBe(
        "allow",
      );
    }
    // It is still classified: mentioning MCP doesn't make a write read-only.
    const write = "rm apps/server/src/mcp/x.ts";
    expect(decide({ kind: "execute", title: write, rawInput: { command: write } })).toBe("deny");
  });

  it("still treats a call titled as an MCP tool as one, whatever its kind", () => {
    for (const title of [
      "Run mcp_github_get_issue",
      "mcp__github__get_issue",
      "MCP: github / get_issue",
      "  mcp_github_get_issue",
    ]) {
      // With a command string too: the title's own form says what is being called.
      expect(decide({ kind: "execute", title, rawInput: { command: "ls" } })).toBe("deny");
      expect(decide({ kind: "other", title })).toBe("deny");
    }
    // Without a command string the title is all there is, so a mention anywhere counts.
    expect(decide({ kind: "read", title: "Read via mcp__github__get_file" })).toBe("deny");
    expect(decide({ kind: "execute", title: "Call mcp__github__get_file" })).toBe("deny");
    // A server key marks MCP even on a command that only reads.
    expect(
      decide({ kind: "execute", title: "ls", rawInput: { command: "ls", ServerName: "github" } }),
    ).toBe("deny");
  });

  it.each([
    ["Cursor", "mcp__github__run_command"],
    ["Antigravity, permission request", "MCP: github / run_command"],
    ["Antigravity, tool call", "Run mcp_github_run_command"],
  ])("refuses an MCP tool that carries a command, as %s titles it", (_provider, title) => {
    // The assumption `acpMcpToolCall` documents: each provider puts its MCP form first in the
    // title. A provider that changes its form must fail here, not run the tool's command.
    for (const rawInput of [{ command: "ls" }, { CommandLine: "ls" }])
      expect(reasonOf({ kind: "execute", title, rawInput })).toBe(
        "only F5's read-only tools may be called over MCP in a read-only stage",
      );
  });

  it("classifies an execute request by its command when the title has no MCP form first", () => {
    // The documented limit of the title check: nothing but a server key or the title's start
    // tells an MCP tool with a `command` argument from a shell command.
    const title = "github: run (mcp_shell_run)";
    expect(decide({ kind: "execute", title, rawInput: { command: "ls" } })).toBe("allow");
    expect(decide({ kind: "execute", title, rawInput: { command: "rm x" } })).toBe("deny");
    expect(decide({ kind: "execute", title, rawInput: { command: "ls", server: "github" } })).toBe(
      "deny",
    );
  });

  it("says why it refused", () => {
    const reason = (
      toolCall: Parameters<typeof acpReadOnlyWorkflowVerdict>[0]["toolCall"],
      computerRequest = false,
    ) => {
      const verdict = acpReadOnlyWorkflowVerdict({ toolCall, computerRequest });
      return verdict.decision === "deny" ? verdict.reason : undefined;
    };
    expect(reason({ kind: "execute", title: "touch x", rawInput: { command: "touch x" } })).toBe(
      "`touch` is not on the read-only allowlist",
    );
    expect(
      reason({ kind: "execute", title: "ls", rawInput: { command: "ls", BypassSandbox: true } }),
    ).toContain("outside the sandbox");
    expect(reason({ kind: "execute", title: "`git status`" })).toContain("was not reported");
    expect(reason({ kind: "edit", title: "Edit a.ts" })).toBe(
      "edit operations are not allowed in a read-only stage",
    );
    expect(reason({ title: "tool" })).toBe("the operation has no kind");
    expect(reason({ kind: "other", title: "Run mcp_github_get_issue" })).toContain(
      "only F5's read-only tools",
    );
    expect(reason({ kind: "read", title: "screenshot" }, true)).toContain("computer control");
    expect(reason({ kind: "read", title: "Read a.ts" })).toBeUndefined();
    expect(acpReadOnlyRefusalDetail("touch x", "`touch` is not on the read-only allowlist")).toBe(
      "touch x (`touch` is not on the read-only allowlist)",
    );
    expect(acpReadOnlyRefusalDetail(undefined, "the operation has no kind")).toBe(
      "the operation has no kind",
    );
  });

  it("allows only F5's read-only thread server among MCP calls, by its generated name", () => {
    const f5ThreadServerName = "f5_thread_0a1b2c3d";
    const decideWithF5 = (
      toolCall: Parameters<typeof acpReadOnlyWorkflowDecision>[0]["toolCall"],
    ) => acpReadOnlyWorkflowDecision({ toolCall, computerRequest: false, f5ThreadServerName });
    expect(decideWithF5({ title: "mcp__f5_thread_0a1b2c3d__pull_request_read" })).toBe("allow");
    expect(decideWithF5({ kind: "other", title: "MCP: f5_thread_0a1b2c3d / ci_logs" })).toBe(
      "allow",
    );
    // Without an MCP signal the call is judged by its kind like any other.
    expect(decideWithF5({ kind: "other", title: "f5_thread_0a1b2c3d: ci_logs" })).toBe("deny");
    expect(
      decideWithF5({
        kind: "other",
        rawInput: { serverName: f5ThreadServerName, tool: "ci_logs" },
      }),
    ).toBe("allow");
    // Other servers, look-alike names and mutating kinds stay denied.
    expect(decideWithF5({ title: "mcp__github__get_file_contents" })).toBe("deny");
    expect(decideWithF5({ title: "mcp__f5_thread_0a1b2c3d9__ci_logs" })).toBe("deny");
    expect(decideWithF5({ title: "mcp__f5_thread__ci_logs" })).toBe("deny");
    expect(
      decideWithF5({ rawInput: { server: "github", note: f5ThreadServerName }, title: "mcp_x" }),
    ).toBe("deny");
    expect(
      decideWithF5({
        kind: "execute",
        title: "`echo mcp__f5_thread_0a1b2c3d__x`",
        rawInput: { command: "echo mcp__f5_thread_0a1b2c3d__x > out" },
      }),
    ).toBe("deny");
    // Antigravity's permission request: title `Run mcp_<server>_<tool>` and capitalised keys.
    expect(
      decideWithF5({
        kind: "other",
        title: "Run mcp_f5_thread_0a1b2c3d_ci_logs",
        rawInput: { ServerName: f5ThreadServerName, ToolName: "ci_logs", Arguments: "{}" },
      }),
    ).toBe("allow");
    expect(decideWithF5({ kind: "other", title: "Run mcp_f5_thread_0a1b2c3d_ci_logs" })).toBe(
      "allow",
    );
    expect(
      decideWithF5({
        kind: "read",
        title: "Run mcp_f5_certification_read_project_status",
        rawInput: { ServerName: "f5_certification", ToolName: "read_project_status" },
      }),
    ).toBe("deny");
    // F5's server, but a tool outside the read-only catalog.
    expect(
      decideWithF5({
        kind: "other",
        rawInput: { ServerName: f5ThreadServerName, ToolName: "pull_request_merge" },
      }),
    ).toBe("deny");
    expect(decideWithF5({ title: "mcp__f5_thread_0a1b2c3d__pull_request_merge" })).toBe("deny");
    // The F5 server named later in a title, where the model's arguments can appear.
    expect(decideWithF5({ title: "mcp__github__create_issue (f5_thread_0a1b2c3d)" })).toBe("deny");
    expect(decideWithF5({ title: "mcp__fs__write_file `mcp__f5_thread_0a1b2c3d__ci_logs`" })).toBe(
      "deny",
    );
    expect(decideWithF5({ title: "mcp__f5_thread_0a1b2c3d__ci_logsx" })).toBe("deny");
    // Without an attached server nothing MCP is allowed.
    expect(decide({ title: "mcp__f5_thread_0a1b2c3d__pull_request_read" })).toBe("deny");
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
