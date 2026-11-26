/**
 * Which providers get a configured MCP server, and how completely. A provider is
 * Off when the user turned it off for the server, Limited when the server sets a
 * field that provider ignores, and Supported otherwise. Settings shows this as the
 * server's provider matrix.
 *
 * @module mcpProviderSupport
 */
import {
  isKnownProviderKind,
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

/** Every provider reaches configured servers through F5's MCP hub. */
export const MCP_HUB_PROVIDERS: ReadonlyArray<ProviderKind> = KNOWN_PROVIDER_KINDS;

function setField(server: McpServerDefinition, field: keyof McpServerDefinition): boolean {
  const value = server[field];
  if (value === undefined) return false;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * F5's hub runs every server itself, so only what an agent's own MCP client ignores
 * remains. Codex honors parallel tool calls on its entry for the hub endpoint.
 */
function limitations(server: McpServerDefinition, provider: ProviderKind): string[] {
  if (provider === "codex") return [];
  return setField(server, "supportsParallelToolCalls") ? ["Ignores parallel tool calls"] : [];
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
  // Names this version does not know cannot be written back, so they are dropped.
  const others = (server.disabledProviders ?? []).filter(
    (entry) => entry !== provider && isKnownProviderKind(entry),
  );
  const disabledProviders = enabled ? others : [...others, provider];
  const { disabledProviders: _previous, ...rest } = server;
  return (disabledProviders.length ? { ...rest, disabledProviders } : rest) as T;
}
