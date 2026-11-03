import type { CanonicalItemType } from "@t3tools/contracts";
import { codexThreadItemDisposition } from "@t3tools/shared/codexProtocolManifest";
export { codexThreadItemDisposition };

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type NormalizedCodexItemType = CanonicalItemType | "hook_prompt" | "subagent_activity";

/**
 * Exact aliases observed in current app-server items and historical persisted
 * events. Deliberately avoid substring matching: for example, imageGeneration
 * must never fall through to image_view.
 */
const CODEX_ITEM_TYPE_ALIASES: Readonly<Record<string, NormalizedCodexItemType>> = {
  user: "user_message",
  "user message": "user_message",
  assistant: "assistant_message",
  "assistant message": "assistant_message",
  "agent message": "assistant_message",
  reasoning: "reasoning",
  thought: "reasoning",
  plan: "plan",
  todo: "plan",
  command: "command_execution",
  "shell command": "command_execution",
  "command execution": "command_execution",
  patch: "file_change",
  edit: "file_change",
  "file edit": "file_change",
  "file change": "file_change",
  "patch apply begin": "file_change",
  "patch apply end": "file_change",
  "mcp call": "mcp_tool_call",
  "mcp tool call": "mcp_tool_call",
  "dynamic tool": "dynamic_tool_call",
  "dynamic tool call": "dynamic_tool_call",
  "collab agent": "collab_agent_tool_call",
  "collab agent tool call": "collab_agent_tool_call",
  "sub agent activity": "subagent_activity",
  search: "web_search",
  "web search": "web_search",
  "image view": "image_view",
  "image generation": "image_generation",
  sleep: "sleep",
  "review entered": "review_entered",
  "entered review mode": "review_entered",
  "review exited": "review_exited",
  "exited review mode": "review_exited",
  compact: "context_compaction",
  "context compaction": "context_compaction",
  error: "error",
  "hook prompt": "hook_prompt",
};

export function normalizeCodexThreadItemType(raw: unknown): NormalizedCodexItemType {
  const rawType = asString(raw);
  if (rawType && codexThreadItemDisposition(rawType) === "internal-duplicate") {
    return "hook_prompt";
  }
  return CODEX_ITEM_TYPE_ALIASES[normalizeItemType(raw)] ?? "unknown";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "image_generation":
      return "Generated image";
    case "sleep":
      return "Waited";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(
  itemType: CanonicalItemType,
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const durationMs = asNumber(item.durationMs ?? item.duration_ms);
  const action = asObject(item.action);
  const actionQueries = Array.isArray(action?.queries)
    ? action.queries.map(asString).filter((value): value is string => value !== undefined)
    : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [
          asString(item.query),
          asString(action?.query),
          ...actionQueries,
          asString(action?.pattern),
          asString(action?.url),
        ]
      : []),
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(item.savedPath),
    asString(item.saved_path),
    asString(item.revisedPrompt),
    asString(item.revised_prompt),
    asString(item.result),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  if (durationMs !== undefined) {
    if (durationMs >= 1_000) {
      const seconds = Math.round((durationMs / 1_000) * 100) / 100;
      return `${seconds}s`;
    }
    return `${durationMs}ms`;
  }
  return undefined;
}
export function itemLifecycleStatus(
  source: Record<string, unknown>,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  switch (source.status) {
    case "inProgress":
    case "in_progress":
    case "running":
      return "inProgress";
    case "failed":
    case "error":
      return "failed";
    case "declined":
    case "denied":
      return "declined";
    case "completed":
    case "success":
      return "completed";
    default:
      return lifecycle === "item.completed" ? "completed" : undefined;
  }
}
