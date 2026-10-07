import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Native delegation names in the certified Claude runtime. Task* CRUD is not delegation. */
export const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];

export interface ClaudeMandatoryPolicy {
  readonly noTools?: boolean | undefined;
  readonly workflowExecutionProfile?: "attended-readonly" | "unattended-readonly" | undefined;
  readonly subagentsEnabled?: boolean | undefined;
}

export function evaluateClaudeMandatoryPolicy(
  policy: ClaudeMandatoryPolicy,
  toolName: string,
): string | undefined {
  if (policy.noTools) return "Tools are disabled for one-off generation.";
  const name = toolName.trim().toLowerCase();
  if (policy.subagentsEnabled === false && (name === "task" || name.includes("agent")))
    return "Sub-agents are disabled for this project. Complete the work in the main conversation instead.";
  if (policy.workflowExecutionProfile) {
    if (["read", "glob", "grep", "notebookread", "todoread"].includes(name)) return;
    // Interactive questions retain the host's existing answer transport.
    if (name === "askuserquestion" && policy.workflowExecutionProfile === "attended-readonly")
      return;
    return `Tool '${toolName}' is not permitted in a read-only workflow stage.`;
  }
}

/** Empty hook output preserves native permission evaluation; never return allow. */
export function claudeMandatoryPolicyOptions(
  policy: ClaudeMandatoryPolicy,
  hooks?: Options["hooks"],
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
            async (input) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const reason = evaluateClaudeMandatoryPolicy(policy, input.tool_name);
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
