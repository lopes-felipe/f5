import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { Effect, FileSystem, Path, Schema } from "effect";

import { expandHomePath } from "../../pathExpansion.ts";
import { accountUsageIdentity } from "../../usage/accountUsage.ts";
import { claudeManagedSettingsDir } from "../claudeInventory.ts";

/**
 * Mirrors the Claude CLI's config dir resolution:
 * `(CLAUDE_CONFIG_DIR ?? join(os.homedir(), ".claude")).normalize("NFC")`,
 * evaluated as the CLI child would see it.
 *
 * `os.homedir()` in the child reads `USERPROFILE` on Windows and `HOME`
 * elsewhere, so the matching variable is read from the child env for
 * `platform`. Relative values are resolved against `cwd`, the child's working
 * directory. When `cwd` is undefined the child inherits the server's cwd, so
 * `process.cwd()` is the right base.
 */
export function resolveClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  cwd?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || NodeOS.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR ?? NodePath.join(home, ".claude");
  return NodePath.resolve(cwd ?? process.cwd(), configDir.normalize("NFC"));
}

const decodeSettingsEnv = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

const CLAUDE_HOST_SESSION_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
]);

/**
 * Prepare Claude's child environment after account isolation and instance env
 * merging. Ignore the host's entrypoint, but honor an explicit instance value.
 * Claude reads this identifier before applying settings env, so copy its user
 * and managed settings override into the process environment ourselves.
 */
export const makeClaudeProcessEnvironment = Effect.fn("makeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<NodeJS.ProcessEnv, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cleanEnv = { ...baseEnv };
  for (const key of Object.keys(cleanEnv)) {
    if (CLAUDE_HOST_SESSION_VARIABLES.has(platform === "win32" ? key.toUpperCase() : key))
      delete cleanEnv[key];
  }
  // Account environment already includes instance values; reapply explicit overrides
  // after stripping inherited host session identity.
  for (const variable of instanceEnvironment ?? []) {
    if (
      CLAUDE_HOST_SESSION_VARIABLES.has(
        platform === "win32" ? variable.name.toUpperCase() : variable.name,
      )
    )
      cleanEnv[variable.name] = variable.value;
  }
  const environment = yield* makeClaudeEnvironment(config, cleanEnv, platform);
  const entrypoint =
    instanceEnvironment?.findLast((variable) =>
      platform === "win32"
        ? variable.name.toUpperCase() === "CLAUDE_CODE_ENTRYPOINT"
        : variable.name === "CLAUDE_CODE_ENTRYPOINT",
    )?.value ?? "t3-code";
  const managedPath = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const managedSettingsPath = managedPath.join(
    claudeManagedSettingsDir(platform),
    "managed-settings.json",
  );
  let settingsEntrypoint: string | undefined;
  for (const file of [
    path.join(resolveClaudeConfigDir(environment, undefined, platform), "settings.json"),
    managedSettingsPath,
  ]) {
    const value = yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeSettingsEnv),
      Effect.map((settings) => settings.env?.CLAUDE_CODE_ENTRYPOINT),
      Effect.orElseSucceed(() => undefined),
    );
    if (typeof value === "string") settingsEntrypoint = value;
  }
  const result: NodeJS.ProcessEnv = { ...environment };
  if (platform === "win32") {
    for (const key of Object.keys(result)) {
      if (key.toUpperCase() === "CLAUDE_CODE_ENTRYPOINT") delete result[key];
    }
  }
  result.CLAUDE_CODE_ENTRYPOINT = settingsEntrypoint || entrypoint;
  return result;
});

/**
 * Account identity for persisted usage history. Hashes the environment the
 * usage probe actually runs with, so a home-only configuration change is a
 * different account.
 */
export function claudeAccountUsageIdentity(binaryPath: string, env: NodeJS.ProcessEnv): string {
  return accountUsageIdentity("claude", [
    binaryPath,
    env.HOME,
    env.USERPROFILE,
    env.CLAUDE_CONFIG_DIR,
    env.ANTHROPIC_API_KEY,
  ]);
}

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
  platform: NodeJS.Platform = process.platform,
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
    // macOS locates the login keychain relative to the real user home.
    // Claude isolates its keychain item using CLAUDE_CONFIG_DIR instead.
    HOME:
      platform === "darwin" && baseEnv.F5_PROFILE_ISOLATED === "1"
        ? NodeOS.homedir()
        : resolvedHomePath,
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
