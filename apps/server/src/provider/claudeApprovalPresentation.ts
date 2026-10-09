import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderApprovalDecision, ProviderApprovalPresentation } from "@t3tools/contracts";

type ClaudePermissionCallbackOptions = Parameters<CanUseTool>[2];

const MAX_PRESENTATION_TEXT_CHARS = 2_000;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_PRESENTATION_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_PRESENTATION_TEXT_CHARS - 1)}…`
    : trimmed;
}

/** Copies the SDK's permission prompt metadata into F5's display-only presentation. */
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
  >,
): ProviderApprovalPresentation | undefined {
  const title = text(options.title);
  const description = text(options.description);
  const displayName = text(options.displayName);
  const decisionReason = text(options.decisionReason);
  const blockedPath = text(options.blockedPath);
  const agentId = text(options.agentID);
  const presentation: ProviderApprovalPresentation = {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(agentId ? { agentId } : {}),
    ...(options.defaultToNo === true ? { defaultToNo: true } : {}),
    ...(options.suppressAlwaysAllowRule === true ? { suppressAlwaysAllowRule: true } : {}),
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
