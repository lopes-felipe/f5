import { Effect, Option } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { McpHub, type McpHubShape } from "./McpHub.ts";

/**
 * Codex and Claude adapter options: the hub, and a read of `mcpNativePassthrough`
 * taken at each session start, so the setting applies to new sessions at once.
 */
export const nativeMcpHubAdapterOptions = Effect.gen(function* () {
  const hub = yield* Effect.serviceOption(McpHub);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const options: {
    mcpHub?: McpHubShape;
    mcpNativePassthrough?: Effect.Effect<boolean>;
  } = {};
  if (Option.isSome(hub)) options.mcpHub = hub.value;
  if (Option.isSome(settings))
    options.mcpNativePassthrough = settings.value.getSettings.pipe(
      Effect.map((value) => value.mcpNativePassthrough),
      Effect.orElseSucceed(() => false),
    );
  return options;
});

/**
 * Builds a check of whether F5's hub serves Codex and Claude sessions: the hub can
 * mount endpoints and `mcpNativePassthrough` is off. Read per call, like sessions do.
 */
export const makeNativeProvidersOnHub = nativeMcpHubAdapterOptions.pipe(
  Effect.map(
    ({ mcpHub, mcpNativePassthrough }): Effect.Effect<boolean> =>
      mcpHub?.available
        ? (mcpNativePassthrough ?? Effect.succeed(false)).pipe(
            Effect.map((passthrough) => !passthrough),
          )
        : Effect.succeed(false),
  ),
);

/**
 * With the hub serving Codex, its admin app-server (status, reconnect and sign-in for
 * Codex's own servers) carries none of F5's servers, so one pooled client outlives saves.
 */
export const CODEX_ADMIN_HUB_CONFIG_VERSION = "f5-mcp-hub";

/** The MCP part of a Codex admin client request, with or without F5's servers. */
export function codexAdminMcpConfig<TEntry>(
  stored: {
    readonly effectiveVersion: string;
    readonly servers: Record<string, TEntry>;
    readonly oauthCallbackPort?: number;
    readonly oauthCallbackUrl?: string;
  },
  onHub: boolean,
): {
  readonly mcpEffectiveConfigVersion: string;
  readonly mcpServers: Record<string, TEntry>;
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
} {
  if (onHub) return { mcpEffectiveConfigVersion: CODEX_ADMIN_HUB_CONFIG_VERSION, mcpServers: {} };
  return {
    mcpEffectiveConfigVersion: stored.effectiveVersion,
    mcpServers: stored.servers,
    ...(stored.oauthCallbackPort ? { mcpOAuthCallbackPort: stored.oauthCallbackPort } : {}),
    ...(stored.oauthCallbackUrl ? { mcpOAuthCallbackUrl: stored.oauthCallbackUrl } : {}),
  };
}
