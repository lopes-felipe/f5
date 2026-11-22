import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { stripVTControlCharacters } from "node:util";
import type { ProviderApprovalDecision, ProviderApprovalPresentation } from "@t3tools/contracts";

type ClaudePermissionCallbackOptions = Parameters<CanUseTool>[2];

/** A forwarded removal warning is a failed safety check, not a request for bypass consent. */
export function claudeRemovalSafetyDenial(
  toolName: string,
  permissionMode: unknown,
  options: Pick<ClaudePermissionCallbackOptions, "decisionReason" | "matchedAskRule" | "toolUseID">,
): PermissionResult | undefined {
  if (
    toolName !== "Bash" ||
    permissionMode !== "bypassPermissions" ||
    options.matchedAskRule !== undefined
  )
    return undefined;
  const reason = stripVTControlCharacters(options.decisionReason ?? "").trim();
  if (
    !(
      /^Dangerous rm(?:dir)?\b/i.test(reason) ||
      /\bdangerous removal\b/i.test(reason) ||
      reason === "This shell -c script runs rm and could not be checked" ||
      reason === "A permission rule denies a command in this shell -c script"
    )
  )
    return undefined;
  return {
    behavior: "deny",
    message: `Claude Code's removal safety check denied this command; the user did not reject it. The command did not run. Do not bypass the check by splitting the removal, putting it in a script, or using another tool or shell. If the warning below supplies a safe rewrite, use it and let the same check evaluate it. Otherwise continue the rest of the task without the removal and tell the user what you needed to delete and why. Warning: ${reason}`,
    toolUseID: options.toolUseID,
  };
}

const MAX_PRESENTATION_TEXT_CHARS = 2_000;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = stripVTControlCharacters(value).trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_PRESENTATION_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_PRESENTATION_TEXT_CHARS - 1)}…`
    : trimmed;
}

/**
 * Copies the SDK's permission prompt metadata into F5's display-only presentation.
 *
 * `sessionGrantAvailable: false` says that "Always allow this session" would grant nothing:
 * Claude Code 2.1.325+ sends `suggestions` only when saving a rule would allow the call
 * again, and F5 has no grant of its own for the tool. The ask is then shown without it.
 */
export function claudeApprovalPresentation(
  options: Pick<
    ClaudePermissionCallbackOptions,
    | "title"
    | "description"
    | "displayName"
    | "decisionReason"
    | "blockedPath"
    | "agentID"
    | "defaultToNo"
    | "suppressAlwaysAllowRule"
    | "matchedAskRule"
  >,
  context: {
    readonly sessionGrantAvailable?: boolean;
    readonly permissionMode?: string | undefined;
  } = {},
): ProviderApprovalPresentation | undefined {
  const suppressAlwaysAllowRule =
    options.suppressAlwaysAllowRule === true || context.sessionGrantAvailable === false;
  const title = text(options.title);
  const description = text(options.description);
  const displayName = text(options.displayName);
  const decisionReason = text(options.decisionReason);
  const blockedPath = text(options.blockedPath);
  const agentId = text(options.agentID);
  const presentation: ProviderApprovalPresentation = {
    ...(context.permissionMode === "bypassPermissions"
      ? {
          fullAccessOverride:
            options.matchedAskRule === undefined
              ? ("provider_check" as const)
              : ("ask_rule" as const),
        }
      : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(agentId ? { agentId } : {}),
    ...(options.defaultToNo === true ? { defaultToNo: true } : {}),
    ...(suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
  };
  return Object.keys(presentation).length > 0 ? presentation : undefined;
}

/**
 * A prompt that must not offer a persistent rule never writes one: any
 * persistent acceptance from a stale or modified client becomes a plain accept.
 */
export function effectiveClaudeApprovalDecision(
  decision: ProviderApprovalDecision,
  presentation: ProviderApprovalPresentation | undefined,
): ProviderApprovalDecision {
  if (
    presentation?.suppressAlwaysAllowRule &&
    (decision === "acceptForSession" || decision === "acceptAlways")
  )
    return "accept";
  return decision;
}
