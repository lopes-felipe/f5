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
    ).toContain("not permitted");
  });
  it("disables all one-off tools including MCP and child-agent tools", () => {
    const options = claudeMandatoryPolicyOptions({ noTools: true });
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools).toEqual(["*"]);
    for (const name of ["Read", "Bash", "Agent", "mcp__server__tool"])
      expect(evaluateClaudeMandatoryPolicy({ noTools: true }, name)).toContain("disabled");
  });
});
