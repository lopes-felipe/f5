import type { AgentTranscriptItem } from "@t3tools/contracts";
import { boundedText } from "./normalizeClaudeSubagentRecord.ts";

export const TRANSCRIPT_PAGE_BYTES = 1024 * 1024;
// Reserve space for page metadata and cursors outside the items array.
const ITEM_BUDGET = TRANSCRIPT_PAGE_BYTES - 16 * 1024;

/** Shrink presentation fields without losing record identity or tool metadata. */
export function fitTranscriptItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  for (
    let fieldBudget = 16384;
    Buffer.byteLength(JSON.stringify(items)) > ITEM_BUDGET && fieldBudget >= 128;
    fieldBudget /= 2
  ) {
    items = items.map((item) => {
      if (item.kind === "message" || item.kind === "reasoning") {
        const text = boundedText(item.text, fieldBudget);
        return { ...item, text: text.text, truncated: item.truncated || text.truncated };
      }
      if (item.kind === "tool-call" || item.kind === "tool-result") {
        const output = boundedText(item.output, fieldBudget);
        return {
          ...item,
          ...(item.kind === "tool-call"
            ? { detail: boundedText(item.detail, Math.min(1024, fieldBudget)).text }
            : {}),
          output: output.text,
          outputTruncated: item.outputTruncated || output.truncated,
        };
      }
      return item;
    });
  }
  return items;
}
