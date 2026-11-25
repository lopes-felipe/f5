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
