import { describe, expect, it } from "vitest";
import type { PreToolUseHookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeMandatoryPolicyOptions,
  evaluateClaudeMandatoryHookPolicy,
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
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit", "ExitPlanMode", "AskUserQuestion"])(
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
  it.each(["Bash", "mcp__allow__read", "Agent", "WebFetch"])(
    "leaves %s to native plan-mode evaluation in read-only workflows",
    async (name) => {
      const calls: string[] = [];
      const options = claudeMandatoryPolicyOptions(
        { workflowExecutionProfile: "unattended-readonly" },
        undefined,
        async (input) => {
          calls.push(input.tool_name);
        },
      );
      const result = await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput(name), undefined, {
        signal: new AbortController().signal,
      });
      expect(result).toEqual({});
      expect(calls).toEqual([]);
      // Escalations from native evaluation still reach canUseTool's full policy.
      expect(
        evaluateClaudeMandatoryPolicy({ workflowExecutionProfile: "unattended-readonly" }, name),
      ).toContain("not permitted");
    },
  );
  it("allows plan-file writes but no other file edits in read-only workflows", () => {
    const policy = {
      workflowExecutionProfile: "attended-readonly" as const,
      plansDirectory: "/home/me/.claude/plans",
    };
    const decide = (toolName: string, filePath: string) =>
      evaluateClaudeMandatoryHookPolicy(policy, toolName, {
        toolInput: { file_path: filePath },
        cwd: "/repo",
      });
    expect(decide("Write", "/home/me/.claude/plans/quiet-fox.md")).toBeUndefined();
    expect(decide("Edit", "/home/me/.claude/plans/quiet-fox.md")).toBeUndefined();
    expect(decide("Write", "/repo/src/index.ts")).toContain("not permitted");
    expect(decide("Write", "src/index.ts")).toContain("not permitted");
    expect(decide("Write", "/home/me/.claude/plans/../settings.json")).toContain("not permitted");
    expect(decide("Write", "/home/me/.claude/plans")).toContain("not permitted");
    expect(
      evaluateClaudeMandatoryHookPolicy(policy, "NotebookEdit", {
        toolInput: { file_path: "/home/me/.claude/plans/x.ipynb" },
      }),
    ).toContain("not permitted");
    expect(
      evaluateClaudeMandatoryHookPolicy(
        { workflowExecutionProfile: "attended-readonly" },
        "Write",
        { toolInput: { file_path: "/home/me/.claude/plans/quiet-fox.md" } },
      ),
    ).toContain("not permitted");
  });
  it("still denies delegation in read-only workflows when sub-agents are disabled", () => {
    expect(
      evaluateClaudeMandatoryHookPolicy(
        { workflowExecutionProfile: "unattended-readonly", subagentsEnabled: false },
        "Agent",
      ),
    ).toContain("Sub-agents are disabled");
  });
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
