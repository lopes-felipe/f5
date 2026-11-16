import type { CanonicalItemType } from "@t3tools/contracts";
import { isImagePreviewPath } from "@t3tools/shared/filePreview";
import { claudeSkillToolTitle } from "@t3tools/shared/toolActivity";
import { isClaudeTaskToolName } from "./claudeToolCompletion.ts";

/** A Claude `Read` of an image renders as a viewed image rather than a text read. */
export function readToolImagePath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "read" && normalized !== "read file") {
    return undefined;
  }
  const pathValue = input.file_path ?? input.path;
  if (typeof pathValue !== "string") {
    return undefined;
  }
  const path = pathValue.trim();
  return path.length > 0 && isImagePreviewPath(path) ? path : undefined;
}

export function classifyToolItemType(
  toolName: string,
  options?: { readonly blockType?: string; readonly input?: Record<string, unknown> },
): CanonicalItemType {
  if (options?.blockType?.toLowerCase() === "mcp_tool_use") {
    return "mcp_tool_call";
  }
  if (options?.input && readToolImagePath(toolName, options.input)) {
    return "image_view";
  }

  const normalized = toolName.toLowerCase();
  // Task-tracking tools are bookkeeping, not file edits ("TaskCreate" would
  // otherwise match the "create" heuristic below) and not sub-agent delegation.
  if (normalized === "todowrite" || isClaudeTaskToolName(toolName)) {
    return "dynamic_tool_call";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function formatSubagentLabel(subagentType: string): string {
  return subagentType
    .split(/[-_\s]+/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

export function fileOrientedToolDetail(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const n = toolName.toLowerCase();
  const isFileTool =
    n === "read" || n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit";
  if (!isFileTool) return undefined;
  return (
    normalizeOptionalString(input.file_path) ??
    normalizeOptionalString(input.notebook_path) ??
    normalizeOptionalString(input.path)
  );
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  if (classifyToolItemType(toolName) === "collab_agent_tool_call") {
    const description = normalizeOptionalString(input.description);
    if (description) {
      return `${toolName}: ${description.slice(0, 400)}`;
    }

    const prompt = normalizeOptionalString(input.prompt);
    if (prompt) {
      return `${toolName}: ${prompt.slice(0, 400)}`;
    }
  }

  if (toolName.toLowerCase() === "todowrite" && Array.isArray(input.todos)) {
    const total = input.todos.length;
    return `${toolName}: ${total} task${total === 1 ? "" : "s"}`;
  }

  const filePath = fileOrientedToolDetail(toolName, input);
  if (filePath) return filePath;

  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function titleForTool(
  itemType: CanonicalItemType,
  input?: Record<string, unknown>,
  toolName?: string,
): string {
  const skillTitle =
    itemType === "dynamic_tool_call" ? claudeSkillToolTitle(toolName, input) : undefined;
  if (skillTitle) return skillTitle;
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call": {
      const subagentType = input ? normalizeOptionalString(input.subagent_type) : undefined;
      return subagentType ? `${formatSubagentLabel(subagentType)} agent` : "Subagent task";
    }
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}
