/**
 * What F5's MCP hub enforces around each tool call: per-tool Ask policy with an
 * approval in the conversation, tool pinning (a changed tool asks until the user
 * accepts the change), per-conversation server toggles, and the call log.
 *
 * The hub only sees this interface; `McpHubGovernanceLive` backs it with SQLite and
 * the provider runtime event stream.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerDefinition,
  McpToolCallApproval,
  McpToolCallOutcome,
  McpToolPinState,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";

import { maskResolvedMcpSecrets } from "../mcpResolvedSecrets.ts";

/** Which definition of a server a pin belongs to: same name, different URL or command, new pins. */
export interface McpServerIdentity {
  /** Opaque hash; never contains arguments or query strings. */
  readonly key: string;
  /** The URL without query, or the command's base name. */
  readonly label: string;
}

export type McpToolApprovalReason = "policy" | "changed" | "new";

export type McpToolApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface McpToolApprovalInput {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly serverName: string;
  readonly toolName: string;
  readonly reason: McpToolApprovalReason;
  /** Aborted when the provider cancels the call; the approval then closes as cancelled. */
  readonly signal: AbortSignal;
}

export interface McpToolCallLogEntry {
  readonly threadId: ThreadId;
  readonly projectId?: string | undefined;
  readonly provider: ProviderKind;
  readonly serverName: string;
  readonly toolName: string;
  readonly outcome: McpToolCallOutcome;
  readonly durationMs: number;
  readonly approval: McpToolCallApproval;
  /** Already redacted by the upstream; trimmed to a short summary before storing. */
  readonly errorSummary?: string | undefined;
}

export interface McpHubGovernance {
  /** Records the tools a server listed: first listing pins all; later ones flag new and changed tools. */
  readonly observeTools: (
    serverName: string,
    identity: McpServerIdentity,
    tools: ReadonlyArray<Tool>,
  ) => void;
  readonly pinState: (
    serverName: string,
    identity: McpServerIdentity,
    toolName: string,
  ) => McpToolPinState | undefined;
  /** The accepted description of a tool whose definition changed, until the change is reviewed. */
  readonly acceptedDescription?: (
    identity: McpServerIdentity,
    toolName: string,
  ) => string | undefined;
  /** Shows F5's approval in the conversation and settles with the user's answer. */
  readonly requestApproval: (input: McpToolApprovalInput) => Promise<McpToolApprovalDecision>;
  /**
   * True after the user allowed this tool for the rest of the conversation. Keyed by
   * the server's identity too, so a new URL or command under the same name asks again.
   */
  readonly allowedForSession: (
    threadId: ThreadId,
    serverName: string,
    toolName: string,
    identityKey?: string,
  ) => boolean;
  readonly allowForSession: (
    threadId: ThreadId,
    serverName: string,
    toolName: string,
    identityKey?: string,
  ) => void;
  /** Forgets this conversation's allowances for a server, after its policy was saved. */
  readonly clearSessionAllowances?: (threadId: ThreadId, serverName: string) => void;
  /** True when the user turned this server off for the conversation from the chat chip. */
  readonly isServerDisabled: (threadId: ThreadId, serverName: string) => boolean;
  /** Called with the conversation whose server toggles changed. */
  readonly onThreadServersChanged: (listener: (threadId: ThreadId) => void) => () => void;
  readonly recordCall: (entry: McpToolCallLogEntry) => void;
}

/** Stable identity of a resolved server definition, safe to store and show. */
export function mcpServerIdentity(
  serverName: string,
  definition: McpServerDefinition,
): McpServerIdentity {
  let label: string;
  let material: string;
  // Resolved secrets are masked: the identity is stored and shown, and must not change
  // when a secret is rotated (that would trust every tool again as a first listing).
  if (definition.type === "stdio") {
    label = maskResolvedMcpSecrets(basename(definition.command));
    material = maskResolvedMcpSecrets(
      JSON.stringify([definition.command, ...(definition.args ?? [])]),
    );
  } else {
    const masked = maskResolvedMcpSecrets(definition.url);
    try {
      const url = new URL(masked);
      label = `${url.origin}${url.pathname}`;
    } catch {
      label = definition.type;
    }
    material = masked;
  }
  const key = createHash("sha256")
    .update(`${mcpServerNameKey(serverName)}\0${definition.type}\0${material}`)
    .digest("hex")
    .slice(0, 24);
  return { key, label };
}

/** The part of a tool definition a pin covers, as stable JSON. */
export function pinnedToolDefinition(tool: Tool): string {
  return JSON.stringify(
    sortKeys({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema ?? {},
    }),
    null,
    2,
  );
}

export function pinDigest(definition: string): string {
  return createHash("sha256").update(definition).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  return value;
}

/** At most this much of an error reaches the call log. */
export const MCP_ACTIVITY_ERROR_SUMMARY_LIMIT = 240;

export function summarizeToolError(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MCP_ACTIVITY_ERROR_SUMMARY_LIMIT
    ? `${line.slice(0, MCP_ACTIVITY_ERROR_SUMMARY_LIMIT - 1)}…`
    : line;
}
