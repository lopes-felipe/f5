import { describe, expect, it } from "vitest";
import type { PreToolUseHookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeMandatoryPolicyOptions,
  evaluateClaudeMandatoryPolicy,
} from "./claudeMandatoryPolicy.ts";

const hookInput = (name: string): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "session",
  transcript_path: "/tmp/transcript",
  cwd: "/tmp",
  tool_name: name,
  tool_input: {},
  tool_use_id: "call",
});

describe("mandatory Claude policy before native permissions", () => {
  it.each(["Agent", "Task", "agent", "task", "SubAgent", "spawn_agent"])(
    "denies delegation through %s",
    async (name) => {
      const options = claudeMandatoryPolicyOptions({ subagentsEnabled: false });
      expect(options.disallowedTools).toEqual(["Agent", "Task"]);
      const result = await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput(name), undefined, {
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(evaluateClaudeMandatoryPolicy({ subagentsEnabled: false }, name)).toContain(
        "disabled",
      );
    },
  );
  it.each(["Bash", "Write", "Edit", "NotebookEdit", "mcp__allow__read", "Agent", "ExitPlanMode"])(
    "denies %s in read-only workflows despite native allow rules",
    async (name) => {
      const options = claudeMandatoryPolicyOptions({
        workflowExecutionProfile: "unattended-readonly",
      });
      const result = await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput(name), undefined, {
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    },
  );
  it("leaves native evaluation intact for a read and preserves configured hooks", async () => {
    const hooks: Options["hooks"] = {
      PreToolUse: [{ hooks: [async () => ({})] }],
      Stop: [{ hooks: [async () => ({})] }],
    };
    const options = claudeMandatoryPolicyOptions(
      { workflowExecutionProfile: "attended-readonly" },
      hooks,
    );
    expect(options.hooks!.Stop).toBe(hooks.Stop);
    expect(options.hooks!.PreToolUse![0]).toBe(hooks.PreToolUse![0]);
    expect(
      await options.hooks!.PreToolUse![1]!.hooks[0]!(hookInput("Read"), undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({});
    expect(
      evaluateClaudeMandatoryPolicy(
        { workflowExecutionProfile: "attended-readonly" },
        "AskUserQuestion",
      ),
    ).toBeUndefined();
    expect(
      evaluateClaudeMandatoryPolicy(
        { workflowExecutionProfile: "unattended-readonly" },
        "AskUserQuestion",
      ),
    ).toContain("conservative default");
  });
  it("lets the read-only predicate see the tool input", () => {
    const policy = {
      workflowExecutionProfile: "unattended-readonly" as const,
      allowReadOnlyMcpTool: (_name: string, _server?: unknown, input?: unknown) =>
        (input as { save?: boolean } | undefined)?.save !== true,
    };
    const snapshot = "mcp__f5_preview__preview_snapshot";
    expect(evaluateClaudeMandatoryPolicy(policy, snapshot, undefined, {})).toBeUndefined();
    expect(evaluateClaudeMandatoryPolicy(policy, snapshot, undefined, { save: true })).toContain(
      "read-only",
    );
  });
  it.each([
    "TodoWrite",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "TaskGet",
    "TaskList",
    "EnterPlanMode",
    "Read",
    "Glob",
    "Grep",
  ])("preserves non-workspace tools in read-only workflows: %s", (name) => {
    expect(
      evaluateClaudeMandatoryPolicy({ workflowExecutionProfile: "unattended-readonly" }, name),
    ).toBeUndefined();
  });
  it("does not confuse MCP inspection with delegation", () => {
    expect(
      evaluateClaudeMandatoryPolicy({ subagentsEnabled: false }, "mcp__x__get_agent_status"),
    ).toBeUndefined();
  });
  it("retains workflow guidance and receipts before returning a mandatory denial", async () => {
    const calls: string[] = [];
    const options = claudeMandatoryPolicyOptions(
      { workflowExecutionProfile: "unattended-readonly" },
      undefined,
      async (input) => {
        calls.push(input.tool_name);
      },
    );
    const result = await options.hooks!.PreToolUse![0]!.hooks[0]!(
      hookInput("ExitPlanMode"),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("captured your proposed plan"),
      },
    });
    expect(calls).toEqual(["ExitPlanMode"]);
  });
  it("still denies if recording the host receipt fails", async () => {
    const options = claudeMandatoryPolicyOptions(
      { workflowExecutionProfile: "unattended-readonly" },
      undefined,
      async () => {
        throw new Error("receipt unavailable");
      },
    );
    expect(
      await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput("Write"), undefined, {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it("disables all one-off tools including MCP and child-agent tools", () => {
    const options = claudeMandatoryPolicyOptions({ noTools: true });
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools).toEqual(["*"]);
    for (const name of ["Read", "Bash", "Agent", "mcp__server__tool"])
      expect(evaluateClaudeMandatoryPolicy({ noTools: true }, name)).toContain("disabled");
  });
});
