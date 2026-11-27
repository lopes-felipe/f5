import * as NodePath from "node:path";

import {
  LEGACY_TOOL_NAME_ALIASES,
  type Options,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

/** Native delegation names in the certified Claude runtime. Task* CRUD is not delegation. */
export const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];
const DELEGATION_ALIASES = new Set(["agent", "task", "subagent", "spawn_agent"]);

const LEGACY_ALIASES_BY_LOWERCASE = new Map(
  Object.entries(LEGACY_TOOL_NAME_ALIASES).map(([legacy, current]) => [
    legacy.toLowerCase(),
    current,
  ]),
);

/** A former tool name (`KillBash`, `Task`) resolved to the name policy checks expect. */
export function canonicalClaudeToolName(toolName: string): string {
  return LEGACY_ALIASES_BY_LOWERCASE.get(toolName.trim().toLowerCase()) ?? toolName;
}

export interface McpToolProvenance {
  readonly name: string;
  readonly source: string;
}

export interface ClaudeMandatoryPolicy {
  readonly noTools?: boolean | undefined;
  readonly workflowExecutionProfile?: "attended-readonly" | "unattended-readonly" | undefined;
  readonly subagentsEnabled?: boolean | undefined;
  /**
   * Host MCP tools that only observe (F5 preview status/snapshot). Read-only
   * workflow stages may call them; the predicate must check exact provenance.
   */
  readonly allowReadOnlyMcpTool?: (
    toolName: string,
    mcpServer?: McpToolProvenance,
    toolInput?: unknown,
  ) => boolean;
  /**
   * Live policy checked by the mandatory hook on every call, including bypass
   * mode. Returns a denial reason. Failures deny. It may await host approval
   * (computer use asks the user even in full-access mode).
   */
  readonly evaluateDynamic?: (
    toolName: string,
    mcpServer: McpToolProvenance | undefined,
    call: { readonly input: PreToolUseHookInput; readonly signal: AbortSignal },
  ) => Promise<string | undefined>;
  /** Where plan mode writes plan files (`<Claude config dir>/plans`). */
  readonly plansDirectory?: string | undefined;
  /**
   * Block the tool when the hook callback throws or times out (`onFailure: "block"`).
   * Only for CLIs that report `hook_on_failure_supported`; the SDK refuses others.
   */
  readonly failClosed?: boolean | undefined;
}

/** Built-in tools that run a shell command; a rename in the SDK's BUILTIN_TOOL_NAMES fails CI. */
export const CLAUDE_SHELL_COMMAND_TOOLS = ["Bash", "Monitor", "PowerShell"] as const;
const SHELL_COMMAND_TOOLS = new Set<string>(
  CLAUDE_SHELL_COMMAND_TOOLS.map((name) => name.toLowerCase()),
);

/**
 * Built-in tools a read-only stage leaves to Claude Code's own plan-mode evaluation, which runs
 * the ones it considers read-only and asks `canUseTool`, and so the full policy, about the rest.
 * None changes anything outside the session, so an allow rule that skips `canUseTool` gains
 * nothing a stage must not do: they read (the web included), or they are how delegation and
 * skills work, and every tool a sub-agent or a skill then calls comes back through the hook.
 * A built-in tool that is not listed here or allowed by the policy is denied by the hook, so a
 * tool a later runtime adds stays off until it is put on a list (the test walks
 * BUILTIN_TOOL_NAMES).
 */
export const CLAUDE_READ_ONLY_NATIVE_TOOLS = [
  "Agent",
  "ListAgents",
  "SubagentHandback",
  "TaskStop",
  "Skill",
  "WebFetch",
  "WebSearch",
  "LSP",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "WaitForMcpServers",
  "ReadNotifications",
  "CronList",
  "ReportFindings",
  "SendUserMessage",
] as const;
const READ_ONLY_NATIVE_TOOLS = new Set<string>([
  ...CLAUDE_READ_ONLY_NATIVE_TOOLS.map((name) => name.toLowerCase()),
  ...DELEGATION_ALIASES,
]);

/**
 * Why a read-only workflow stage refuses this call to a shell tool, as F5's read-only shell
 * classifier puts it, or undefined when the command only reads or the tool runs no command.
 * `Bash` and `Monitor` run a POSIX shell command; a PowerShell script can't be checked.
 */
export function claudeReadOnlyShellRefusal(
  toolName: string,
  toolInput: unknown,
): string | undefined {
  const name = toolName.trim().toLowerCase();
  if (!SHELL_COMMAND_TOOLS.has(name)) return undefined;
  if (name === "powershell")
    return "PowerShell commands can't be checked in a read-only stage: use the Bash tool";
  const input =
    toolInput && typeof toolInput === "object"
      ? (toolInput as { readonly command?: unknown; readonly ws?: unknown; readonly url?: unknown })
      : undefined;
  // `Monitor` can open a WebSocket instead of running a command.
  if (name === "monitor" && (input?.ws !== undefined || input?.url !== undefined))
    return "Monitor can't open a WebSocket in a read-only stage, which is network access: it can only watch a command that reads";
  const command = input?.command;
  if (typeof command !== "string" || command.trim().length === 0)
    return "the command to run was not reported";
  const verdict = classifyReadOnlyShellCommand(command);
  return verdict.readOnly ? undefined : verdict.reason;
}

/** What Claude is told when a read-only stage refuses a shell command. */
const readOnlyShellDenial = (reason: string) =>
  `F5 refused this command, so it did not run: ${reason}. This workflow stage is read-only. Do not retry it: rewrite it as a command that only reads (see the Read-Only Shell Rules), or go on without that result.`;

export function evaluateClaudeMandatoryPolicy(
  policy: ClaudeMandatoryPolicy,
  toolName: string,
  mcpServer?: McpToolProvenance,
  toolInput?: unknown,
): string | undefined {
  if (policy.noTools) return "Tools are disabled for one-off generation.";
  const name = toolName.trim().toLowerCase();
  if (policy.subagentsEnabled === false && DELEGATION_ALIASES.has(name))
    return "Sub-agents are disabled for this project. Complete the work in the main conversation instead.";
  if (policy.workflowExecutionProfile) {
    if (
      [
        "read",
        "glob",
        "grep",
        "notebookread",
        "todoread",
        "todowrite",
        "toolsearch",
        "taskcreate",
        "taskupdate",
        "taskget",
        "tasklist",
        "enterplanmode",
      ].includes(name)
    )
      return;
    // F5 decides every shell command with the classifier the other providers' stages use.
    if (SHELL_COMMAND_TOOLS.has(name)) {
      const refusal = claudeReadOnlyShellRefusal(toolName, toolInput);
      return refusal === undefined ? undefined : readOnlyShellDenial(refusal);
    }
    if (policy.allowReadOnlyMcpTool?.(toolName, mcpServer, toolInput)) return;
    // Interactive questions retain the host's existing answer transport.
    if (name === "askuserquestion" && policy.workflowExecutionProfile === "attended-readonly")
      return;
    if (name === "exitplanmode")
      return "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";
    if (name === "askuserquestion")
      return "This unattended workflow stage has no user reply path. Choose and document a conservative default, then complete the stage artifact.";
    return `Tool '${toolName}' is not permitted in a read-only workflow stage.`;
  }
}

/** Built-in file-editing tools; a rename in the SDK's BUILTIN_TOOL_NAMES fails CI. */
export const CLAUDE_WORKSPACE_MUTATION_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;
// MultiEdit is gone from current runtimes; kept for older custom executables.
const WORKSPACE_MUTATION_TOOLS = new Set([
  ...CLAUDE_WORKSPACE_MUTATION_TOOLS.map((name) => name.toLowerCase()),
  "multiedit",
]);
const PLAN_FILE_TOOLS = new Set(["write", "edit", "multiedit"]);

/** Plan mode writes its plan file natively; that is not a workspace edit. */
function targetsPlansDirectory(
  plansDirectory: string | undefined,
  toolInput: unknown,
  cwd: string | undefined,
): boolean {
  const filePath =
    toolInput && typeof toolInput === "object"
      ? (toolInput as { readonly file_path?: unknown }).file_path
      : undefined;
  if (!plansDirectory || typeof filePath !== "string" || filePath.length === 0) return false;
  const relative = NodePath.relative(
    NodePath.resolve(plansDirectory),
    NodePath.resolve(cwd ?? process.cwd(), filePath),
  );
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

/**
 * The subset of the policy enforced before Claude's native permission check.
 *
 * In a read-only stage that is everything the full policy denies: Claude Code applies a
 * `permissions.allow` rule before it asks `canUseTool`, so a rule in the repository's or your
 * own settings (`Bash(python3:*)`, `mcp__server__tool`, `EnterWorktree`) would otherwise run
 * without F5 seeing the call. A hook denial comes first and no allow rule overrides it.
 *
 * Two kinds of call are left to native plan-mode evaluation, which escalates anything it does
 * not consider read-only to `canUseTool` and its full policy: the built-in tools in
 * CLAUDE_READ_ONLY_NATIVE_TOOLS, and writes to plan mode's own plan file.
 */
export function evaluateClaudeMandatoryHookPolicy(
  policy: ClaudeMandatoryPolicy,
  toolName: string,
  context?: {
    readonly toolInput?: unknown;
    readonly cwd?: string | undefined;
    readonly mcpServer?: McpToolProvenance | undefined;
  },
): string | undefined {
  const reason = evaluateClaudeMandatoryPolicy(
    policy,
    toolName,
    context?.mcpServer,
    context?.toolInput,
  );
  if (!reason || policy.noTools || !policy.workflowExecutionProfile) return reason;
  const name = toolName.trim().toLowerCase();
  if (policy.subagentsEnabled === false && DELEGATION_ALIASES.has(name)) return reason;
  // A tool an MCP server provides is never one of the built-in tools, whatever it is called.
  if (context?.mcpServer === undefined && READ_ONLY_NATIVE_TOOLS.has(name)) return undefined;
  const planFileWrite =
    WORKSPACE_MUTATION_TOOLS.has(name) &&
    !isClaudePlanModeWorkspaceEdit(toolName, context?.toolInput, {
      plansDirectory: policy.plansDirectory,
      cwd: context?.cwd,
    });
  return planFileWrite ? undefined : reason;
}

export const CLAUDE_PLAN_MODE_EDIT_DENIAL =
  "Plan mode is read-only: file edits are not allowed until the plan is approved. Put changes in the plan instead.";

/** True for a file edit that plan mode must not make (plan file writes excepted). */
export function isClaudePlanModeWorkspaceEdit(
  toolName: string,
  toolInput: unknown,
  context: { readonly plansDirectory: string | undefined; readonly cwd: string | undefined },
): boolean {
  const name = toolName.trim().toLowerCase();
  if (!WORKSPACE_MUTATION_TOOLS.has(name)) return false;
  return !(
    PLAN_FILE_TOOLS.has(name) &&
    targetsPlansDirectory(context.plansDirectory, toolInput, context.cwd)
  );
}

/** Empty hook output preserves native permission evaluation; never return allow. */
export function claudeMandatoryPolicyOptions(
  policy: ClaudeMandatoryPolicy,
  hooks?: Options["hooks"],
  onDenied?: (input: PreToolUseHookInput, signal: AbortSignal) => Promise<void>,
): Pick<Options, "hooks" | "disallowedTools" | "tools"> {
  return {
    ...(policy.noTools
      ? { tools: [], disallowedTools: ["*"] }
      : policy.subagentsEnabled === false
        ? { disallowedTools: [...CLAUDE_DELEGATION_TOOLS] }
        : {}),
    hooks: {
      ...hooks,
      PreToolUse: [
        ...(hooks?.PreToolUse ?? []),
        {
          ...(policy.failClosed ? { onFailure: "block" as const } : {}),
          hooks: [
            async (input, _toolUseId, { signal }) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const toolName = canonicalClaudeToolName(input.tool_name);
              let reason: string | undefined;
              try {
                reason = evaluateClaudeMandatoryHookPolicy(policy, toolName, {
                  toolInput: input.tool_input,
                  cwd: input.cwd,
                  mcpServer: input.mcp_server,
                });
              } catch {
                // An older CLI treats a hook that throws as "no decision" and would go on to
                // its allow rules, so the denial has to come from here.
                reason = "F5 could not verify that this tool is allowed.";
              }
              if (!reason && policy.evaluateDynamic) {
                try {
                  reason = await policy.evaluateDynamic(toolName, input.mcp_server, {
                    input,
                    signal,
                  });
                } catch {
                  reason = "F5 could not verify that this tool is allowed.";
                }
              }
              if (reason) {
                try {
                  await onDenied?.(input, signal);
                } catch {
                  // Receipt failures must never weaken mandatory enforcement.
                }
              }
              return reason
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: reason,
                    },
                  }
                : {};
            },
          ],
        },
      ],
    },
  };
}
