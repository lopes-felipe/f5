/**
 * MCP Apps (SEP-1865) for Claude sessions, at parity with the Codex adapter: a per-session
 * catalog built from `mcpServerStatus()` tool `_meta.ui` (`mcp_tool_ui_meta_v1`), capture
 * eligibility for a completed tool call, and the app tool-call request.
 *
 * App tool calls use the SDK Query's internal `request({ subtype: "mcp_call" })`, which has
 * no public wrapper. It is used only when the CLI advertises
 * `mcp_call_result_not_for_model_v1` and the Query still exposes `request`;
 * `ClaudeSdkContract.probe.test.ts` pins that internal so a rename fails CI.
 */
import { readMcpAppToolResult } from "@t3tools/shared/mcpApp";
import { normalizeClaudeMcpName } from "@t3tools/shared/mcpTranslation";

export const CLAUDE_MCP_APP_UNAVAILABLE =
  "App tool calls are unavailable with this Claude version.";
export const CLAUDE_MCP_APP_CATALOG_MAX_AGE_MS = 30_000;
const MAX_RESOURCE_URI_LENGTH = 4096;
const MAX_TOOLS = 2000;

/** One MCP tool as F5's shared MCP App policy reads it (`annotations.readOnlyHint`, `_meta`). */
export interface ClaudeMcpAppTool {
  readonly name: string;
  readonly description?: string;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly _meta?: Record<string, unknown>;
  /** `_meta.ui.resourceUri` (or the flat legacy key) when it is a bounded `ui://` URI. */
  readonly resourceUri?: string;
  readonly visibility: ReadonlyArray<"model" | "app">;
}

export interface ClaudeMcpAppCatalog {
  readonly epoch: number;
  readonly fetchedAt: number;
  /** Server name → tool name → tool. */
  readonly servers: ReadonlyMap<string, ReadonlyMap<string, ClaudeMcpAppTool>>;
  /** SDK-type servers (F5's in-process tools): never captured or called as apps. */
  readonly sdkServers: ReadonlySet<string>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function readResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  const uri = record(meta?.ui)?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") && uri.length <= MAX_RESOURCE_URI_LENGTH
    ? uri
    : undefined;
}

function readVisibility(meta: Record<string, unknown> | undefined): Array<"model" | "app"> {
  const visibility = record(meta?.ui)?.visibility;
  return Array.isArray(visibility)
    ? visibility.filter((entry): entry is "model" | "app" => entry === "model" || entry === "app")
    : [];
}

/** Builds the catalog from `mcpServerStatus()` rows; servers without a tool list are kept out. */
export function buildClaudeMcpAppCatalog(
  statuses: ReadonlyArray<unknown>,
  epoch: number,
  fetchedAt: number,
): ClaudeMcpAppCatalog {
  const servers = new Map<string, Map<string, ClaudeMcpAppTool>>();
  const sdkServers = new Set<string>();
  for (const status of statuses) {
    const row = record(status);
    const name = typeof row?.name === "string" ? row.name : undefined;
    if (!name) continue;
    if (record(row?.config)?.type === "sdk" || row?.source === "sdk") sdkServers.add(name);
    if (!Array.isArray(row?.tools) || row.tools.length > MAX_TOOLS) continue;
    const tools = new Map<string, ClaudeMcpAppTool>();
    for (const entry of row.tools) {
      const tool = record(entry);
      if (typeof tool?.name !== "string" || tools.has(tool.name)) continue;
      const annotations = record(tool.annotations);
      const meta = record(tool._meta);
      const resourceUri = readResourceUri(meta);
      tools.set(tool.name, {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        annotations: {
          readOnlyHint: annotations?.readOnly === true,
          ...(typeof annotations?.destructive === "boolean"
            ? { destructiveHint: annotations.destructive }
            : {}),
          ...(typeof annotations?.openWorld === "boolean"
            ? { openWorldHint: annotations.openWorld }
            : {}),
        },
        ...(meta ? { _meta: meta } : {}),
        ...(resourceUri ? { resourceUri } : {}),
        visibility: readVisibility(meta),
      });
    }
    servers.set(name, tools);
  }
  return { epoch, fetchedAt, servers, sdkServers };
}

export function isClaudeMcpAppCatalogFresh(
  catalog: ClaudeMcpAppCatalog | undefined,
  epoch: number,
  now: number,
): catalog is ClaudeMcpAppCatalog {
  return (
    catalog !== undefined &&
    catalog.epoch === epoch &&
    now - catalog.fetchedAt < CLAUDE_MCP_APP_CATALOG_MAX_AGE_MS
  );
}

/** Claude's model-facing name for a server's tool (`claude.ai Figma` → `mcp__claude_ai_Figma__…`). */
export function claudeMcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeClaudeMcpName(server)}__${normalizeClaudeMcpName(tool)}`;
}

/**
 * Resolves a completed Claude tool call (`mcp__<server>__<tool>`) to the app resource it
 * should render, under the configured server and tool names the SDK expects. Claude
 * sanitizes both names and a server name may itself contain `__`, so the call is matched
 * against each catalogued name rather than split. SDK-type servers and tools without a
 * `ui://` resource never qualify.
 */
export function resolveClaudeMcpAppTool(
  catalog: ClaudeMcpAppCatalog | undefined,
  toolName: string,
): { readonly server: string; readonly tool: string; readonly resourceUri: string } | undefined {
  if (!catalog || !toolName.startsWith("mcp__")) return undefined;
  const candidates = [...catalog.servers]
    .filter(([server]) => !catalog.sdkServers.has(server))
    .map(([server, tools]) => ({
      server,
      tools,
      prefix: `mcp__${normalizeClaudeMcpName(server)}__`,
    }))
    .filter(({ prefix }) => toolName.startsWith(prefix))
    // The longest server name wins when one sanitized name prefixes another.
    .toSorted((left, right) => right.prefix.length - left.prefix.length);
  for (const { server, tools, prefix } of candidates) {
    const remainder = toolName.slice(prefix.length);
    for (const tool of tools.values())
      if (tool.resourceUri && normalizeClaudeMcpName(tool.name) === remainder)
        return { server, tool: tool.name, resourceUri: tool.resourceUri };
  }
  return undefined;
}

/**
 * The tool result as an MCP `CallToolResult` for the app bootstrap: the structured
 * `tool_use_result` when it already has that shape, else the tool_result block's content.
 */
export function readClaudeMcpAppToolResult(structuredOutput: unknown, resultBlockContent: unknown) {
  return (
    readMcpAppToolResult(structuredOutput) ??
    readMcpAppToolResult({
      content: Array.isArray(resultBlockContent)
        ? resultBlockContent
        : typeof resultBlockContent === "string"
          ? [{ type: "text", text: resultBlockContent }]
          : [],
    })
  );
}

interface ClaudeControlQuery {
  readonly request?: (
    request: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{ readonly response?: unknown } | undefined>;
}

/**
 * Calls one MCP tool for an app, outside the model's turn, with `result_not_for_model` so
 * the server's own content blocks come back unprocessed. Throws when the CLI or SDK cannot
 * do it; never retried by callers (the tool may have run).
 */
export async function callClaudeMcpAppTool(input: {
  readonly query: unknown;
  readonly capabilities: ReadonlySet<string>;
  readonly server: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const query = input.query as ClaudeControlQuery;
  if (
    !input.capabilities.has("mcp_call_result_not_for_model_v1") ||
    typeof query.request !== "function"
  )
    throw new Error(CLAUDE_MCP_APP_UNAVAILABLE);
  const reply = await query.request(
    {
      subtype: "mcp_call",
      tool: claudeMcpToolName(input.server, input.tool),
      arguments: input.arguments,
      result_not_for_model: true,
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  return reply?.response;
}
