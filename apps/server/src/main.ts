/**
 * CliConfig - CLI/runtime bootstrap service definitions.
 *
 * Defines startup-only service contracts used while resolving process config
 * and constructing server runtime layers.
 *
 * @module CliConfig
 */
import { Config, Data, Effect, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { NetService } from "@t3tools/shared/Net";
import { legacyT3UserdataStateDir } from "@t3tools/shared/appStatePaths";
import {
  DEFAULT_PORT,
  deriveServerPaths,
  resolveStaticDir,
  ServerConfig,
  type RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { applyPendingRestore } from "./backupService.ts";
import { fixPath, resolveBaseDir, resolveStateDir } from "./os-jank";
import { Open } from "./open";
import * as SqlitePersistence from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import {
  migrateLegacyT3StateIfNeeded,
  shouldMigrateLegacyT3State,
  writeLegacyStateMigrationFailureSentinel,
} from "./legacyStateMigration";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { Server } from "./wsServer";
import { ServerLoggerLive } from "./serverLogger";
import { MIN_REMOTE_AUTH_TOKEN_BYTES } from "./serverAuth";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { withStartupPhaseTiming } from "./startupTiming";

export class StartupError extends Data.TaggedError("StartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CliInput {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly t3Home: Option.Option<string>;
  readonly stateDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

/**
 * CliConfigShape - Startup helpers required while building server layers.
 */
export interface CliConfigShape {
  /**
   * Current process working directory.
   */
  readonly cwd: string;

  /**
   * Apply OS-specific PATH normalization.
   */
  readonly fixPath: Effect.Effect<void>;

  /**
   * Resolve static web asset directory for server mode.
   */
  readonly resolveStaticDir: Effect.Effect<string | undefined>;
}

/**
 * CliConfig - Service tag for startup CLI/runtime helpers.
 */
export class CliConfig extends ServiceMap.Service<CliConfig, CliConfigShape>()(
  "t3/main/CliConfig",
) {
  static readonly layer = Layer.effect(
    CliConfig,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        cwd: process.cwd(),
        fixPath: Effect.promise(fixPath),
        resolveStaticDir: resolveStaticDir().pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      } satisfies CliConfigShape;
    }),
  );
}

const CliEnvConfig = Config.all({
  mode: Config.string("T3CODE_MODE").pipe(
    Config.option,
    Config.map(
      Option.match<RuntimeMode, string>({
        onNone: () => "web",
        onSome: (value) => (value === "desktop" ? "desktop" : "web"),
      }),
    ),
  ),
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  f5Home: Config.string("F5_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  f5StateDir: Config.string("F5_STATE_DIR").pipe(Config.option, Config.map(Option.getOrUndefined)),
  stateDir: Config.string("T3CODE_STATE_DIR").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("T3CODE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  observabilityEnabled: Config.boolean("T3CODE_OBSERVABILITY_ENABLED").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  acpHardeningEnabled: Config.boolean("F5_ACP_HARDENING_ENABLED").pipe(Config.withDefault(false)),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const optionStringToTrimmedUndefined = (value: Option.Option<string>): string | undefined =>
  trimToUndefined(Option.getOrUndefined(value));

const ServerConfigLive = (input: CliInput) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const cliConfig = yield* CliConfig;
      // This layer is acquired before provider layers. Hydrate PATH here so
      // their initial availability probes use the effective child environment.
      yield* cliConfig.fixPath;
      const { findAvailablePort } = yield* NetService;
      const env = yield* CliEnvConfig.asEffect().pipe(
        Effect.mapError(
          (cause) =>
            new StartupError({ message: "Failed to read environment configuration", cause }),
        ),
      );

      const mode = Option.getOrElse(input.mode, () => env.mode);

      const port = yield* Option.match(input.port, {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (env.port) {
            return Effect.succeed(env.port);
          }
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      });
      const devUrl = Option.getOrElse(input.devUrl, () => env.devUrl);
      const explicitStateDir =
        optionStringToTrimmedUndefined(input.stateDir) ??
        trimToUndefined(env.f5StateDir) ??
        trimToUndefined(env.stateDir);
      const path = yield* Path.Path;
      const resolvedExplicitStateDir =
        explicitStateDir !== undefined ? yield* resolveStateDir(explicitStateDir) : undefined;
      const explicitHomeDir =
        optionStringToTrimmedUndefined(input.t3Home) ??
        trimToUndefined(env.f5Home) ??
        trimToUndefined(env.t3Home);
      const baseDir =
        resolvedExplicitStateDir !== undefined
          ? path.dirname(resolvedExplicitStateDir)
          : yield* resolveBaseDir(explicitHomeDir);
      const derivedPaths =
        resolvedExplicitStateDir !== undefined
          ? {
              stateDir: resolvedExplicitStateDir,
              dbPath: path.join(resolvedExplicitStateDir, "state.sqlite"),
              keybindingsConfigPath: path.join(resolvedExplicitStateDir, "keybindings.json"),
              worktreesDir: path.join(baseDir, "worktrees"),
              attachmentsDir: path.join(resolvedExplicitStateDir, "attachments"),
              logsDir: path.join(resolvedExplicitStateDir, "logs"),
              serverLogPath: path.join(resolvedExplicitStateDir, "logs", "server.log"),
              providerLogsDir: path.join(resolvedExplicitStateDir, "logs", "provider"),
              providerEventLogPath: path.join(
                resolvedExplicitStateDir,
                "logs",
                "provider",
                "events.log",
              ),
              terminalLogsDir: path.join(resolvedExplicitStateDir, "logs", "terminals"),
              anonymousIdPath: path.join(resolvedExplicitStateDir, "anonymous-id"),
            }
          : yield* deriveServerPaths(baseDir, devUrl);
      const noBrowser = resolveBooleanFlag(input.noBrowser, env.noBrowser ?? mode === "desktop");
      const authToken = trimToUndefined(Option.getOrUndefined(input.authToken) ?? env.authToken);
      const autoBootstrapProjectFromCwd = resolveBooleanFlag(
        input.autoBootstrapProjectFromCwd,
        env.autoBootstrapProjectFromCwd ?? mode === "web",
      );
      const logWebSocketEvents = resolveBooleanFlag(
        input.logWebSocketEvents,
        env.logWebSocketEvents ?? Boolean(devUrl),
      );
      const staticDir = devUrl ? undefined : yield* cliConfig.resolveStaticDir;
      const host = Option.getOrUndefined(input.host) ?? env.host ?? "127.0.0.1";

      if (!isLoopbackHost(host) && !authToken) {
        return yield* new StartupError({
          message:
            `Refusing to bind F5 to non-loopback host '${host}' without authentication. ` +
            "Set --auth-token (or T3CODE_AUTH_TOKEN), or bind to 127.0.0.1/localhost.",
        });
      }
      if (
        !isLoopbackHost(host) &&
        authToken &&
        Buffer.byteLength(authToken, "utf8") < MIN_REMOTE_AUTH_TOKEN_BYTES
      ) {
        return yield* new StartupError({
          message:
            `Remote authentication tokens must be at least ${MIN_REMOTE_AUTH_TOKEN_BYTES} bytes. ` +
            "Generate one with `openssl rand -hex 24`.",
        });
      }

      const config: ServerConfigShape = {
        mode,
        port,
        cwd: cliConfig.cwd,
        baseDir,
        ...derivedPaths,
        host,
        staticDir,
        devUrl,
        noBrowser,
        authToken,
        autoBootstrapProjectFromCwd,
        logWebSocketEvents,
        observabilityEnabled: env.observabilityEnabled ?? false,
        acpHardeningEnabled: env.acpHardeningEnabled,
      } satisfies ServerConfigShape;

      const legacyT3StateDir = legacyT3UserdataStateDir();
      if (path.resolve(config.stateDir) === path.resolve(legacyT3StateDir)) {
        return yield* new StartupError({
          message:
            "Refusing to use the legacy T3 Code userdata directory as F5 state. " +
            "Unset F5_HOME/F5_STATE_DIR/T3CODE_HOME/T3CODE_STATE_DIR or point them outside ~/.t3 " +
            "so F5 can copy legacy state without mutating the original database.",
        });
      }

      if (
        shouldMigrateLegacyT3State({
          stateDir: config.stateDir,
          baseDir: config.baseDir,
          hasExplicitStateDir: resolvedExplicitStateDir !== undefined,
          devUrl: config.devUrl,
        })
      ) {
        const result = yield* migrateLegacyT3StateIfNeeded({
          targetStateDir: config.stateDir,
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                "failed to copy legacy T3 state into F5 state directory; continuing with empty F5 state",
                { cause },
              );
              yield* writeLegacyStateMigrationFailureSentinel({
                targetStateDir: config.stateDir,
                cause,
              }).pipe(
                Effect.catch((sentinelCause) =>
                  Effect.logWarning("failed to write legacy migration failure sentinel", {
                    cause: sentinelCause,
                  }),
                ),
              );
              return { status: "skipped", reason: "previous-failure" } as const;
            }),
          ),
        );
        if (result.status === "migrated") {
          yield* Effect.logInfo("copied legacy T3 state into F5 state directory", {
            legacyStateDir: result.legacyStateDir,
            targetStateDir: result.targetStateDir,
          });
        } else if (result.reason === "previous-failure") {
          yield* Effect.logWarning("legacy T3 state migration was skipped after a prior failure", {
            targetStateDir: config.stateDir,
          });
        }
      }

      const restoreResult = yield* Effect.tryPromise({
        try: () => applyPendingRestore(config),
        catch: (cause) =>
          new StartupError({
            message: `Failed to apply staged restore: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
      if (restoreResult.status === "applied") {
        yield* Effect.logInfo("applied staged F5 restore", {
          restoreId: restoreResult.restoreId,
          rollbackDir: restoreResult.rollbackDir,
        });
      }

      return config;
    }).pipe(
      Effect.withSpan("server.startup.config.resolve", {
        attributes: {
          "startup.phase": "config.resolve",
        },
      }),
    ),
  );

const isTestRuntime = () => process.env.NODE_ENV === "test" || process.env.VITEST === "true";

const CliRuntimeLayerLive = Layer.empty.pipe(
  Layer.provideMerge(makeServerRuntimeServicesLayer()),
  Layer.provideMerge(makeServerProviderLayer()),
  Layer.provideMerge(SqlitePersistence.layerConfig),
  Layer.provideMerge(ServerLoggerLive),
  Layer.provideMerge(AnalyticsServiceLayerLive),
);

const CliRuntimeLayerTest = Layer.empty as unknown as typeof CliRuntimeLayerLive;

const makeCliRuntimeLayer = (): typeof CliRuntimeLayerLive =>
  isTestRuntime() ? CliRuntimeLayerTest : CliRuntimeLayerLive;

const LayerLive = (input: CliInput) =>
  makeCliRuntimeLayer().pipe(Layer.provideMerge(ServerConfigLive(input)));

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const isLoopbackHost = (host: string | undefined): boolean => {
  const normalized =
    host
      ?.trim()
      .toLowerCase()
      .replace(/^\[|\]$/gu, "") ?? "";
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
};

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getStartupSnapshot().pipe(
    Effect.map(({ snapshot }) => ({
      threadCount: snapshot.threads.length,
      projectCount: snapshot.projects.length,
    })),
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup snapshot for telemetry", { cause }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
}).pipe(
  Effect.withSpan("server.startup.heartbeat.record", {
    attributes: {
      "startup.phase": "telemetry.heartbeat.record",
    },
  }),
);

const makeServerProgram = (input: CliInput) =>
  Effect.gen(function* () {
    const { start, stopSignal } = yield* Server;
    const openDeps = yield* Open;

    const config = yield* withStartupPhaseTiming("config.resolve", ServerConfig.asEffect());
    yield* Effect.logInfo("server instrumentation flags", {
      threadOpenTimingsEnv: process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS ?? null,
      threadOpenTimingsEnabled:
        process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "1" ||
        process.env.T3CODE_LOG_THREAD_OPEN_TIMINGS === "true",
      projectionTimingsEnv: process.env.T3CODE_LOG_PROJECTION_TIMINGS ?? null,
      projectionTimingsEnabled:
        process.env.T3CODE_LOG_PROJECTION_TIMINGS === "1" ||
        process.env.T3CODE_LOG_PROJECTION_TIMINGS === "true",
    });

    if (!config.devUrl && !config.staticDir) {
      yield* Effect.logWarning(
        "web bundle missing and no VITE_DEV_SERVER_URL; web UI unavailable",
        {
          hint: "Run `bun run --cwd apps/web build` or set VITE_DEV_SERVER_URL for dev mode.",
        },
      );
    }

    if (!isLoopbackHost(config.host)) {
      yield* Effect.logWarning("remote binding has no built-in TLS termination", {
        host: config.host,
        hint:
          "Use an HTTPS/WSS reverse proxy or an encrypted private network such as Tailscale; " +
          "direct HTTP/WS sends authentication credentials in cleartext.",
      });
    }

    yield* withStartupPhaseTiming("server.start", start);
    if (!isTestRuntime()) {
      yield* withStartupPhaseTiming(
        "telemetry.heartbeat.fork",
        Effect.forkChild(recordStartupHeartbeat.pipe(Effect.delay("1 minute"))),
      );
    }

    const localUrl = `http://localhost:${config.port}`;
    const bindUrl =
      config.host && !isWildcardHost(config.host)
        ? `http://${formatHostForUrl(config.host)}:${config.port}`
        : localUrl;
    const { authToken, devUrl, ...safeConfig } = config;
    yield* Effect.logInfo("F5 running", {
      ...safeConfig,
      devUrl: devUrl?.toString(),
      authEnabled: Boolean(authToken),
    });

    if (!config.noBrowser) {
      const baseTarget = config.devUrl?.toString() ?? bindUrl;
      const target =
        config.authToken && !config.devUrl
          ? `${baseTarget.replace(/#.*$/u, "")}#token=${encodeURIComponent(config.authToken)}`
          : baseTarget;
      yield* withStartupPhaseTiming(
        "browser.open",
        openDeps.openBrowser(target).pipe(
          Effect.catch(() =>
            Effect.logInfo("browser auto-open unavailable", {
              hint: config.authToken
                ? `Open ${baseTarget} and supply the configured launch token in the URL fragment.`
                : `Open ${baseTarget} in your browser.`,
            }),
          ),
        ),
      );
    }

    return yield* stopSignal;
  }).pipe(Effect.withSpan("server.startup"), Effect.provide(LayerLive(input)));

/**
 * These flags mirrors the environment variables and the config shape.
 */

const modeFlag = Flag.choice("mode", ["web", "desktop"]).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const t3HomeFlag = Flag.string("home-dir").pipe(
  Flag.withDescription("Base directory for all F5 data (equivalent to F5_HOME/T3CODE_HOME)."),
  Flag.optional,
);
const stateDirFlag = Flag.string("state-dir").pipe(
  Flag.withDescription("State directory path (equivalent to F5_STATE_DIR/T3CODE_STATE_DIR)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for remote HTTP and WebSocket access."),
  Flag.withAlias("token"),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

export const t3Cli = Command.make("t3", {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  t3Home: t3HomeFlag,
  stateDir: stateDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
}).pipe(
  Command.withDescription("Run the F5 server."),
  Command.withHandler((input) => Effect.scoped(makeServerProgram(input))),
);
