import type { Options, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_READONLY_NATIVE_TOOLS,
  evaluateWorkflowToolCall,
  type McpToolOrigin,
  nativeOnlyWorkflowGrant,
  type WorkflowCapabilityGrant,
} from "../workflowInspection/capabilityPolicy.ts";
import type { ConnectorToolDescriptor } from "../workflowInspection/connectorRegistry.ts";

/** Native delegation names in the certified Claude runtime. Task* CRUD is not delegation. */
export const CLAUDE_DELEGATION_TOOLS = ["Agent", "Task"];
const DELEGATION_ALIASES = new Set(["agent", "task", "subagent", "spawn_agent"]);

export interface ClaudeMandatoryPolicy {
  readonly noTools?: boolean | undefined;
  readonly workflowExecutionProfile?: "attended-readonly" | "unattended-readonly" | undefined;
  /** Host-computed capabilities for a read-only stage; defaults to native reads only. */
  readonly workflowCapabilities?: WorkflowCapabilityGrant | undefined;
  readonly subagentsEnabled?: boolean | undefined;
}

export type ResolveLiveConnectorTool = (
  serverName: string,
  toolName: string,
) => Promise<ConnectorToolDescriptor | undefined>;

function workflowGrant(policy: ClaudeMandatoryPolicy): WorkflowCapabilityGrant | undefined {
  if (policy.workflowCapabilities) return policy.workflowCapabilities;
  return policy.workflowExecutionProfile
    ? nativeOnlyWorkflowGrant(policy.workflowExecutionProfile)
    : undefined;
}

export function evaluateClaudeMandatoryPolicy(
  policy: ClaudeMandatoryPolicy,
  toolName: string,
  context?: {
    readonly origin?: McpToolOrigin | undefined;
    readonly liveConnectorTool?: ConnectorToolDescriptor | undefined;
  },
): string | undefined {
  if (policy.noTools) return "Tools are disabled for one-off generation.";
  const name = toolName.trim().toLowerCase();
  if (policy.subagentsEnabled === false && DELEGATION_ALIASES.has(name))
    return "Sub-agents are disabled for this project. Complete the work in the main conversation instead.";
  const grant = workflowGrant(policy);
  if (!grant) return undefined;
  const decision = evaluateWorkflowToolCall({
    grant,
    providerToolName: toolName,
    origin: context?.origin,
    liveConnectorTool: context?.liveConnectorTool,
  });
  return decision.kind === "allow" ? undefined : decision.reason;
}

/**
 * Same decision, but fetches a trusted connector tool's live declaration when
 * the decision depends on it. Resolver failures keep the denial.
 */
export async function evaluateClaudeMandatoryPolicyWithLiveTools(
  policy: ClaudeMandatoryPolicy,
  toolName: string,
  origin: McpToolOrigin | undefined,
  resolveLiveConnectorTool: ResolveLiveConnectorTool | undefined,
): Promise<string | undefined> {
  const grant = workflowGrant(policy);
  const first = evaluateClaudeMandatoryPolicy(policy, toolName, { origin });
  if (!first || !grant || !resolveLiveConnectorTool) return first;
  const decision = evaluateWorkflowToolCall({ grant, providerToolName: toolName, origin });
  if (decision.kind !== "deny" || !decision.needsLiveConnectorTool) return first;
  let live: ConnectorToolDescriptor | undefined;
  try {
    live = await resolveLiveConnectorTool(
      decision.needsLiveConnectorTool.serverName,
      decision.needsLiveConnectorTool.toolName,
    );
  } catch {
    return first;
  }
  return live
    ? evaluateClaudeMandatoryPolicy(policy, toolName, { origin, liveConnectorTool: live })
    : first;
}

function originFromHook(input: PreToolUseHookInput): McpToolOrigin | undefined {
  return input.mcp_server
    ? { name: input.mcp_server.name, source: input.mcp_server.source }
    : undefined;
}

/** Empty hook output preserves native permission evaluation; never return allow. */
export function claudeMandatoryPolicyOptions(
  policy: ClaudeMandatoryPolicy,
  hooks?: Options["hooks"],
  onDenied?: (input: PreToolUseHookInput, signal: AbortSignal, reason: string) => Promise<void>,
  resolveLiveConnectorTool?: ResolveLiveConnectorTool,
): Pick<Options, "hooks" | "disallowedTools" | "tools" | "strictMcpConfig"> {
  const readOnly = workflowGrant(policy) !== undefined;
  return {
    ...(policy.noTools
      ? { tools: [], disallowedTools: ["*"] }
      : {
          // Discovery: read-only stages are offered only read-only built-ins and
          // only the MCP servers the host passes explicitly.
          ...(readOnly ? { tools: [...CLAUDE_READONLY_NATIVE_TOOLS], strictMcpConfig: true } : {}),
          ...(policy.subagentsEnabled === false || readOnly
            ? { disallowedTools: [...CLAUDE_DELEGATION_TOOLS] }
            : {}),
        }),
    hooks: {
      ...hooks,
      PreToolUse: [
        ...(hooks?.PreToolUse ?? []),
        {
          hooks: [
            async (input, _toolUseId, { signal }) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const reason = await evaluateClaudeMandatoryPolicyWithLiveTools(
                policy,
                input.tool_name,
                originFromHook(input),
                resolveLiveConnectorTool,
              );
              if (reason) {
                try {
                  await onDenied?.(input, signal, reason);
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
