/**
 * MCP JSON-RPC handling for the Agent Bridge, independent of HTTP.
 *
 * Supported versions:
 * - `2025-06-18`: `initialize`, then `tools/*`.
 * - `2026-07-28`: `server/discover` returns `supportedVersions` and capabilities.
 *
 * @module agentBridge/mcpProtocol
 */
import { Effect } from "effect";

import {
  asObject,
  jsonRpcError,
  jsonRpcSuccess,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../mcp/jsonRpcHttp.ts";
import {
  AgentBridgeToolError,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "./threadTools.ts";

export const MCP_VERSION_INITIALIZE = "2025-06-18";
export const MCP_VERSION_DISCOVER = "2026-07-28";
export const AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS = [
  MCP_VERSION_DISCOVER,
  MCP_VERSION_INITIALIZE,
] as const;

export const AGENT_BRIDGE_SERVER_INFO = { name: "F5 Agent Bridge", title: "F5 Agent Bridge" };
export const AGENT_BRIDGE_INSTRUCTIONS =
  "F5 Agent Bridge is a coding-workspace service. It can read the F5 projects and threads shared with you and start supervised coding turns. It does not control your computer, and it cannot answer approvals, interrupt, stop, change modes, or delete anything.";

/** Thrown to the HTTP layer as a 400: the request named a version F5 does not speak. */
export class UnsupportedMcpVersionError extends Error {
  constructor(readonly version: string) {
    super(`Unsupported MCP protocol version: ${version}`);
  }
}

export function isSupportedMcpVersion(version: string): boolean {
  return (AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS as ReadonlyArray<string>).includes(version);
}

export interface McpRequestContext {
  readonly caller: AgentBridgeCaller;
  /** The `MCP-Protocol-Version` header, when the client sent one. */
  readonly protocolVersionHeader: string | undefined;
  readonly serverVersion: string;
  /** Present only on the remote listener with Events enabled for this client. */
  readonly eventsCapability?: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

function toolResult(value: unknown): McpToolCallResult {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function toolErrorResult(error: AgentBridgeToolError): McpToolCallResult {
  const detail = {
    error: error.message,
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(detail) }],
    structuredContent: detail,
    isError: true,
    ...(error.requiredScope
      ? {
          _meta: {
            "mcp/www_authenticate": `Bearer error="insufficient_scope", scope="${error.requiredScope}"`,
          },
        }
      : {}),
  };
}

export function toolListEntry(tool: AgentBridgeToolDefinition) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { ...tool.annotations, title: tool.title },
  };
}

/**
 * Validates the version header before any method runs. A missing header is
 * treated as 2025-06-18, as the MCP transport specification requires.
 */
export function assertMcpVersion(request: JsonRpcRequest, header: string | undefined): void {
  if (header !== undefined && !isSupportedMcpVersion(header))
    throw new UnsupportedMcpVersionError(header);
  if (request.method === "server/discover") return;
  if (request.method === "initialize") {
    const requested = asObject(request.params).protocolVersion;
    // Negotiation: an unknown requested version is answered with ours, per the spec.
    if (requested !== undefined && typeof requested !== "string")
      throw new UnsupportedMcpVersionError(String(requested));
  }
}

export function handleMcpRequest(
  request: JsonRpcRequest,
  tools: ReadonlyArray<AgentBridgeToolDefinition>,
  context: McpRequestContext,
): Effect.Effect<JsonRpcResponse | null> {
  if (request.id === undefined) {
    // Notifications (`notifications/initialized`, cancellations) need no reply.
    return Effect.succeed(null);
  }
  if (typeof request.method !== "string")
    return Effect.succeed(jsonRpcError(request.id, -32600, "Invalid JSON-RPC request."));

  const visibleTools = tools.filter((tool) => context.caller.client.scopes.includes(tool.scope));
  switch (request.method) {
    case "initialize":
      return Effect.succeed(
        jsonRpcSuccess(request.id, {
          protocolVersion: MCP_VERSION_INITIALIZE,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: context.serverVersion },
          instructions: AGENT_BRIDGE_INSTRUCTIONS,
        }),
      );
    case "server/discover":
      return Effect.succeed(
        jsonRpcSuccess(request.id, {
          supportedVersions: [...AGENT_BRIDGE_SUPPORTED_MCP_VERSIONS],
          capabilities: {
            tools: { listChanged: false },
            ...(context.eventsCapability ? { events: context.eventsCapability } : {}),
          },
          serverInfo: { ...AGENT_BRIDGE_SERVER_INFO, version: context.serverVersion },
          instructions: AGENT_BRIDGE_INSTRUCTIONS,
        }),
      );
    case "ping":
      return Effect.succeed(jsonRpcSuccess(request.id, {}));
    case "tools/list":
      return Effect.succeed(jsonRpcSuccess(request.id, { tools: visibleTools.map(toolListEntry) }));
    case "tools/call": {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) return Effect.succeed(jsonRpcError(request.id, -32602, `Unknown tool: ${name}`));
      if (!context.caller.client.scopes.includes(tool.scope))
        return Effect.succeed(
          jsonRpcSuccess(
            request.id,
            toolErrorResult(
              new AgentBridgeToolError({
                message: `This connection was not granted ${tool.scope}.`,
                requiredScope: tool.scope,
              }),
            ),
          ),
        );
      return tool.run(params.arguments, context.caller).pipe(
        Effect.map(toolResult),
        Effect.catchTag("AgentBridgeToolError", (error) => Effect.succeed(toolErrorResult(error))),
        Effect.catchDefect((defect) =>
          Effect.logWarning("agentBridge.tool.defect", {
            tool: tool.name,
            detail: defect instanceof Error ? defect.message : String(defect),
          }).pipe(
            Effect.as({
              content: [{ type: "text" as const, text: '{"error":"Internal error."}' }],
              isError: true,
            }),
          ),
        ),
        Effect.map((result) => jsonRpcSuccess(request.id, result)),
      );
    }
    case "resources/list":
      return Effect.succeed(jsonRpcSuccess(request.id, { resources: [] }));
    case "prompts/list":
      return Effect.succeed(jsonRpcSuccess(request.id, { prompts: [] }));
    default:
      return Effect.succeed(
        jsonRpcError(request.id, -32601, `Unknown MCP method: ${request.method}`),
      );
  }
}
