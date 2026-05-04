import * as Http from "node:http";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import { FetchHttpClient } from "effect/unstable/http";
import { beforeEach } from "vitest";
import { NetService } from "@t3tools/shared/Net";
import { legacyT3BaseDir, legacyT3UserdataStateDir } from "@t3tools/shared/appStatePaths";

import { CliConfig, recordStartupHeartbeat, t3Cli, type CliConfigShape } from "./main";
import { ServerConfig, type ServerConfigShape } from "./config";
import { LEGACY_STATE_MIGRATION_FAILURE_SENTINEL } from "./legacyStateMigration";
import { Open, type OpenShape } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { Server, type ServerShape } from "./wsServer";

const start = vi.fn(() => undefined);
const stop = vi.fn(() => undefined);
let resolvedConfig: ServerConfigShape | null = null;
const serverStart = Effect.acquireRelease(
  Effect.gen(function* () {
    resolvedConfig = yield* ServerConfig;
    start();
    return {} as unknown as Http.Server;
  }),
  () => Effect.sync(() => stop()),
);
const findAvailablePort = vi.fn((preferred: number) => Effect.succeed(preferred));

// Shared service layer used by this CLI test suite.
const testLayer = Layer.mergeAll(
  Layer.succeed(CliConfig, {
    cwd: "/tmp/t3-test-workspace",
    fixPath: Effect.void,
    resolveStaticDir: Effect.undefined,
  } satisfies CliConfigShape),
  Layer.succeed(NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort,
  }),
  Layer.succeed(Server, {
    start: serverStart,
    stopSignal: Effect.void,
  } satisfies ServerShape),
  Layer.succeed(Open, {
    openBrowser: (_target: string) => Effect.void,
    openInEditor: () => Effect.void,
  } satisfies OpenShape),
  AnalyticsService.layerTest,
  FetchHttpClient.layer,
  NodeServices.layer,
);

const runCli = (
  args: ReadonlyArray<string>,
  env: Record<string, string> = { T3CODE_NO_BROWSER: "true" },
  options: { readonly injectDefaultStateDir?: boolean } = {},
) => {
  const uniqueStateDir = `/tmp/t3-cli-state-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const baseEnv =
    options.injectDefaultStateDir === false
      ? {}
      : {
          T3CODE_STATE_DIR: uniqueStateDir,
        };
  return Command.runWith(t3Cli, { version: "0.0.0-test" })(args).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            ...baseEnv,
            ...env,
          },
        }),
      ),
    ),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConfig = null;
  start.mockImplementation(() => undefined);
  stop.mockImplementation(() => undefined);
  findAvailablePort.mockImplementation((preferred: number) => Effect.succeed(preferred));
});

it.layer(testLayer)("server CLI command", (it) => {
  it.effect("parses all CLI flags and wires scoped start/stop", () =>
    Effect.gen(function* () {
      yield* runCli([
        "--mode",
        "desktop",
        "--port",
        "4010",
        "--host",
        "0.0.0.0",
        "--state-dir",
        "/tmp/t3-cli-state",
        "--dev-url",
        "http://127.0.0.1:5173",
        "--no-browser",
        "--auth-token",
        "auth-secret",
      ]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.port, 4010);
      assert.equal(resolvedConfig?.host, "0.0.0.0");
      assert.equal(resolvedConfig?.stateDir, "/tmp/t3-cli-state");
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://127.0.0.1:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.authToken, "auth-secret");
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, false);
      assert.equal(resolvedConfig?.logWebSocketEvents, true);
      assert.equal(resolvedConfig?.observabilityEnabled, false);
      assert.equal(stop.mock.calls.length, 1);
    }),
  );

  it.effect("supports --token as an alias for --auth-token", () =>
    Effect.gen(function* () {
      yield* runCli(["--token", "token-secret"]);

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.authToken, "token-secret");
    }),
  );

  it.effect("uses env fallbacks when flags are not provided", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_MODE: "desktop",
        T3CODE_PORT: "4999",
        T3CODE_HOST: "100.88.10.4",
        T3CODE_STATE_DIR: "/tmp/t3-env-state",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        T3CODE_NO_BROWSER: "true",
        T3CODE_AUTH_TOKEN: "env-token",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.port, 4999);
      assert.equal(resolvedConfig?.host, "100.88.10.4");
      assert.equal(resolvedConfig?.stateDir, "/tmp/t3-env-state");
      assert.equal(resolvedConfig?.devUrl?.toString(), "http://localhost:5173/");
      assert.equal(resolvedConfig?.noBrowser, true);
      assert.equal(resolvedConfig?.authToken, "env-token");
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, false);
      assert.equal(resolvedConfig?.logWebSocketEvents, true);
      assert.equal(resolvedConfig?.observabilityEnabled, false);
      assert.equal(findAvailablePort.mock.calls.length, 0);
    }),
  );

  it.effect("prefers F5_STATE_DIR over legacy T3CODE_STATE_DIR", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        F5_STATE_DIR: "/tmp/f5-env-state",
        T3CODE_STATE_DIR: "/tmp/t3-env-state",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.stateDir, "/tmp/f5-env-state");
    }),
  );

  it.effect("ignores empty F5_STATE_DIR before legacy T3CODE_STATE_DIR", () =>
    Effect.gen(function* () {
      yield* runCli(
        [],
        {
          F5_STATE_DIR: "   ",
          T3CODE_STATE_DIR: "/tmp/t3-env-state",
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.stateDir, "/tmp/t3-env-state");
    }),
  );

  it.effect("prefers CLI --state-dir over F5_STATE_DIR", () =>
    Effect.gen(function* () {
      yield* runCli(["--state-dir", "/tmp/cli-state"], {
        F5_STATE_DIR: "/tmp/f5-env-state",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.stateDir, "/tmp/cli-state");
    }),
  );

  it.effect("prefers F5_HOME over legacy T3CODE_HOME", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      process.env.HOME = `/tmp/f5-main-test-home-${Date.now()}`;
      yield* runCli(
        [],
        {
          F5_HOME: "/tmp/f5-home",
          T3CODE_HOME: "/tmp/t3-home",
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.baseDir, "/tmp/f5-home");
      assert.equal(resolvedConfig?.stateDir, "/tmp/f5-home/userdata");
    }),
  );

  it.effect("ignores empty F5_HOME before legacy T3CODE_HOME", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      process.env.HOME = `/tmp/f5-main-test-home-${Date.now()}`;
      yield* runCli(
        [],
        {
          F5_HOME: "   ",
          T3CODE_HOME: "/tmp/t3-home",
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.baseDir, "/tmp/t3-home");
      assert.equal(resolvedConfig?.stateDir, "/tmp/t3-home/userdata");
    }),
  );

  it.effect("prefers CLI --home-dir over F5_HOME", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      process.env.HOME = `/tmp/f5-main-test-home-${Date.now()}`;
      yield* runCli(
        ["--home-dir", "/tmp/cli-home"],
        {
          F5_HOME: "/tmp/f5-home",
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.baseDir, "/tmp/cli-home");
      assert.equal(resolvedConfig?.stateDir, "/tmp/cli-home/userdata");
    }),
  );

  it.effect("refuses to use the legacy T3 userdata directory as F5 state", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-main-home-"));
      process.env.HOME = home;
      yield* runCli(
        [],
        {
          F5_HOME: legacyT3BaseDir(home),
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.catch(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("skips legacy migration when an explicit state directory is configured", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-main-home-"));
      const explicitStateDir = Path.join(home, "explicit-userdata");
      const legacyStateDir = legacyT3UserdataStateDir(home);
      FS.mkdirSync(legacyStateDir, { recursive: true });
      FS.writeFileSync(Path.join(legacyStateDir, "state.sqlite"), "not a sqlite database");
      process.env.HOME = home;

      yield* runCli(
        [],
        {
          F5_STATE_DIR: explicitStateDir,
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
            FS.rmSync(home, { recursive: true, force: true });
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(FS.existsSync(Path.join(explicitStateDir, "state.sqlite")), false);
      assert.equal(
        FS.existsSync(Path.join(explicitStateDir, LEGACY_STATE_MIGRATION_FAILURE_SENTINEL)),
        false,
      );
      FS.rmSync(home, { recursive: true, force: true });
    }),
  );

  it.effect("continues startup when legacy migration fails and writes a retry sentinel", () =>
    Effect.gen(function* () {
      const previousHome = process.env.HOME;
      const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-main-home-"));
      const legacyStateDir = legacyT3UserdataStateDir(home);
      FS.mkdirSync(legacyStateDir, { recursive: true });
      FS.writeFileSync(Path.join(legacyStateDir, "state.sqlite"), "not a sqlite database");
      process.env.HOME = home;

      yield* runCli(
        [],
        {
          T3CODE_NO_BROWSER: "true",
        },
        { injectDefaultStateDir: false },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) {
              delete process.env.HOME;
            } else {
              process.env.HOME = previousHome;
            }
          }),
        ),
      );

      assert.equal(start.mock.calls.length, 1);
      assert.equal(
        FS.existsSync(Path.join(home, ".f5", "userdata", LEGACY_STATE_MIGRATION_FAILURE_SENTINEL)),
        true,
      );
      FS.rmSync(home, { recursive: true, force: true });
    }),
  );

  it.effect("reads observability enablement from the environment", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_NO_BROWSER: "true",
        T3CODE_OBSERVABILITY_ENABLED: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.observabilityEnabled, true);
    }),
  );

  it.effect("prefers --mode over T3CODE_MODE", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(4666));
      yield* runCli(["--mode", "web"], {
        T3CODE_MODE: "desktop",
        T3CODE_NO_BROWSER: "true",
      });

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "web");
      assert.equal(resolvedConfig?.port, 4666);
      assert.equal(resolvedConfig?.host, undefined);
    }),
  );

  it.effect("prefers --no-browser over T3CODE_NO_BROWSER", () =>
    Effect.gen(function* () {
      yield* runCli(["--no-browser"], {
        T3CODE_NO_BROWSER: "false",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.noBrowser, true);
    }),
  );

  it.effect("uses dynamic port discovery in web mode when port is omitted", () =>
    Effect.gen(function* () {
      findAvailablePort.mockImplementation((_preferred: number) => Effect.succeed(5444));
      yield* runCli([]);

      assert.deepStrictEqual(findAvailablePort.mock.calls, [[3773]]);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 5444);
      assert.equal(resolvedConfig?.mode, "web");
    }),
  );

  it.effect("uses fixed localhost defaults in desktop mode", () =>
    Effect.gen(function* () {
      yield* runCli([], {
        T3CODE_MODE: "desktop",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(findAvailablePort.mock.calls.length, 0);
      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.port, 3773);
      assert.equal(resolvedConfig?.host, "127.0.0.1");
      assert.equal(resolvedConfig?.mode, "desktop");
    }),
  );

  it.effect("allows overriding desktop host with --host", () =>
    Effect.gen(function* () {
      yield* runCli(["--host", "0.0.0.0"], {
        T3CODE_MODE: "desktop",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.mode, "desktop");
      assert.equal(resolvedConfig?.host, "0.0.0.0");
    }),
  );

  it.effect("supports CLI and env for bootstrap/log websocket toggles", () =>
    Effect.gen(function* () {
      yield* runCli(["--auto-bootstrap-project-from-cwd"], {
        T3CODE_MODE: "desktop",
        T3CODE_LOG_WS_EVENTS: "false",
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_NO_BROWSER: "true",
      });

      assert.equal(start.mock.calls.length, 1);
      assert.equal(resolvedConfig?.autoBootstrapProjectFromCwd, true);
      assert.equal(resolvedConfig?.logWebSocketEvents, false);
    }),
  );

  it.effect("records a startup heartbeat with thread/project counts", () =>
    Effect.gen(function* () {
      const recordTelemetry = vi.fn(
        (_event: string, _properties?: Readonly<Record<string, unknown>>) => Effect.void,
      );
      const getSnapshot = vi.fn(() =>
        Effect.succeed({
          snapshotSequence: 2,
          projects: [{} as OrchestrationReadModel["projects"][number]],
          planningWorkflows: [],
          codeReviewWorkflows: [],
          threads: [
            {} as OrchestrationReadModel["threads"][number],
            {} as OrchestrationReadModel["threads"][number],
          ],
          updatedAt: new Date(1).toISOString(),
        } satisfies OrchestrationReadModel),
      );

      yield* recordStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot,
          getBootstrapSnapshot: getSnapshot,
          getStartupSnapshot: () =>
            getSnapshot().pipe(
              Effect.map((snapshot) => ({
                snapshot,
                threadTailDetails: null,
              })),
            ),
          getThreadTailDetails: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              activities: [],
              commandExecutions: [],
              tasks: [],
              tasksTurnId: null,
              tasksUpdatedAt: null,
              sessionNotes: null,
              threadReferences: [],
              hasOlderMessages: false,
              hasOlderCheckpoints: false,
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
              oldestLoadedCommandExecutionCursor: null,
              detailSequence: 2,
            }),
          getThreadHistoryPage: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              commandExecutions: [],
              hasOlderMessages: false,
              hasOlderCheckpoints: false,
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
              oldestLoadedCommandExecutionCursor: null,
              detailSequence: 2,
            }),
          getThreadDetails: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              tasks: [],
              tasksTurnId: null,
              tasksUpdatedAt: null,
              sessionNotes: null,
              threadReferences: [],
              detailSequence: 2,
            }),
        }),
        Effect.provideService(AnalyticsService, {
          record: recordTelemetry,
          flush: Effect.void,
        }),
      );

      assert.deepEqual(recordTelemetry.mock.calls[0], [
        "server.boot.heartbeat",
        {
          threadCount: 2,
          projectCount: 1,
        },
      ]);
    }),
  );

  it.effect("does not start server for invalid --mode values", () =>
    Effect.gen(function* () {
      yield* runCli(["--mode", "invalid"]);

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("does not start server for invalid --dev-url values", () =>
    Effect.gen(function* () {
      yield* runCli(["--dev-url", "not-a-url"]).pipe(Effect.catch(() => Effect.void));

      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );

  it.effect("does not start server for out-of-range --port values", () =>
    Effect.gen(function* () {
      yield* runCli(["--port", "70000"]);

      // effect/unstable/cli renders help/errors for parse failures and returns success.
      assert.equal(start.mock.calls.length, 0);
      assert.equal(stop.mock.calls.length, 0);
    }),
  );
});
