import type { CanonicalItemType, TurnId } from "@t3tools/contracts";

export interface ClaudeToolResultCorrelation {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly turnId?: TurnId;
}

export const MAX_CLAUDE_TOOL_RESULT_CORRELATIONS = 512;

/** Keep only routing metadata, with a bounded grace window for late results. */
export function rememberClaudeToolResultCorrelation(
  pending: Map<string, ClaudeToolResultCorrelation>,
  tool: ClaudeToolResultCorrelation,
): void {
  if (tool.itemType !== "command_execution" && tool.itemType !== "file_change") return;
  pending.delete(tool.itemId);
  pending.set(tool.itemId, {
    itemId: tool.itemId,
    itemType: tool.itemType,
    ...(tool.turnId ? { turnId: tool.turnId } : {}),
  });
  if (pending.size > MAX_CLAUDE_TOOL_RESULT_CORRELATIONS) {
    pending.delete(pending.keys().next().value!);
  }
}
