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

/** How a provider titles an MCP tool call: `mcp__server__tool`, `MCP: server / tool`, `Run mcp_server_tool`. */
const MCP_TITLE_PREFIX = /^\s*(?:Run\s+)?mcp[_:/.]/i;
const MCP_TITLE_MENTION = /\bmcp(?:__|[_:/.])/i;

/**
 * A tool call that names an MCP server. The only MCP server a read-only workflow session gets
 * is F5's read-only thread server.
 *
 * A server key in the raw input always counts. So does a title that mentions an MCP tool name
 * anywhere, except on a shell command: its title is the command's own text, so
 * `rg x src/mcp/tools.ts` would read as an MCP call. There only a title that starts with a
 * provider's MCP form counts, and the command is otherwise classified as the command it is.
 *
 * That rests on an assumption: Cursor and Antigravity put the MCP form first in the title of
 * every MCP call (the three forms above are the ones recorded from them). An MCP tool that
 * takes a `command` argument, is reported as `execute` with no server key, and is titled some
 * other way would be classified as the shell command it carries, and run when that command
 * only reads. A read-only session is given no MCP server but F5's own, so no such tool exists
 * there today; a provider that starts titling MCP calls differently needs its form added here.
 */
export function acpMcpToolCall(toolCall: AcpReadOnlyWorkflowToolCall): boolean {
  const record = rawInputRecord(toolCall.rawInput);
  if (record !== undefined && rawInputValues(record, MCP_SERVER_KEYS).length > 0) return true;
  const title = toolCall.title ?? "";
  const shellCommand =
    toolCall.kind === "execute" && acpExecuteCommand(toolCall.rawInput) !== undefined;
  return (shellCommand ? MCP_TITLE_PREFIX : MCP_TITLE_MENTION).test(title);
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
export function acpReadOnlyWorkflowDecision(
  input: AcpReadOnlyWorkflowDecisionInput,
): "allow" | "deny" {
  return acpReadOnlyWorkflowVerdict(input).decision;
}

export interface AcpReadOnlyWorkflowDecisionInput {
  readonly toolCall: AcpReadOnlyWorkflowToolCall;
  readonly computerRequest: boolean;
  /** The generated name of this session's read-only F5 thread server, when attached. */
  readonly f5ThreadServerName?: string | undefined;
}

export type AcpReadOnlyWorkflowVerdict =
  | { readonly decision: "allow" }
  /** `reason` is shown next to the refused operation in the thread; it says why, not what. */
  | { readonly decision: "deny"; readonly reason: string };

const ALLOW: AcpReadOnlyWorkflowVerdict = { decision: "allow" };
const deny = (reason: string): AcpReadOnlyWorkflowVerdict => ({ decision: "deny", reason });

/** `acpReadOnlyWorkflowDecision` with the reason for a refusal. */
export function acpReadOnlyWorkflowVerdict(
  input: AcpReadOnlyWorkflowDecisionInput,
): AcpReadOnlyWorkflowVerdict {
  if (input.computerRequest) return deny("computer control is not allowed in a read-only stage");
  if (acpMcpToolCall(input.toolCall))
    return acpF5ReadOnlyThreadToolCall(input.toolCall, input.f5ThreadServerName)
      ? ALLOW
      : deny("only F5's read-only tools may be called over MCP in a read-only stage");
  const kind = input.toolCall.kind;
  if (kind && ACP_READ_ONLY_WORKFLOW_TOOL_KINDS.has(kind)) return ALLOW;
  if (kind === "execute") {
    if (acpSandboxEscalation(input.toolCall.rawInput))
      return deny("running outside the sandbox is not allowed in a read-only stage");
    const command = acpExecuteCommand(input.toolCall.rawInput);
    if (command === undefined) return deny("the command to run was not reported");
    const verdict = classifyReadOnlyShellCommand(command);
    return verdict.readOnly ? ALLOW : deny(verdict.reason);
  }
  return deny(
    kind ? `${kind} operations are not allowed in a read-only stage` : "the operation has no kind",
  );
}

/**
 * The timeline detail for a refused operation: what was asked, then why F5 refused it. `subject`
 * is the provider's own description (the command, usually) and may be missing.
 */
export function acpReadOnlyRefusalDetail(subject: string | undefined, reason: string): string {
  return subject ? `${subject} (${reason})` : reason;
}

/**
 * The detail of a refused computer-control request. Its inputs are never shown, so every such
 * refusal reads the same and two of them can't be told apart.
 */
export const ACP_HIDDEN_TOOL_INPUTS_DETAIL = "Tool inputs hidden while computer control is enabled";

/**
 * A refused request's parameters without the tool call's id, for the detail of a request that
 * names no command, path or URL. The id is new on every request, and a stage counts how often
 * the same operation was refused by comparing details.
 */
export function acpRequestWithoutToolCallId(params: unknown): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
  const { toolCall, ...rest } = params as { readonly toolCall?: unknown };
  if (typeof toolCall !== "object" || toolCall === null || Array.isArray(toolCall)) return params;
  const { toolCallId: _toolCallId, ...call } = toolCall as { readonly toolCallId?: unknown };
  return { ...rest, toolCall: call };
}
