import { Effect, Option } from "effect";

import { McpHub, type McpHubShape } from "./McpHub.ts";

/** Codex and Claude adapter options: the hub that serves their configured servers. */
export const nativeMcpHubAdapterOptions = Effect.gen(function* () {
  const hub = yield* Effect.serviceOption(McpHub);
  const options: { mcpHub?: McpHubShape } = {};
  if (Option.isSome(hub)) options.mcpHub = hub.value;
  return options;
});

/**
 * Codex's admin app-server (status, reconnect and sign-in for Codex's own servers)
 * carries none of F5's servers, which reach Codex only through the hub, so one pooled
 * client outlives saves.
 */
export const CODEX_ADMIN_HUB_CONFIG_VERSION = "f5-mcp-hub";

/** The MCP part of every Codex admin client request. */
export const CODEX_ADMIN_MCP_CONFIG = {
  mcpEffectiveConfigVersion: CODEX_ADMIN_HUB_CONFIG_VERSION,
  mcpServers: {},
} as const;
