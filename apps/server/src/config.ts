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
}

export const deriveServerPaths = Effect.fn(function* (
  baseDir: ServerConfigShape["baseDir"],
  devUrl: ServerConfigShape["devUrl"],
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;
  const stateDir = join(baseDir, devUrl !== undefined ? "dev" : "userdata");
  const dbPath = join(stateDir, "state.sqlite");
  const attachmentsDir = join(stateDir, "attachments");
  const logsDir = join(stateDir, "logs");
  const providerLogsDir = join(logsDir, "provider");
  const providerStatusCacheDir = join(stateDir, "provider-status-cache");
  return {
    stateDir,
    dbPath,
    keybindingsConfigPath: join(stateDir, "keybindings.json"),
    settingsPath: join(stateDir, "settings.json"),
    secretsDir: join(stateDir, "secrets"),
    worktreesDir: join(baseDir, "worktrees"),
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

/**
 * ServerConfig - Service tag for server runtime configuration.
 */
export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "t3/config/ServerConfig",
) {
  static readonly layerTest = (cwd: string, stateDirOrPrefix: string | { prefix: string }) =>
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
          const logsDir = path.join(stateDir, "logs");
          const providerLogsDir = path.join(logsDir, "provider");
          paths = {
            stateDir,
            dbPath: path.join(stateDir, "state.sqlite"),
            keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
            settingsPath: path.join(stateDir, "settings.json"),
            secretsDir: path.join(stateDir, "secrets"),
            worktreesDir: path.join(baseDir, "worktrees"),
            attachmentsDir: path.join(stateDir, "attachments"),
            logsDir,
            serverLogPath: path.join(logsDir, "server.log"),
            providerLogsDir,
            providerEventLogPath: path.join(providerLogsDir, "events.log"),
            providerStatusCacheDir: path.join(stateDir, "provider-status-cache"),
            terminalLogsDir: path.join(logsDir, "terminals"),
            anonymousIdPath: path.join(stateDir, "anonymous-id"),
          };
        } else {
          baseDir = yield* fs.makeTempDirectoryScoped({ prefix: stateDirOrPrefix.prefix });
          paths = yield* deriveServerPaths(baseDir, devUrl);
        }

        yield* fs.makeDirectory(paths.stateDir, { recursive: true });
        yield* fs.makeDirectory(paths.logsDir, { recursive: true });
        yield* fs.makeDirectory(paths.attachmentsDir, { recursive: true });
        yield* fs.makeDirectory(paths.secretsDir ?? path.join(paths.stateDir, "secrets"), {
          recursive: true,
        });

        return {
          cwd,
          baseDir,
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
