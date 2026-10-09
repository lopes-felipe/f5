import * as NodePath from "node:path";

import type { Options, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/** Native delegation names in the certified Claude runtime. Task* CRUD is not delegation. */
export const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];
const DELEGATION_ALIASES = new Set(["agent", "task", "subagent", "spawn_agent"]);

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
}

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

const WORKSPACE_MUTATION_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
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
 * Read-only stages run in plan mode, so everything else (Bash, MCP, web, and
 * delegation tools) is left to native evaluation, which escalates anything it
 * does not consider read-only to `canUseTool` and its full policy.
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
  if (name === "exitplanmode" || name === "askuserquestion") return reason;
  if (!WORKSPACE_MUTATION_TOOLS.has(name)) return undefined;
  return PLAN_FILE_TOOLS.has(name) &&
    targetsPlansDirectory(policy.plansDirectory, context?.toolInput, context?.cwd)
    ? undefined
    : reason;
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
          hooks: [
            async (input, _toolUseId, { signal }) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              let reason = evaluateClaudeMandatoryHookPolicy(policy, input.tool_name, {
                toolInput: input.tool_input,
                cwd: input.cwd,
                mcpServer: input.mcp_server,
              });
              if (!reason && policy.evaluateDynamic) {
                try {
                  reason = await policy.evaluateDynamic(input.tool_name, input.mcp_server, {
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
