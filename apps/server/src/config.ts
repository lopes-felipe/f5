import { join as nodePathJoin } from "node:path";

import type { ActiveProfile, ProfileId } from "@t3tools/contracts";
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

/** Where F5 keeps provider homes; configs built by hand (tests) may leave it unset. */
export function resolveProviderHomesDir(
  paths: Pick<ServerDerivedPaths, "providerHomesDir" | "stateDir">,
): string {
  return paths.providerHomesDir ?? nodePathJoin(paths.stateDir, "provider-homes");
}

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
  /**
   * Durable copies of pasted workflow attachments, referenced by absolute path in
   * workflow prompts. Kept outside `attachmentsDir` so upload and registry sweeps skip it.
   */
  readonly workflowAttachmentsDir?: string;
  readonly logsDir: string;
  readonly serverLogPath: string;
  readonly providerLogsDir: string;
  readonly providerEventLogPath: string;
  readonly providerStatusCacheDir?: string;
  readonly terminalLogsDir: string;
}

/**
 * ServerConfigShape - Process/runtime configuration required by the server.
 */
export interface ServerConfigShape extends ServerDerivedPaths {
  readonly profile?: ActiveProfile;
  /**
   * In a Linux VM guest, the host's VM profile this backend serves (see
   * `resolveGuestProfileIdentity`). The welcome and profile list report it, and profile
   * changes are refused; `profile` and every path stay the guest's own.
   */
  readonly guestProfileId?: ProfileId;
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
  /** Master key for secrets encrypted at rest, from desktop main; see `secretStoreKey.ts`. */
  readonly secretStoreKey?: Uint8Array | undefined;
  /** Reverse proxies whose `X-Forwarded-For` is believed; see `ServerAuthOptions.trustedProxies`. */
  readonly trustedProxies?: ReadonlyArray<string>;
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly logWebSocketEvents: boolean;
  readonly observabilityEnabled: boolean;
  readonly acpHardeningEnabled: boolean;
  readonly githubPrEventsEnabled?: boolean;
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
    workflowAttachmentsDir: join(stateDir, "workflow-attachments"),
    logsDir,
    serverLogPath: join(logsDir, "server.log"),
    providerLogsDir,
    providerEventLogPath: join(providerLogsDir, "events.log"),
    providerStatusCacheDir,
    terminalLogsDir: join(logsDir, "terminals"),
  };
});

/** Create state directories only after migration and pending restore have completed. */
export const ensureStateDirectories = Effect.fn(function* (paths: ServerDerivedPaths) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of [paths.stateDir, paths.logsDir, paths.attachmentsDir, paths.secretsDir]) {
    if (directory) yield* fs.makeDirectory(directory, { recursive: true });
  }
  // Logs, traces and the database use the process umask; restrict access at their parent.
  yield* fs
    .chmod(paths.stateDir, 0o700)
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not restrict state directory permissions.", { cause }),
      ),
    );
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
    options?: { readonly acpHardeningEnabled?: boolean; readonly mode?: "web" | "desktop" },
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
          mode: options?.mode ?? "web",
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
  const bundledClient = resolve(
    join(process.env.F5_STANDALONE_DIR ?? import.meta.dirname, "client"),
  );
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
