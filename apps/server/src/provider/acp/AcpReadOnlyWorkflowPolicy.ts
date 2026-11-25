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

const MCP_SERVER_KEYS = ["server", "serverName", "server_name", "mcpServer", "mcp_server"] as const;

/**
 * A tool call that names an MCP server. The only MCP server a read-only workflow session gets
 * is F5's read-only thread server.
 */
export function acpMcpToolCall(toolCall: AcpReadOnlyWorkflowToolCall): boolean {
  if (/\bmcp(?:__|[_:/.])/i.test(toolCall.title ?? "")) return true;
  const raw = toolCall.rawInput;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return MCP_SERVER_KEYS.some((key) => key in raw);
}

/** Kinds that change things or run code; never treated as a call to F5's thread server. */
const ACP_MUTATING_TOOL_KINDS: ReadonlySet<string> = new Set(["execute", "edit", "delete", "move"]);

/**
 * Whether an MCP tool call targets F5's read-only thread server, by its per-session generated
 * name (`f5_thread_<random hex>`): an exact server field in the raw input, or the name as a whole
 * token in the title. No user-configured server can carry that name, and the server itself only
 * serves its read-only tools.
 */
export function acpF5ReadOnlyThreadToolCall(
  toolCall: AcpReadOnlyWorkflowToolCall,
  serverName: string | undefined,
): boolean {
  if (!serverName) return false;
  if (toolCall.kind && ACP_MUTATING_TOOL_KINDS.has(toolCall.kind)) return false;
  const raw = toolCall.rawInput;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const named = MCP_SERVER_KEYS.map((key) => record[key]).filter((value) => value !== undefined);
    if (named.length > 0) return named.every((value) => value === serverName);
  }
  const title = toolCall.title ?? "";
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    title.includes(`mcp__${serverName}__`) ||
    new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:[^A-Za-z0-9_-]|$)`).test(title)
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
 * Whether a command asks to run outside the provider's sandbox. Antigravity sends
 * `BypassSandbox: true` when the model retries a command that failed inside the sandbox; approving
 * it runs the command with full filesystem and network access, so a read-only stage refuses it
 * whatever the command is. Any truthy key that names bypassing or disabling a sandbox counts.
 */
export function acpSandboxEscalation(rawInput: unknown): boolean {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return false;
  return Object.entries(rawInput).some(
    ([key, value]) =>
      /^(?:bypass|disable|dangerously_?disable)_?sandbox$/i.test(key) &&
      value !== false &&
      value !== "false" &&
      value !== null &&
      value !== undefined,
  );
}

/**
 * Permission policy for a read-only workflow turn on an ACP provider without an OS sandbox
 * (Cursor, Antigravity). It never opens an approval prompt: read, search, think and fetch tools
 * and read-only shell commands run once, as do calls to F5's read-only thread server (forge
 * reads); edits, deletes, moves, other commands, commands that ask to leave the sandbox,
 * computer control, other MCP tools and requests with an unknown or missing kind are denied.
 */
export function acpReadOnlyWorkflowDecision(input: {
  readonly toolCall: AcpReadOnlyWorkflowToolCall;
  readonly computerRequest: boolean;
  /** The generated name of this session's read-only F5 thread server, when attached. */
  readonly f5ThreadServerName?: string | undefined;
}): "allow" | "deny" {
  if (input.computerRequest) return "deny";
  if (acpMcpToolCall(input.toolCall))
    return acpF5ReadOnlyThreadToolCall(input.toolCall, input.f5ThreadServerName) ? "allow" : "deny";
  const kind = input.toolCall.kind;
  if (kind && ACP_READ_ONLY_WORKFLOW_TOOL_KINDS.has(kind)) return "allow";
  if (kind === "execute") {
    if (acpSandboxEscalation(input.toolCall.rawInput)) return "deny";
    const command = acpExecuteCommand(input.toolCall.rawInput);
    return command !== undefined && classifyReadOnlyShellCommand(command).readOnly
      ? "allow"
      : "deny";
  }
  return "deny";
}
