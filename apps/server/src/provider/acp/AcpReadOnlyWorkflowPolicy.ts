import { READ_ONLY_THREAD_TOOL_NAMES } from "../../mcp/threadMcpTools.ts";
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

/** Raw-input keys naming an MCP server, compared case-insensitively (Antigravity: `ServerName`). */
const MCP_SERVER_KEYS: ReadonlySet<string> = new Set([
  "server",
  "servername",
  "server_name",
  "mcpserver",
  "mcp_server",
]);
/** Raw-input keys naming the MCP tool, compared case-insensitively (Antigravity: `ToolName`). */
const MCP_TOOL_KEYS: ReadonlySet<string> = new Set(["tool", "toolname", "tool_name"]);

function rawInputRecord(rawInput: unknown): Record<string, unknown> | undefined {
  return typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>)
    : undefined;
}

function rawInputValues(record: Record<string, unknown>, keys: ReadonlySet<string>): unknown[] {
  return Object.entries(record).flatMap(([key, value]) =>
    keys.has(key.toLowerCase()) && value !== undefined ? [value] : [],
  );
}

/**
 * A tool call that names an MCP server. The only MCP server a read-only workflow session gets
 * is F5's read-only thread server.
 */
export function acpMcpToolCall(toolCall: AcpReadOnlyWorkflowToolCall): boolean {
  if (/\bmcp(?:__|[_:/.])/i.test(toolCall.title ?? "")) return true;
  const record = rawInputRecord(toolCall.rawInput);
  return record !== undefined && rawInputValues(record, MCP_SERVER_KEYS).length > 0;
}

/** Kinds that change things or run code; never treated as a call to F5's thread server. */
const ACP_MUTATING_TOOL_KINDS: ReadonlySet<string> = new Set(["execute", "edit", "delete", "move"]);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether an MCP tool call runs one of F5's read-only thread tools, on the session's generated
 * server (`f5_thread_<random hex>`). No user-configured server can carry that name.
 *
 * - Every server field in the raw input must name that server, and any tool field must name a
 *   read-only F5 tool.
 * - Otherwise the title must start with a provider's qualified form for that server, followed by
 *   a read-only F5 tool name: `mcp__<server>__<tool>` (Cursor and Claude style),
 *   `MCP: <server> / <tool>` or `Run mcp_<server>_<tool>` (Antigravity). Anchoring at the start
 *   matters: a title can carry arguments the model wrote, so the server name appearing later
 *   in it proves nothing.
 */
export function acpF5ReadOnlyThreadToolCall(
  toolCall: AcpReadOnlyWorkflowToolCall,
  serverName: string | undefined,
): boolean {
  if (!serverName) return false;
  if (toolCall.kind && ACP_MUTATING_TOOL_KINDS.has(toolCall.kind)) return false;
  const record = rawInputRecord(toolCall.rawInput);
  if (record) {
    const servers = rawInputValues(record, MCP_SERVER_KEYS);
    if (servers.length > 0) {
      const tools = rawInputValues(record, MCP_TOOL_KEYS);
      return (
        servers.every((value) => value === serverName) &&
        tools.every((value) => typeof value === "string" && READ_ONLY_THREAD_TOOL_NAMES.has(value))
      );
    }
  }
  const title = (toolCall.title ?? "").trim();
  const server = escapeRegExp(serverName);
  const match = new RegExp(
    `^(?:mcp__${server}__|MCP: ${server} / |(?:Run )?mcp_${server}_)([A-Za-z0-9_]+)(?![A-Za-z0-9_])`,
  ).exec(title);
  return match !== null && READ_ONLY_THREAD_TOOL_NAMES.has(match[1]!);
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
