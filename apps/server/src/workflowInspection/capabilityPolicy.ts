/**
 * Mandatory capability policy for read-only workflow stages, shared by every
 * provider adapter. Decisions are made at discovery (which tools a session is
 * given) and again at execution (each call), so a tool that slips past
 * discovery is still denied.
 */
import type { WorkflowTurnExecutionProfile } from "@t3tools/contracts";

import {
  type ConnectorToolDescriptor,
  evaluateConnectorToolCall,
  type WorkflowConnectorGrant,
} from "./connectorRegistry.ts";

export interface WorkflowCapabilityGrant {
  readonly profile: WorkflowTurnExecutionProfile;
  /** Name of the session's host inspection MCP server, when one is attached. */
  readonly inspectionServerName: string | null;
  /** Connection details adapters use to attach the inspection server natively. */
  readonly inspection?: {
    readonly serverName: string;
    readonly url: string;
    readonly token: string;
    readonly envVarName: string;
  } | null;
  readonly connectors: Readonly<Record<string, WorkflowConnectorGrant>>;
}

/**
 * Claude built-ins offered to read-only stages. File reads stay native; Bash,
 * edits, web access, and delegation are not offered at all.
 */
export const CLAUDE_READONLY_NATIVE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
] as const;

const READONLY_NATIVE_TOOL_NAMES = new Set(
  CLAUDE_READONLY_NATIVE_TOOLS.map((name) => name.toLowerCase()),
);

/** Where an MCP tool is served from. `source` comes from provider provenance when reported. */
export interface McpToolOrigin {
  readonly name: string;
  readonly source?: string | undefined;
}

export type WorkflowToolDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "deny";
      readonly reason: string;
      /** Pending connector-trust verification needs the tool's live declaration. */
      readonly needsLiveConnectorTool?: { readonly serverName: string; readonly toolName: string };
    };

const PLAN_CAPTURED_REASON =
  "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";
const UNATTENDED_QUESTION_REASON =
  "This unattended workflow stage has no user reply path. Choose and document a conservative default, then complete the stage artifact.";

/** Claude's tool-name normalization for MCP server and tool names. */
export function normalizeMcpNameForClaude(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mcpServerNames(grant: WorkflowCapabilityGrant): ReadonlyArray<string> {
  return [
    ...(grant.inspectionServerName ? [grant.inspectionServerName] : []),
    ...Object.keys(grant.connectors),
  ];
}

/**
 * Resolve `mcp__<server>__<tool>` to a configured server. Provenance wins;
 * without it, the longest configured prefix wins so a server cannot shadow
 * another by sharing a shorter prefix.
 */
export function resolveMcpToolTarget(
  grant: WorkflowCapabilityGrant,
  toolName: string,
  origin: McpToolOrigin | undefined,
): { readonly serverName: string; readonly toolName: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const candidates = origin
    ? [origin.name]
    : mcpServerNames(grant).toSorted((left, right) => right.length - left.length);
  for (const serverName of candidates) {
    const prefix = `mcp__${normalizeMcpNameForClaude(serverName)}__`;
    if (toolName.startsWith(prefix) && toolName.length > prefix.length) {
      return { serverName, toolName: toolName.slice(prefix.length) };
    }
  }
  return null;
}

function connectorOperationName(
  grant: WorkflowConnectorGrant,
  normalizedToolName: string,
): string | undefined {
  return grant.operations.find(
    (operation) => normalizeMcpNameForClaude(operation) === normalizedToolName,
  );
}

/**
 * Evaluate one tool call. `providerToolName` is the name the provider uses;
 * MCP calls are recognized by origin or the `mcp__` prefix.
 */
export function evaluateWorkflowToolCall(input: {
  readonly grant: WorkflowCapabilityGrant;
  readonly providerToolName: string;
  readonly origin?: McpToolOrigin | undefined;
  readonly liveConnectorTool?: ConnectorToolDescriptor | undefined;
}): WorkflowToolDecision {
  const { grant, providerToolName, origin } = input;
  const isMcp = origin !== undefined || providerToolName.startsWith("mcp__");
  if (!isMcp) {
    const name = providerToolName.trim().toLowerCase();
    if (name === "exitplanmode") return { kind: "deny", reason: PLAN_CAPTURED_REASON };
    if (name === "askuserquestion") {
      return grant.profile === "attended-readonly"
        ? { kind: "allow" }
        : { kind: "deny", reason: UNATTENDED_QUESTION_REASON };
    }
    if (READONLY_NATIVE_TOOL_NAMES.has(name)) return { kind: "allow" };
    return {
      kind: "deny",
      reason: `Tool '${providerToolName}' is not permitted in a read-only workflow stage. Use the read-only inspection tools instead.`,
    };
  }

  // Only servers the host registered for this session are trusted at all.
  if (origin?.source !== undefined && origin.source !== "dynamic") {
    return {
      kind: "deny",
      reason: `MCP server '${origin.name}' was not configured by F5 for this read-only workflow stage.`,
    };
  }
  const target = resolveMcpToolTarget(grant, providerToolName, origin);
  if (!target) {
    return {
      kind: "deny",
      reason: `MCP tool '${providerToolName}' is not available in a read-only workflow stage.`,
    };
  }
  if (grant.inspectionServerName !== null && target.serverName === grant.inspectionServerName) {
    return { kind: "allow" };
  }
  const connector = grant.connectors[target.serverName];
  const operation = connector ? connectorOperationName(connector, target.toolName) : undefined;
  const decision = evaluateConnectorToolCall({
    grant: connector,
    serverName: target.serverName,
    toolName: operation ?? target.toolName,
    live: input.liveConnectorTool,
  });
  if (decision.allowed) return { kind: "allow" };
  const needsLive =
    operation !== undefined &&
    connector?.pinnedTools[operation] !== undefined &&
    input.liveConnectorTool === undefined;
  return {
    kind: "deny",
    reason: decision.reason,
    ...(needsLive
      ? { needsLiveConnectorTool: { serverName: target.serverName, toolName: operation } }
      : {}),
  };
}

/** A grant that exposes only native reads; used before facade wiring exists. */
export function nativeOnlyWorkflowGrant(
  profile: WorkflowTurnExecutionProfile,
): WorkflowCapabilityGrant {
  return { profile, inspectionServerName: null, connectors: {} };
}
