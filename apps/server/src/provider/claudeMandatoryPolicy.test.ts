import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  LEGACY_TOOL_NAME_ALIASES,
  type PreToolUseHookInput,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_DELEGATION_TOOLS,
  CLAUDE_SHELL_COMMAND_TOOLS,
  CLAUDE_WORKSPACE_MUTATION_TOOLS,
  canonicalClaudeToolName,
  claudeMandatoryPolicyOptions,
  claudeReadOnlyShellRefusal,
  evaluateClaudeMandatoryHookPolicy,
  evaluateClaudeMandatoryPolicy,
  isClaudePlanModeWorkspaceEdit,
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
  it.each(["Agent", "WebFetch"])(
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
  describe("shell commands and MCP tools in read-only workflows", () => {
    const policy = {
      workflowExecutionProfile: "unattended-readonly" as const,
      allowReadOnlyMcpTool: (name: string) => name === "mcp__f5_preview__preview_snapshot",
    };
    const runHook = async (name: string, toolInput: unknown, denied: string[] = []) =>
      claudeMandatoryPolicyOptions(policy, undefined, async (input) => {
        denied.push(input.tool_name);
      }).hooks!.PreToolUse![0]!.hooks[0]!(
        { ...hookInput(name), tool_input: toolInput },
        undefined,
        {
          signal: new AbortController().signal,
        },
      );
    const denial = (reason: string) => ({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(reason),
      },
    });

    // An allow rule (`Bash(python3:*)`, `Bash(touch:*)`) is applied after the hook, so the hook
    // has to be the one that refuses.
    it.each([
      ['python3 -c \'open("x", "w")\'', "`python3` is not on the read-only allowlist"],
      ["touch x", "`touch` is not on the read-only allowlist"],
      ["git log > log.txt", "F5 refused this command, so it did not run"],
      ["git fetch origin", "F5 refused this command, so it did not run"],
    ])("the hook denies `%s` with the classifier's reason", async (command, reason) => {
      const denied: string[] = [];
      expect(await runHook("Bash", { command }, denied)).toMatchObject(denial(reason));
      expect(denied).toEqual(["Bash"]);
      expect(claudeReadOnlyShellRefusal("Bash", { command })).toBeTypeOf("string");
    });

    it.each([
      "git log --oneline -5",
      "git show HEAD:README.md | nl -ba",
      "cd apps && git grep -n x",
    ])("the hook and canUseTool's policy both pass `%s`", async (command) => {
      const denied: string[] = [];
      expect(await runHook("Bash", { command }, denied)).toEqual({});
      expect(denied).toEqual([]);
      expect(evaluateClaudeMandatoryPolicy(policy, "Bash", undefined, { command })).toBeUndefined();
      expect(claudeReadOnlyShellRefusal("Bash", { command })).toBeUndefined();
    });

    it("tells Claude not to retry a refused command", async () => {
      expect(await runHook("Bash", { command: "touch x" })).toMatchObject(
        denial("Do not retry it: rewrite it as a command that only reads"),
      );
    });

    it("classifies a Monitor command like a Bash one", async () => {
      expect(await runHook("Monitor", { command: "git status --short" })).toEqual({});
      expect(await runHook("Monitor", { command: "bun run dev" })).toMatchObject(
        denial("`bun` is not on the read-only allowlist"),
      );
    });

    it("refuses PowerShell, which the classifier can't read", async () => {
      expect(await runHook("PowerShell", { command: "Get-Content x" })).toMatchObject(
        denial("use the Bash tool"),
      );
    });

    it.each([[{}], [{ command: "" }], [{ command: 7 }], [undefined]])(
      "denies a shell call that reports no command: %j",
      async (toolInput) => {
        expect(await runHook("Bash", toolInput)).toMatchObject(
          denial("the command to run was not reported"),
        );
      },
    );

    it("denies an MCP tool outside F5's read-only set and passes one inside it", async () => {
      const denied: string[] = [];
      expect(await runHook("mcp__allow__read", {}, denied)).toMatchObject(
        denial("Tool 'mcp__allow__read' is not permitted in a read-only workflow stage."),
      );
      expect(denied).toEqual(["mcp__allow__read"]);
      expect(await runHook("mcp__f5_preview__preview_snapshot", {})).toEqual({});
    });

    it("denies a tool an MCP server provides under another name", () => {
      expect(
        evaluateClaudeMandatoryHookPolicy(policy, "lookup", {
          mcpServer: { name: "other", source: "project" },
        }),
      ).toContain("not permitted");
    });

    it("says nothing about a tool that runs no shell command", () => {
      expect(claudeReadOnlyShellRefusal("Read", { command: "touch x" })).toBeUndefined();
      expect(claudeReadOnlyShellRefusal("WebFetch", {})).toBeUndefined();
    });

    it("leaves shell commands alone outside a workflow stage", async () => {
      const options = claudeMandatoryPolicyOptions({});
      expect(
        await options.hooks!.PreToolUse![0]!.hooks[0]!(
          { ...hookInput("Bash"), tool_input: { command: "touch x" } },
          undefined,
          { signal: new AbortController().signal },
        ),
      ).toEqual({});
    });

    it("denies when the policy itself throws", async () => {
      const options = claudeMandatoryPolicyOptions({
        workflowExecutionProfile: "unattended-readonly",
        allowReadOnlyMcpTool: () => {
          throw new Error("preview registry unavailable");
        },
      });
      expect(
        await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput("mcp__x__y"), undefined, {
          signal: new AbortController().signal,
        }),
      ).toMatchObject(denial("F5 could not verify that this tool is allowed."));
    });
  });
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
  it("classifies plan-mode workspace edits, excluding plan-file writes", () => {
    const context = { plansDirectory: "/home/me/.claude/plans", cwd: "/repo" };
    const edits = (toolName: string, filePath: string) =>
      isClaudePlanModeWorkspaceEdit(toolName, { file_path: filePath }, context);
    expect(edits("Write", "/home/me/.claude/plans/quiet-fox.md")).toBe(false);
    expect(edits("Edit", "/home/me/.claude/plans/quiet-fox.md")).toBe(false);
    expect(edits("Write", "/repo/src/index.ts")).toBe(true);
    expect(edits("Edit", "src/index.ts")).toBe(true);
    expect(edits("NotebookEdit", "/home/me/.claude/plans/x.ipynb")).toBe(true);
    expect(edits("Bash", "/repo/src/index.ts")).toBe(false);
    expect(
      isClaudePlanModeWorkspaceEdit(
        "Write",
        { file_path: "/home/me/.claude/plans/quiet-fox.md" },
        { plansDirectory: undefined, cwd: "/repo" },
      ),
    ).toBe(true);
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
  it("blocks the tool when the hook fails only when the CLI can honor it", () => {
    expect(
      claudeMandatoryPolicyOptions({ failClosed: true }).hooks!.PreToolUse![0]!.onFailure,
    ).toBe("block");
    expect(claudeMandatoryPolicyOptions({}).hooks!.PreToolUse![0]).not.toHaveProperty("onFailure");
  });
  it("evaluates a former tool name as its current one", async () => {
    expect(canonicalClaudeToolName("KillBash")).toBe("TaskStop");
    expect(canonicalClaudeToolName("task")).toBe("Agent");
    expect(canonicalClaudeToolName("Write")).toBe("Write");
    const dynamic: string[] = [];
    const options = claudeMandatoryPolicyOptions({
      evaluateDynamic: async (name) => {
        dynamic.push(name);
        return undefined;
      },
    });
    await options.hooks!.PreToolUse![0]!.hooks[0]!(hookInput("KillShell"), undefined, {
      signal: new AbortController().signal,
    });
    expect(dynamic).toEqual(["TaskStop"]);
  });
  it("only names tools the bundled runtime still has (or a legacy alias of one)", () => {
    const builtins = new Set<string>(BUILTIN_TOOL_NAMES);
    for (const name of CLAUDE_WORKSPACE_MUTATION_TOOLS) expect(builtins, name).toContain(name);
    for (const name of CLAUDE_SHELL_COMMAND_TOOLS) expect(builtins, name).toContain(name);
    for (const name of CLAUDE_DELEGATION_TOOLS)
      expect(builtins.has(name) || builtins.has(LEGACY_TOOL_NAME_ALIASES[name] ?? ""), name).toBe(
        true,
      );
  });
});
