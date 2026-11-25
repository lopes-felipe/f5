/** Pure SDK result classifiers shared by Claude recovery and task projection. */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  const terminalReason = (result as SDKResultMessage & { terminal_reason?: unknown })
    .terminal_reason;
  if (terminalReason === "aborted_tools" || terminalReason === "aborted_streaming") {
    return true;
  }
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}
