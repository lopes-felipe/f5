import type { ActiveProfile } from "@t3tools/contracts";
import { profileStateDir, profilesRootDir } from "@t3tools/shared/profilePaths";
import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
/**
 * ServerConfig - Runtime configuration services.
 *
 * Defines process-level server configuration and networking helpers used by
 * startup and runtime layers.
 *
 * @module ServerConfig
 */
import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect";

export const DEFAULT_PORT = 3773;

export type RuntimeMode = "web" | "desktop";

export interface ServerDerivedPaths {
  readonly providerHomesDir?: string;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath?: string;
  readonly secretsDir?: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly providerStatusCacheDir?: string;
  readonly terminalLogsDir: string;
  readonly anonymousIdPath: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly profile?: ActiveProfile;
  readonly profilesRoot?: string;
  readonly defaultStateDir?: string;
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  readonly cwd: string;
  readonly baseDir: string;
  readonly staticDir: string | undefined;
  readonly devUrl: URL | undefined;
  readonly noBrowser: boolean;
  readonly authToken: string | undefined;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
  readonly observabilityEnabled: boolean;
  readonly acpHardeningEnabled: boolean;
}

export const deriveServerPaths = Effect.fn(function* ({
  baseDir,
  defaultStateDir,
  profile = fallbackDefaultProfile(defaultStateDir),
}: {
  readonly baseDir: string;
  readonly defaultStateDir: string;
  readonly profile?: ActiveProfile;
}): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = profileStateDir(defaultStateDir, profile);
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(stateDir, "provider-status-cache");
  return {
    stateDir,
    providerHomesDir: join(stateDir, "provider-homes"),
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    secretsDir: join(stateDir, "secrets"),
    worktreesDir: join(profile.isDefault ? baseDir : stateDir, "worktrees"),
    attachmentsDir,
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    providerStatusCacheDir,
    terminalLogsDir: join(logsDir, "terminals"),
    anonymousIdPath: join(stateDir, "anonymous-id"),
  };
});

/** Create state directories only after migration and pending restore have completed. */
export const ensureStateDirectories = Effect.fn(function* (paths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of [paths.stateDir, paths.logsDir, paths.attachmentsDir, paths.secretsDir]) {
    if (directory) yield* fs.makeDirectory(directory, { recursive: true });
  }
});

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "t3/config/ServerConfig",
) {
  static readonly layerTest = (
    cwd: string,
    stateDirOrPrefix: string | { prefix: string },
    options?: { readonly acpHardeningEnabled?: boolean },
  ) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const devUrl = undefined;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let baseDir: string;
        let paths: ServerDerivedPaths;
        if (typeof stateDirOrPrefix === "string") {
          const stateDir = stateDirOrPrefix;
          baseDir = path.dirname(stateDir);
          paths = yield* deriveServerPaths({ baseDir, defaultStateDir: stateDir });
        } else {
          baseDir = yield* fs.makeTempDirectoryScoped({ prefix: stateDirOrPrefix.prefix });
          paths = yield* deriveServerPaths({
            baseDir,
            defaultStateDir: path.join(baseDir, "userdata"),
          });
        }

        yield* ensureStateDirectories(paths);

        return {
          cwd,
          baseDir,
          profile: fallbackDefaultProfile(paths.stateDir),
          profilesRoot: profilesRootDir(paths.stateDir),
          defaultStateDir: paths.stateDir,
          ...paths,
          mode: "web",
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: false,
          port: 0,
          host: undefined,
          authToken: undefined,
          staticDir: undefined,
          devUrl,
          noBrowser: false,
          observabilityEnabled: false,
          acpHardeningEnabled: options?.acpHardeningEnabled ?? false,
        };
      }),
    );
}

export const resolveStaticDir = Effect.fn(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;
  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const bundledStat = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (bundledStat) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const monorepoStat = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (monorepoStat) {
    return monorepoClient;
  }
  return undefined;
});
