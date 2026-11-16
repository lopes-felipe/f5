import type { AgentTranscriptItem } from "@t3tools/contracts";
import { transcriptRecord } from "../claudeTranscript.ts";
import { truncateMiddleByBytes } from "../../orchestration/outputTruncation.ts";
import {
  classifyToolItemType,
  titleForTool,
  summarizeToolRequest,
  extractTextContent,
} from "../claudeToolPresentation.ts";

export function boundedText(value: unknown, bytes: number): { text: string; truncated: boolean } {
  const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  const result = truncateMiddleByBytes(text, {
    maxBytes: bytes,
    headBytes: Math.floor(bytes / 2),
    marker: "\n…\n",
  });
  return { text: result.output, truncated: result.truncated };
}
export function normalizeClaudeSubagentRecord(
  value: unknown,
  offset: number,
): AgentTranscriptItem[] {
  const record = transcriptRecord(value);
  if (!record) return [];
  const base = {
    createdAt:
      typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
        ? new Date(record.timestamp).toISOString()
        : null,
  };
  const notice = (text: string): AgentTranscriptItem[] => [
    { ...base, id: "notice:" + offset, kind: "notice", text },
  ];
  if (record.type === "system" && record.subtype === "compact_boundary")
    return notice("Conversation compacted");
  if (
    ["attachment", "progress", "file-history-snapshot", "queue-operation"].includes(
      String(record.type),
    )
  )
    return [];
  const message = transcriptRecord(record.message);
  if (!message) return record.content ? notice("Unrecognized transcript record") : [];
  if (record.type !== "user" && record.type !== "assistant")
    return notice("Unrecognized transcript record");
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(content)) return [];
  const items: AgentTranscriptItem[] = [];
  for (const [index, raw] of content.entries()) {
    const block = transcriptRecord(raw);
    if (!block) continue;
    const id =
      String(typeof record.uuid === "string" && record.uuid.length <= 256 ? record.uuid : offset) +
      ":" +
      index;
    if (block.type === "text" && typeof block.text === "string") {
      items.push({
        ...base,
        id,
        kind: "message",
        role: record.type === "user" ? "user" : "assistant",
        ...boundedText(block.text, 32768),
      });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    ) {
      items.push({ ...base, id, kind: "reasoning", ...boundedText(block.thinking, 16384) });
    } else if (block.type === "tool_use" || block.type === "mcp_tool_use") {
      const name = boundedText(block.name ?? "Tool", 128).text;
      const input = transcriptRecord(block.input) ?? {};
      const itemType = classifyToolItemType(name, { input, blockType: String(block.type) });
      items.push({
        ...base,
        id,
        kind: "tool-call",
        toolCallId: typeof block.id === "string" && block.id.length <= 512 ? block.id : id,
        toolName: name,
        itemType,
        title: boundedText(titleForTool(itemType, input, name), 256).text,
        detail: boundedText(summarizeToolRequest(name, input), 1024).text,
        status: "running",
        output: "",
        outputTruncated: false,
      });
    } else if (block.type === "tool_result") {
      const output = boundedText(extractTextContent(block.content), 8192);
      items.push({
        ...base,
        id,
        kind: "tool-result",
        toolCallId:
          typeof block.tool_use_id === "string" && block.tool_use_id.length <= 512
            ? block.tool_use_id
            : id,
        isError: block.is_error === true,
        output: output.text,
        outputTruncated: output.truncated,
      });
    } else if (block.type !== "thinking")
      items.push({
        ...base,
        id,
        kind: "notice",
        text: "Unsupported content: " + boundedText(block.type, 128).text,
      });
  }
  return items;
}
