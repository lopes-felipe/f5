import { classifyReadOnlyShellCommand } from "../readOnlyWorkflowShell.ts";

/**
 * Tool kinds a read-only workflow turn may run without inspection; `execute` is allowed only for
 * commands the read-only shell classifier accepts, and everything else is denied. `fetch` is
 * allowed in unattended stages too, matching other providers' plan mode; the exfiltration risk
 * this leaves is recorded in `docs/providers/antigravity.md`.
 */
export const ACP_READ_ONLY_WORKFLOW_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "think",
  "fetch",
]);

export interface AcpReadOnlyWorkflowToolCall {
  readonly kind?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly rawInput?: unknown;
}

/** A tool call that names an MCP server. Read-only workflow sessions install no MCP catalog. */
export function acpMcpToolCall(toolCall: AcpReadOnlyWorkflowToolCall): boolean {
  if (/\bmcp(?:__|[_:/.])/i.test(toolCall.title ?? "")) return true;
  const raw = toolCall.rawInput;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return ["server", "serverName", "server_name", "mcpServer", "mcp_server"].some(
    (key) => key in raw,
  );
}

/**
 * The exact command string an `execute` request will run. Only a raw-input string counts: a
 * title is display text, and an argv array joined with spaces loses its quoting, so neither can
 * be classified faithfully.
 */
export function acpExecuteCommand(rawInput: unknown): string | undefined {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput))
    return undefined;
  const record = rawInput as Record<string, unknown>;
  const value = record.command ?? record.CommandLine ?? record.command_line ?? record.commandLine;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Permission policy for a read-only workflow turn on an ACP provider without an OS sandbox
 * (Cursor, Antigravity). It never opens an approval prompt: read, search, think and fetch tools
 * and read-only shell commands run once; edits, deletes, moves, other commands, computer control,
 * MCP tools and requests with an unknown or missing kind are denied.
 */
export function acpReadOnlyWorkflowDecision(input: {
  readonly toolCall: AcpReadOnlyWorkflowToolCall;
  readonly computerRequest: boolean;
}): "allow" | "deny" {
  if (input.computerRequest) return "deny";
  if (acpMcpToolCall(input.toolCall)) return "deny";
  const kind = input.toolCall.kind;
  if (kind && ACP_READ_ONLY_WORKFLOW_TOOL_KINDS.has(kind)) return "allow";
  if (kind === "execute") {
    const command = acpExecuteCommand(input.toolCall.rawInput);
    return command !== undefined && classifyReadOnlyShellCommand(command).readOnly
      ? "allow"
      : "deny";
  }
  return "deny";
}
