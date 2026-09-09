import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Path } from "effect";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  const path = yield* Path.Path;
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (
      [
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      ].includes(key.toUpperCase())
    )
      delete env[key];
  }
  const drive = /^[a-z]:/i.exec(resolvedHomePath)?.[0];
  return {
    ...env,
    HOME: resolvedHomePath,
    USERPROFILE: resolvedHomePath,
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: resolvedHomePath.slice(2) } : {}),
    CLAUDE_CONFIG_DIR: path.join(resolvedHomePath, ".claude"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(resolvedHomePath, ".claude"),
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);
