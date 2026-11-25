/**
 * Which providers get a configured MCP server, and how completely. A provider is
 * Off when the user turned it off for the server, Limited when the server sets a
 * field that provider ignores, and Supported otherwise. Settings shows this as the
 * server's provider matrix.
 *
 * @module mcpProviderSupport
 */
import {
  KNOWN_PROVIDER_KINDS,
  type McpServerDefinition,
  type ProviderKind,
} from "@t3tools/contracts";

export type McpProviderSupportLevel = "supported" | "limited" | "off";

export interface McpProviderSupport {
  readonly provider: ProviderKind;
  readonly support: McpProviderSupportLevel;
  /** What the provider ignores or changes for this server; empty unless Limited. */
  readonly reasons: ReadonlyArray<string>;
}

/** Providers that reach configured servers through F5's MCP hub. */
export const MCP_HUB_PROVIDERS: ReadonlyArray<ProviderKind> = KNOWN_PROVIDER_KINDS.filter(
  (provider) => provider !== "codex" && provider !== "claudeAgent",
);

function setField(server: McpServerDefinition, field: keyof McpServerDefinition): boolean {
  const value = server[field];
  if (value === undefined) return false;
  return !Array.isArray(value) || value.length > 0;
}

function limitations(server: McpServerDefinition, provider: ProviderKind): string[] {
  const reasons: string[] = [];
  if (provider === "codex") {
    if (server.type === "sse")
      reasons.push("Connects with streamable HTTP, so SSE-only endpoints fail");
    if (server.type === "stdio" && server.connectionScope === "shared")
      reasons.push("Starts its own copy of the server in each session");
    return reasons;
  }
  if (provider === "claudeAgent") {
    if (server.type === "stdio" && setField(server, "cwd"))
      reasons.push("Ignores the working directory; the server starts in the conversation's");
    if (server.type === "stdio" && server.connectionScope === "shared")
      reasons.push("Starts its own copy of the server in each session");
    const ignored = [
      setField(server, "startupTimeoutSec") && "startup timeout",
      setField(server, "supportsParallelToolCalls") && "parallel tool calls",
      setField(server, "scopes") && "OAuth scopes",
      setField(server, "oauthCallbackUrl") && "OAuth callback URL",
      setField(server, "oauthResource") && "OAuth resource",
    ].filter((label): label is string => typeof label === "string");
    if (ignored.length) reasons.push(`Ignores ${ignored.join(", ")}`);
    return reasons;
  }
  if (setField(server, "supportsParallelToolCalls")) reasons.push("Ignores parallel tool calls");
  return reasons;
}

export function mcpProviderSupport(
  server: McpServerDefinition,
  provider: ProviderKind,
): McpProviderSupport {
  if (server.disabledProviders?.includes(provider))
    return { provider, support: "off", reasons: [] };
  const reasons = limitations(server, provider);
  return { provider, support: reasons.length ? "limited" : "supported", reasons };
}

/** One entry per known provider, Codex and Claude first. */
export function mcpProviderMatrix(server: McpServerDefinition): McpProviderSupport[] {
  return KNOWN_PROVIDER_KINDS.map((provider) => mcpProviderSupport(server, provider));
}

/** The server with `provider` turned on or off; an empty list is removed. */
export function setMcpProviderEnabled<T extends McpServerDefinition>(
  server: T,
  provider: ProviderKind,
  enabled: boolean,
): T {
  const others = (server.disabledProviders ?? []).filter((entry) => entry !== provider);
  const disabledProviders = enabled ? others : [...others, provider];
  const { disabledProviders: _previous, ...rest } = server;
  return (disabledProviders.length ? { ...rest, disabledProviders } : rest) as T;
}
