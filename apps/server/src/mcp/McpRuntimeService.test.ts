import { ServerSettingsService } from "../serverSettings.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import {
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type McpProjectServersConfig,
  type McpStatusUpdatedPayload,
  type ProviderSession,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";

import type { CodexControlClient } from "../codex/CodexControlClient.ts";
import { CodexControlClientRegistry } from "../codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "../codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "../codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "../codex/CodexOAuthManager.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { McpRuntimeDiagnostics } from "./McpRuntimeDiagnostics.ts";
import { McpRuntimeService, McpRuntimeServiceLive } from "./McpRuntimeService.ts";
import { McpHub, type McpHubShape } from "./hub/McpHub.ts";
import { makeFakeMcpHub } from "./hub/testing/fakeMcpHub.ts";
import { ProjectMcpConfigService } from "./ProjectMcpConfigService.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import type { ObservedMcpServer } from "../provider/mcpObservation.ts";

// The spawner is simulated, so command discovery must not depend on installed CLIs.
vi.mock("../spawn/resolveCommand.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../spawn/resolveCommand.ts")>()),
  resolveInvocationEffect: (file: string, args: ReadonlyArray<string>) =>
    Effect.succeed({ file, args: [...args], kind: "native" as const }),
}));

const encoder = new TextEncoder();
const projectId = ProjectId.makeUnsafe("mcp-runtime-service-test");

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    environment?: NodeJS.ProcessEnv,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options?: { env?: NodeJS.ProcessEnv };
      };
      return Effect.succeed(mockHandle(handler(cmd.args, cmd.options?.env)));
    }),
  );
}

function makeProviderServiceStub(): ProviderServiceShape {
  const unused = () => Effect.die(new Error("unused in McpRuntimeService tests"));

  return {
    startSession: (_threadId, _input) => unused(),
    replaceSession: () => unused(),
    sendTurn: (_input) => unused(),
    interruptTurn: (_input) => unused(),
    respondToRequest: (_input) => unused(),
    respondToUserInput: (_input) => unused(),
    respondToElicitation: (_input) => unused(),
    stopSession: (_input) => unused(),
    listStartingWorkspaces: () => Effect.succeed([]),
    listSessions: () => Effect.succeed([] satisfies ReadonlyArray<ProviderSession>),
    getSessionCapabilities: () => Effect.succeed(null),
    assertSessionAction: () => Effect.die(new Error("assertSessionAction is unused here")),
    getCapabilities: (_provider) => unused(),
    readThread: (_threadId) => unused(),
    rollbackConversation: (_input) => unused(),
    runOneOffPrompt: (_input) => unused(),
    compactConversation: (_input) => unused(),
    reloadMcpConfigForProject: (_input) => Effect.succeed({ sessions: [] }),
    streamEvents: Stream.empty,
  };
}

function makeProjectMcpConfigServiceLayer(
  servers: McpProjectServersConfig,
  effectiveVersion = "mcp-effective-v1",
  runtimeConfigReadDelayMs = 0,
) {
  return Layer.succeed(ProjectMcpConfigService, {
    readCommonStoredConfig: () => Effect.die(new Error("unused in McpRuntimeService tests")),
    readProjectStoredConfig: (_projectId: ProjectId) =>
      Effect.die(new Error("unused in McpRuntimeService tests")),
    readEffectiveStoredConfig: (requestedProjectId: ProjectId) =>
      Effect.succeed({
        projectId: requestedProjectId,
        effectiveVersion,
        servers,
      }),
    readEffectiveRuntimeConfig: (requestedProjectId: ProjectId) =>
      Effect.succeed({
        projectId: requestedProjectId,
        effectiveVersion,
        servers,
      }).pipe(runtimeConfigReadDelayMs > 0 ? Effect.delay(runtimeConfigReadDelayMs) : (e) => e),
    readCommonConfig: () => Effect.die(new Error("unused in McpRuntimeService tests")),
    replaceCommonConfig: (_input) => Effect.die(new Error("unused in McpRuntimeService tests")),
    readProjectConfig: (_projectId) => Effect.die(new Error("unused in McpRuntimeService tests")),
    replaceProjectConfig: (_input) => Effect.die(new Error("unused in McpRuntimeService tests")),
    readEffectiveConfig: (requestedProjectId: ProjectId) =>
      Effect.succeed({
        projectId: requestedProjectId,
        effectiveVersion,
        servers,
      }),
    readCodexServers: (requestedProjectId: ProjectId) =>
      Effect.succeed({
        projectId: requestedProjectId,
        effectiveVersion,
        servers: {},
      }),
  });
}

function liveSession(provider: "codex" | "claudeAgent", generation = 1, busy = false) {
  return {
    threadId: ThreadId.make(`${provider}-thread`),
    instanceId: ProviderInstanceId.make(provider),
    generation,
    lastSeenAt: "2026-10-19T10:00:00.000Z",
    busy,
    appliedVersion: "mcp-effective-v1",
  };
}

function codexLiveObservation(
  servers: ReadonlyArray<ObservedMcpServer>,
): Partial<ProviderServiceShape> {
  const selected = liveSession("codex");
  return {
    readMcpSessionStatuses: () =>
      Effect.succeed({
        sessions: [selected],
        selected,
        observation: {
          servers,
          complete: true,
          capabilities: { tools: true, inputSchemas: true, resources: true },
        },
      }),
  };
}

/** A running Claude session whose observed server status the test drives. */
function makeClaudeLoginProvider(options: {
  readonly authUrl?: string;
  readonly callbackExpected?: boolean;
  readonly ownership?: "managed" | "external";
  readonly authError?: string;
  readonly authHangs?: boolean;
}) {
  const state = {
    serverStatus: "needs-auth" as ObservedMcpServer["status"],
    serverError: undefined as string | undefined,
    generation: 1,
    // The session stays live unless a test ends it; reads can fail while it is live.
    sessionLive: true,
    busy: false,
    readFails: false,
    readDefect: false,
    authCalls: [] as Array<unknown>,
    reconnects: [] as Array<Record<string, unknown>>,
  };
  const providerService: Partial<ProviderServiceShape> = {
    authenticateMcpServerForProject: (input) => {
      state.authCalls.push(input);
      if (options.authHangs) return Effect.never;
      return options.authError
        ? Effect.fail(
            new ProviderAdapterRequestError({
              provider: "claudeAgent",
              method: "mcpAuthenticate",
              detail: options.authError,
            }),
          )
        : Effect.succeed({
            threadId: liveSession("claudeAgent").threadId,
            instanceId: ProviderInstanceId.make("claudeAgent"),
            generation: 1,
            ...(options.authUrl ? { authUrl: options.authUrl } : {}),
            callbackExpected: options.callbackExpected ?? options.authUrl !== undefined,
            ownership: options.ownership ?? "managed",
          });
    },
    getLiveMcpSession: () =>
      Effect.succeed(
        state.sessionLive ? liveSession("claudeAgent", state.generation, state.busy) : undefined,
      ),
    readMcpSessionStatuses: () => {
      if (state.readDefect) return Effect.die(new Error("status read defect"));
      if (state.readFails)
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "mcpServerStatus",
            detail: "The conversation is not running in this project and account.",
          }),
        );
      const selected = liveSession("claudeAgent", state.generation, state.busy);
      return Effect.succeed({
        sessions: [selected],
        selected,
        observation: {
          servers: [
            {
              name: "docs",
              status: state.serverStatus,
              ownership: options.ownership ?? "managed",
              ...(state.serverError ? { error: state.serverError } : {}),
            },
          ],
          complete: true,
          capabilities: { tools: true, inputSchemas: false, resources: false },
        },
      });
    },
    reconnectMcpServerForProject: (input) =>
      Effect.sync(() => {
        state.reconnects.push({
          threadIds: input.threadIds,
          excludeThreadIds: input.excludeThreadIds,
          allowExternal: input.allowExternal,
        });
        return {
          settingsConnectionReloaded: false,
          sessionsMatched: 1,
          sessionsReconnected: 1,
          failures: [],
        };
      }),
  };
  return { state, providerService };
}

function makeRuntimeLayer(input?: {
  readonly servers?: McpProjectServersConfig;
  /** F5's hub, which serves configured servers to Codex and Claude. */
  readonly mcpHub?: McpHubShape;
  readonly published?: Array<McpStatusUpdatedPayload>;
  readonly runtimeConfigReadDelayMs?: number;
  readonly providerService?: Partial<ProviderServiceShape>;
  readonly onControlClient?: () => void;
  readonly onControlReload?: () => void;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly oauthStartStatus?: {
    readonly status: "idle" | "pending" | "completed" | "failed";
    readonly authorizationUrl?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly message?: string;
    readonly error?: string;
  };
  readonly oauthStatus?: {
    readonly status: "idle" | "pending" | "completed" | "failed";
    readonly authorizationUrl?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly message?: string;
    readonly error?: string;
  };
  readonly oauthStartCalls?: Array<unknown>;
  readonly controlStatuses?: ReadonlyArray<{
    readonly name: string;
    readonly authStatus?: string;
    readonly startupStatus?: "starting" | "ready" | "failed" | "cancelled";
    readonly error?: string;
    readonly toolCount?: number;
  }>;
  readonly runtimeDiagnostics?: ReadonlyArray<{
    readonly name: string;
    readonly status: "starting" | "ready" | "failed" | "cancelled";
    readonly message?: string;
    readonly createdAt: string;
  }>;
}) {
  const oauthStartStatus = input?.oauthStartStatus ??
    input?.oauthStatus ?? { status: "idle" as const };
  const oauthStatus = input?.oauthStatus ?? { status: "idle" as const };
  const controlStatuses = input?.controlStatuses;
  return McpRuntimeServiceLive.pipe(
    Layer.provide(input?.mcpHub ? Layer.succeed(McpHub, input.mcpHub) : Layer.empty),
    Layer.provide(
      Layer.mergeAll(
        makeProjectMcpConfigServiceLayer(
          input?.servers ?? {},
          "mcp-effective-v1",
          input?.runtimeConfigReadDelayMs,
        ),
        Layer.succeed(CodexMcpSyncService, {
          getStatus: ({ projectId }) =>
            Effect.succeed({
              projectId,
              support: "supported" as const,
              configVersion: "mcp-effective-v1",
            }),
        }),
        Layer.succeed(CodexControlClientRegistry, {
          getAdminClient: (_input) => {
            input?.onControlClient?.();
            return controlStatuses
              ? Effect.succeed({
                  reloadMcpServer: async () => {
                    input?.onControlReload?.();
                  },
                  listMcpServerStatus: async () => ({
                    data: controlStatuses.map((status) => ({
                      name: status.name,
                      authStatus: status.authStatus,
                      ...(status.startupStatus ? { startupStatus: status.startupStatus } : {}),
                      ...(status.error ? { error: status.error } : {}),
                      tools: Object.fromEntries(
                        Array.from({ length: status.toolCount ?? 0 }, (_, index) => [
                          `tool-${index}`,
                          {},
                        ]),
                      ),
                      resources: [],
                      resourceTemplates: [],
                    })),
                    nextCursor: null,
                  }),
                } as unknown as CodexControlClient)
              : Effect.die(new Error("unused in McpRuntimeService tests"));
          },
          hasOauthLease: (_input) => Effect.succeed(false),
          acquireOauthClient: (_input) =>
            Effect.die(new Error("unused in McpRuntimeService tests")),
        }),
        Layer.succeed(CodexOAuthManager, {
          startLogin: (oauthInput) =>
            Effect.sync(() => {
              input?.oauthStartCalls?.push(oauthInput);
              return {
                projectId,
                serverName: oauthInput.serverName,
                ...oauthStartStatus,
              };
            }),
          getStatus: (_input) =>
            Effect.succeed({
              projectId,
              serverName: "oauth-server",
              ...oauthStatus,
            }),
        }),
        Layer.succeed(ProviderService, { ...makeProviderServiceStub(), ...input?.providerService }),
        Layer.succeed(CodexMcpEventBus, {
          publishStatusUpdated: (payload) =>
            Effect.sync(() => {
              input?.published?.push(payload);
            }),
          streamStatusUpdates: Stream.empty,
        }),
        Layer.succeed(McpRuntimeDiagnostics, {
          listLatestServerDiagnostics: () => Effect.succeed(input?.runtimeDiagnostics ?? []),
        }),
        NodeFileSystem.layer,
        NodePath.layer,
        input?.spawnerLayer ??
          mockSpawnerLayer((args) => {
            throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
          }),
      ),
    ),
  );
}

describe("McpRuntimeService", () => {
  for (const scenario of [
    { name: "unconfigured default", configured: false, expected: "t3-code" },
    { name: "default", expected: "t3-code" },
    { name: "instance override", instance: "instance", expected: "instance" },
    { name: "settings override", instance: "instance", settings: "settings", expected: "settings" },
  ]) {
    it.effect(`uses the ${scenario.name} entrypoint for Claude preflight commands`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "f5-mcp-claude-env-" });
        yield* fs.makeDirectory(path.join(root, ".claude"));
        yield* fs.writeFileString(
          path.join(root, ".claude", "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: scenario.settings } }),
        );
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const commands: string[] = [];
        const settingsLayer = ServerSettingsService.layerTest({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: root },
              environment:
                scenario.instance === undefined
                  ? []
                  : [{ name: "CLAUDE_CODE_ENTRYPOINT", value: scenario.instance }],
            },
          },
        });
        const runtimeLayer = makeRuntimeLayer({
          spawnerLayer: mockSpawnerLayer((args, environment) => {
            assert.equal(environment?.CLAUDE_CODE_ENTRYPOINT, scenario.expected);
            commands.push(args.join(" "));
            return {
              stdout: args[0] === "--version" ? "claude 1.2.3\n" : '{"loggedIn":true}\n',
              stderr: "",
              code: 0,
            };
          }),
        }).pipe(
          Layer.provide(scenario.configured === false ? Layer.empty : settingsLayer),
          Layer.provide(
            ServerConfig.layerTest(root, path.join(root, "state")).pipe(
              Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
            ),
          ),
        );
        const status = yield* McpRuntimeService.use((service) =>
          service.getProviderStatus({
            provider: "claudeAgent",
            projectId,
            instanceId,
            homePath: root,
          }),
        ).pipe(Effect.provide(runtimeLayer));
        assert.equal(status.authStatus, "authenticated");
        assert.deepEqual(commands, ["--version", "auth status"]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
    );
  }

  it.effect("reports Claude provider status as authenticated when preflight succeeds", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const status = yield* service.getProviderStatus({
        provider: "claudeAgent",
        projectId,
      });

      assert.strictEqual(status.provider, "claudeAgent");
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.authStatus, "authenticated");
      assert.strictEqual(status.support, "supported");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          spawnerLayer: mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "claude 1.2.3\n", stderr: "", code: 0 };
            }
            if (joined === "auth status") {
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            }
            throw new Error(`Unexpected CLI args: ${joined}`);
          }),
        }),
      ),
    ),
  );

  it.effect("reports Claude provider status as unauthenticated when auth status fails", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const status = yield* service.getProviderStatus({
        provider: "claudeAgent",
        projectId,
      });

      assert.strictEqual(status.available, true);
      assert.strictEqual(status.authStatus, "unauthenticated");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          spawnerLayer: mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "claude 1.2.3\n", stderr: "", code: 0 };
            }
            if (joined === "auth status") {
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            }
            throw new Error(`Unexpected CLI args: ${joined}`);
          }),
        }),
      ),
    ),
  );

  it.effect("keeps ambiguous provider names visible as conflicts without assigning readiness", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const result = yield* service.getServerStatuses({ provider: "codex", projectId });
      assert.equal(result.statuses[0]?.state, "unknown");
      assert.equal(result.statuses[0]?.toolCount, 0);
      assert.include(result.statuses[0]?.message, "GitHub, github");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: { GitHub: { type: "http", url: "http://localhost/mcp" } },
          controlStatuses: [
            { name: "GitHub", startupStatus: "ready", toolCount: 3 },
            { name: "github", startupStatus: "failed" },
          ],
          runtimeDiagnostics: [
            { name: "github", status: "ready", createdAt: new Date().toISOString() },
          ],
          spawnerLayer: mockSpawnerLayer((args) =>
            args.join(" ").endsWith("--version")
              ? { stdout: "codex 1.2.3\n", stderr: "", code: 0 }
              : { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 },
          ),
        }),
      ),
    ),
  );

  it.effect("uses Codex startup failures over authenticated MCP control status", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const statuses = yield* service.getServerStatuses({
        provider: "codex",
        projectId,
      });

      assert.strictEqual(statuses.statuses.length, 1);
      assert.strictEqual(statuses.statuses[0]?.name, "Observability");
      assert.strictEqual(statuses.statuses[0]?.state, "failed");
      assert.strictEqual(statuses.statuses[0]?.authStatus, "authenticated");
      assert.strictEqual(statuses.statuses[0]?.message, "Token refresh failed");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          // Codex's own server: the admin client reports only those.
          servers: {},
          controlStatuses: [
            {
              name: "Observability",
              authStatus: "oAuth",
              startupStatus: "failed",
              error: "Token refresh failed",
            },
          ],
          spawnerLayer: mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined.endsWith("--version")) {
              return { stdout: "codex 1.2.3\n", stderr: "", code: 0 };
            }
            if (joined.endsWith("login status")) {
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            }
            throw new Error(`Unexpected CLI args: ${joined}`);
          }),
        }),
      ),
    ),
  );

  it.effect("does not mark authenticated zero-capability Codex MCP status as ready", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const statuses = yield* service.getServerStatuses({
        provider: "codex",
        projectId,
      });

      assert.strictEqual(statuses.statuses.length, 1);
      assert.strictEqual(statuses.statuses[0]?.name, "Observability");
      assert.strictEqual(statuses.statuses[0]?.state, "unknown");
      assert.match(statuses.statuses[0]?.message ?? "", /zero reported tools/u);
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          // Codex's own server: the admin client reports only those.
          servers: {},
          controlStatuses: [
            {
              name: "Observability",
              authStatus: "oAuth",
            },
          ],
          spawnerLayer: mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined.endsWith("--version")) {
              return { stdout: "codex 1.2.3\n", stderr: "", code: 0 };
            }
            if (joined.endsWith("login status")) {
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            }
            throw new Error(`Unexpected CLI args: ${joined}`);
          }),
        }),
      ),
    ),
  );

  it.effect("does not use historical runtime failures as authoritative configuration status", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const statuses = yield* service.getServerStatuses({
        provider: "codex",
        projectId,
      });

      assert.strictEqual(statuses.statuses.length, 1);
      assert.strictEqual(statuses.statuses[0]?.name, "Observability");
      assert.strictEqual(statuses.statuses[0]?.state, "unknown");
      assert.notInclude(statuses.statuses[0]?.message, "OAuth token refresh failed");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          // Codex's own server: the admin client reports only those.
          servers: {},
          controlStatuses: [
            {
              name: "Observability",
              authStatus: "oAuth",
            },
          ],
          runtimeDiagnostics: [
            {
              name: "Observability",
              status: "failed",
              message: "OAuth token refresh failed: Failed to parse server response",
              createdAt: "2026-05-18T20:05:24.138Z",
            },
          ],
          spawnerLayer: mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined.endsWith("--version")) {
              return { stdout: "codex 1.2.3\n", stderr: "", code: 0 };
            }
            if (joined.endsWith("login status")) {
              return { stdout: '{"loggedIn":true}\n', stderr: "", code: 0 };
            }
            throw new Error(`Unexpected CLI args: ${joined}`);
          }),
        }),
      ),
    ),
  );

  it.effect("directs Claude account login to the profile account panel", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const error = yield* Effect.flip(
        service.startLogin({
          provider: "claudeAgent",
          projectId,
        }),
      );

      assert.ok(error.message.includes("Settings > Profiles"));
    }).pipe(Effect.provide(makeRuntimeLayer())),
  );

  it.effect(
    "fails codex login when the server is neither configured nor observed as external",
    () =>
      Effect.gen(function* () {
        const service = yield* McpRuntimeService;
        for (const serverName of ["missing-server", "f5-built-in"]) {
          const error = yield* Effect.flip(
            service.startLogin({ provider: "codex", projectId, serverName }),
          );
          assert.include(error.message, serverName);
          assert.include(error.message, "not configured for this Codex account");
        }
      }).pipe(
        Effect.provide(
          makeRuntimeLayer({
            servers: { otherServer: { type: "stdio", command: "npx" } },
            providerService: codexLiveObservation([
              { name: "f5-built-in", status: "needs-auth", ownership: "built-in" },
            ]),
          }),
        ),
      ),
  );

  it.effect("signs in external Codex servers through the app-server OAuth manager", () => {
    const oauthStartCalls: Array<unknown> = [];
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const started = yield* service.startLogin({
        provider: "codex",
        projectId,
        serverName: "linear",
        threadId: ThreadId.make("codex-thread"),
      });
      assert.deepEqual(
        { mode: started.mode, status: started.status, url: started.authorizationUrl },
        { mode: "oauth", status: "pending", url: "https://auth.example.test/authorize" },
      );
      assert.deepEqual(oauthStartCalls, [{ projectId, serverName: "linear" }]);
      const status = yield* service.getLoginStatus({
        provider: "codex",
        projectId,
        serverName: "linear",
      });
      assert.equal(status.mode, "oauth");
      assert.equal(status.status, "pending");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: { otherServer: { type: "stdio", command: "npx" } },
          oauthStartCalls,
          oauthStatus: {
            status: "pending",
            authorizationUrl: "https://auth.example.test/authorize",
          },
          providerService: codexLiveObservation([
            { name: "linear", status: "needs-auth", ownership: "external" },
          ]),
        }),
      ),
    );
  });

  it.effect("maps OAuth-backed codex login status into the provider-aware response", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const status = yield* service.getLoginStatus({
        provider: "codex",
        projectId,
        serverName: "oauth-server",
      });

      assert.strictEqual(status.mode, "oauth");
      assert.strictEqual(status.status, "completed");
      assert.strictEqual(status.message, "OAuth finished");
      assert.strictEqual(status.authorizationUrl, "https://auth.example.test");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          // One of Codex's own servers; F5's sign in through the hub.
          servers: {},
          oauthStatus: {
            status: "completed",
            authorizationUrl: "https://auth.example.test",
            startedAt: "2026-04-29T10:00:00.000Z",
            completedAt: "2026-04-29T10:00:10.000Z",
            message: "OAuth finished",
          },
        }),
      ),
    ),
  );
});

it.effect(
  "reads only the selected conversation without creating a control client or running preflight",
  () => {
    let controlCalls = 0;
    const threadId = ThreadId.make("live-conversation");
    const selected = {
      threadId,
      instanceId: ProviderInstanceId.make("codex"),
      generation: 3,
      lastSeenAt: "2026-10-18T10:00:00.000Z",
      busy: true,
      appliedVersion: "older",
    };
    return Effect.gen(function* () {
      const runtime = yield* McpRuntimeService;
      const result = yield* runtime.getServerStatuses({ provider: "codex", projectId, threadId });
      assert.equal(result.source, "conversation");
      assert.equal(result.threadId, threadId);
      assert.equal(result.generation, 3);
      assert.equal(result.appliedVersion, "older");
      assert.equal(result.desiredVersion, "mcp-effective-v1");
      assert.equal(result.statuses[0]?.state, "ready");
      assert.equal(controlCalls, 0);
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: { docs: { type: "stdio", command: "node" } },
          onControlClient: () => controlCalls++,
          providerService: {
            readMcpSessionStatuses: (input) => {
              assert.equal(input.threadId, threadId);
              return Effect.succeed({
                sessions: [selected],
                selected,
                observation: {
                  servers: [
                    { name: "docs", status: "connected", ownership: "managed", toolCount: 2 },
                  ],
                  complete: true,
                  capabilities: { tools: true, inputSchemas: true, resources: true },
                },
              });
            },
          },
        }),
      ),
    );
  },
);
it.effect("shows configured Claude servers without launching a query or running preflight", () =>
  Effect.gen(function* () {
    const runtime = yield* McpRuntimeService;
    const result = yield* runtime.getServerStatuses({ provider: "claudeAgent", projectId });
    assert.equal(result.source, "configurationCheck");
    assert.equal(result.statuses[0]?.state, "unknown");
    assert.include(result.statuses[0]?.message, "Live status appears while a Claude session");
  }).pipe(
    Effect.provide(makeRuntimeLayer({ servers: { docs: { type: "stdio", command: "node" } } })),
  ),
);
it.effect("reloads the Codex settings connection even without live sessions", () => {
  let reloads = 0;
  return Effect.gen(function* () {
    const runtime = yield* McpRuntimeService;
    const result = yield* runtime.reconnectServer({
      provider: "codex",
      projectId,
      serverName: "docs",
    });
    assert.equal(reloads, 1);
    assert.deepEqual(result, {
      settingsConnectionReloaded: true,
      sessionsMatched: 0,
      sessionsReconnected: 0,
      failures: [],
    });
  }).pipe(
    Effect.provide(makeRuntimeLayer({ controlStatuses: [], onControlReload: () => reloads++ })),
  );
});

describe("with the hub serving Codex and Claude", () => {
  const servers = { docs: { type: "http" as const, url: "https://docs.example/mcp" } };

  it.effect("reconnects a saved server through the hub, not Codex's app-server", () => {
    const reconnects: Array<[string, unknown]> = [];
    const fake = makeFakeMcpHub();
    const mcpHub: McpHubShape = {
      ...fake.hub,
      reconnect: async (serverName, scope) => {
        reconnects.push([serverName, scope]);
        return 2;
      },
    };
    let controlClients = 0;
    return Effect.gen(function* () {
      const runtime = yield* McpRuntimeService;
      const result = yield* runtime.reconnectServer({
        provider: "codex",
        projectId,
        serverName: "docs",
      });
      assert.deepEqual(result, {
        settingsConnectionReloaded: false,
        sessionsMatched: 2,
        sessionsReconnected: 2,
        failures: [],
      });
      assert.deepEqual(reconnects, [["docs", projectId]]);
      assert.equal(controlClients, 0);
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({ servers, mcpHub, onControlClient: () => controlClients++ }),
      ),
    );
  });

  it.effect("sends provider sign-in for saved servers to F5's sign-in", () => {
    const oauthStartCalls: unknown[] = [];
    return Effect.gen(function* () {
      const runtime = yield* McpRuntimeService;
      for (const provider of ["codex", "claudeAgent"] as const) {
        // Any spelling of a saved name, enabled or not.
        for (const serverName of ["docs", "DOCS"]) {
          const refused = yield* runtime
            .startLogin({ provider, projectId, serverName })
            .pipe(Effect.flip);
          assert.include(refused.message, "through F5. Sign in from the server's Sign-in tab");
        }
      }
      assert.equal(oauthStartCalls.length, 0);
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers,
          oauthStartCalls,
          providerService: {
            authenticateMcpServerForProject: () =>
              Effect.die(new Error("F5's servers never sign in through Claude")),
          },
        }),
      ),
    );
  });
});

it.effect("keeps external same-name tool metadata out of the managed inspector", () => {
  const threadId = ThreadId.make("same-name-thread");
  const selected = {
    threadId,
    instanceId: ProviderInstanceId.make("claudeAgent"),
    generation: 1,
    lastSeenAt: "2026-10-18T10:00:00.000Z",
    busy: false,
    appliedVersion: "saved",
  };
  return Effect.gen(function* () {
    const runtime = yield* McpRuntimeService;
    const managed = yield* runtime.inspectServer({
      projectId,
      provider: "claudeAgent",
      threadId,
      serverName: "docs",
    });
    assert.equal(managed.tools.length, 0);
    const external = yield* runtime.inspectServer({
      projectId,
      provider: "claudeAgent",
      threadId,
      serverName: "docs",
      ownership: "external",
    });
    assert.equal(external.tools[0]?.name, "plugin_tool");
  }).pipe(
    Effect.provide(
      makeRuntimeLayer({
        servers: { docs: { type: "stdio", command: "node" } },
        providerService: {
          readMcpSessionStatuses: () =>
            Effect.succeed({
              sessions: [selected],
              selected,
              observation: {
                servers: [
                  {
                    name: "docs",
                    status: "connected",
                    ownership: "external",
                    origin: "plugin",
                    tools: [{ name: "plugin_tool" }],
                  },
                ],
                complete: true,
                capabilities: { tools: true, inputSchemas: false, resources: false },
              },
            }),
        },
      }),
    ),
  );
});

it.effect(
  "scrubs account bearer environment values from observation errors and reconnect results",
  () => {
    vi.stubEnv("F5_MCP_REVIEW_BEARER", "account-bearer-review-value");
    return Effect.gen(function* () {
      const runtime = yield* McpRuntimeService;
      const input = { projectId, provider: "claudeAgent" as const };
      const error = yield* runtime.getServerStatuses(input).pipe(Effect.flip);
      assert.notInclude(error.message, "account-bearer-review-value");
      assert.include(error.message, "[redacted]");
      // One of Claude's own servers: its reconnect goes through the provider.
      const result = yield* runtime.reconnectServer({ ...input, serverName: "claude-own" });
      assert.notInclude(JSON.stringify(result), "account-bearer-review-value");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: {
            docs: {
              type: "http",
              url: "https://example.test",
              bearerTokenEnvVar: "F5_MCP_REVIEW_BEARER",
            },
          },
          providerService: {
            readMcpSessionStatuses: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "claudeAgent",
                  method: "mcpServerStatus",
                  detail: "failed using account-bearer-review-value",
                }),
              ),
            reconnectMcpServerForProject: () =>
              Effect.succeed({
                settingsConnectionReloaded: false,
                sessionsMatched: 1,
                sessionsReconnected: 0,
                failures: [{ message: "failed using account-bearer-review-value" }],
              }),
          },
        }),
      ),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  },
);

describe("Claude MCP sign-in", () => {
  const claudeLogin = { provider: "claudeAgent" as const, projectId, serverName: "docs" };
  const sourceThreadId = liveSession("claudeAgent").threadId;
  // `docs` is one of Claude's own servers (a connector or plugin server), not F5's.
  const runtimeFor = (providerService: Partial<ProviderServiceShape>) =>
    makeRuntimeLayer({ servers: {}, providerService });

  it.effect("completes once the source session connects and reconnects the other sessions", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize?state=s",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const pending = yield* service.startLogin({ ...claudeLogin, threadId: sourceThreadId });
      assert.deepEqual(
        { mode: pending.mode, status: pending.status, url: pending.authorizationUrl },
        { mode: "oauth", status: "pending", url: "https://auth.example.test/authorize?state=s" },
      );
      assert.equal((yield* service.startLogin(claudeLogin)).status, "pending");
      assert.equal(state.authCalls.length, 1);
      assert.deepEqual(state.authCalls[0], {
        provider: "claudeAgent",
        projectId,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        serverName: "docs",
        threadId: sourceThreadId,
        desiredVersion: "mcp-effective-v1",
      });

      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "pending");
      assert.deepEqual(state.reconnects, []);

      state.serverStatus = "connected";
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "completed");
      assert.deepEqual(state.reconnects, [
        { threadIds: undefined, excludeThreadIds: [sourceThreadId], allowExternal: undefined },
      ]);
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("propagates a failed connection after sign-in", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      yield* service.startLogin(claudeLogin);
      state.serverStatus = "failed";
      state.serverError = "token exchange rejected";
      yield* TestClock.adjust("2 seconds");
      const status = yield* service.getLoginStatus(claudeLogin);
      assert.equal(status.status, "failed");
      assert.equal(status.error, "token exchange rejected");
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("times out after five minutes without a connection, and announces it", () => {
    const { providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize",
    });
    const published: Array<McpStatusUpdatedPayload> = [];
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      yield* service.startLogin(claudeLogin);
      yield* TestClock.adjust("4 minutes");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "pending");
      assert.deepEqual(published, []);
      yield* TestClock.adjust("2 minutes");
      const status = yield* service.getLoginStatus(claudeLogin);
      assert.equal(status.status, "failed");
      assert.equal(status.error, "Sign-in timed out. Try again.");
      // Settings do not poll sign-in, so the failure is pushed.
      yield* Effect.yieldNow;
      assert.deepEqual(
        published.map((event) => [event.reason, event.provider]),
        [["login-completed", "claudeAgent"]],
      );
    }).pipe(Effect.provide(makeRuntimeLayer({ servers: {}, providerService, published })));
  });

  for (const ending of ["stopped", "replaced"] as const) {
    it.effect(`fails when the conversation is ${ending} mid-flow`, () => {
      const { state, providerService } = makeClaudeLoginProvider({
        authUrl: "https://auth.example.test/authorize",
      });
      return Effect.gen(function* () {
        const service = yield* McpRuntimeService;
        yield* service.startLogin(claudeLogin);
        if (ending === "stopped") {
          state.readFails = true;
          state.sessionLive = false;
        } else state.generation = 2;
        yield* TestClock.adjust("2 seconds");
        const status = yield* service.getLoginStatus(claudeLogin);
        assert.equal(status.status, "failed");
        assert.equal(status.error, "The conversation ended before sign-in completed.");
      }).pipe(Effect.provide(runtimeFor(providerService)));
    });
  }

  it.effect("keeps waiting through status-read failures while the conversation is live", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      yield* service.startLogin(claudeLogin);
      // e.g. read timeouts, superseded observations, or a newly applied config version.
      state.readFails = true;
      yield* TestClock.adjust("20 seconds");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "pending");
      state.readFails = false;
      state.serverStatus = "connected";
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "completed");
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("retries claude.ai connectors with backoff and never while a turn runs", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://claude.ai/connect",
      callbackExpected: false,
      ownership: "external",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const sourceRetry = {
        threadIds: [sourceThreadId],
        excludeThreadIds: undefined,
        allowExternal: true,
      };
      yield* service.startLogin(claudeLogin);
      yield* TestClock.adjust("4 seconds");
      assert.deepEqual(state.reconnects, []);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(state.reconnects, [sourceRetry]);
      // The next retry is due 10s later, but not while the conversation is busy.
      state.busy = true;
      yield* TestClock.adjust("10 seconds");
      assert.equal(state.reconnects.length, 1);
      state.busy = false;
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(state.reconnects, [sourceRetry, sourceRetry]);
      // Backoff doubled to 20s.
      yield* TestClock.adjust("10 seconds");
      assert.equal(state.reconnects.length, 2);
      state.serverStatus = "connected";
      yield* TestClock.adjust("2 seconds");
      assert.equal((yield* service.getLoginStatus(claudeLogin)).status, "completed");
      assert.deepEqual(state.reconnects.slice(2), [
        { threadIds: undefined, excludeThreadIds: [sourceThreadId], allowExternal: true },
      ]);
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("shares one sign-in between concurrent starts while config loads", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const both = yield* Effect.all(
        [service.startLogin(claudeLogin), service.startLogin(claudeLogin)],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(both);
      assert.deepEqual(
        results.map((result) => result.status),
        ["pending", "pending"],
      );
      assert.equal(state.authCalls.length, 1);
      assert.equal(
        (yield* service.getLoginStatus(claudeLogin)).authorizationUrl,
        "https://auth.example.test/authorize",
      );
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({ servers: {}, providerService, runtimeConfigReadDelayMs: 1_000 }),
      ),
    );
  });

  it.effect("fails an interrupted start so a new sign-in can begin", () => {
    const { state, providerService } = makeClaudeLoginProvider({ authHangs: true });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const start = yield* service.startLogin(claudeLogin).pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      assert.equal(state.authCalls.length, 1);
      yield* Fiber.interrupt(start);
      const status = yield* service.getLoginStatus(claudeLogin);
      assert.equal(status.status, "failed");
      assert.equal(status.error, "Sign-in was interrupted. Try again.");
      const retry = yield* service.startLogin(claudeLogin).pipe(Effect.forkChild);
      yield* TestClock.adjust(1);
      assert.equal(state.authCalls.length, 2);
      yield* Fiber.interrupt(retry);
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("fails the attempt when the watcher dies unexpectedly", () => {
    const { state, providerService } = makeClaudeLoginProvider({
      authUrl: "https://auth.example.test/authorize",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      yield* service.startLogin(claudeLogin);
      state.readDefect = true;
      yield* TestClock.adjust("2 seconds");
      const status = yield* service.getLoginStatus(claudeLogin);
      assert.equal(status.status, "failed");
      assert.equal(status.error, "Sign-in stopped unexpectedly. Try again.");
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("completes immediately and reconnects every session when no sign-in is needed", () => {
    const { state, providerService } = makeClaudeLoginProvider({});
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const status = yield* service.startLogin(claudeLogin);
      assert.equal(status.status, "completed");
      assert.equal(status.authorizationUrl, undefined);
      yield* TestClock.adjust(1);
      assert.deepEqual(state.reconnects, [
        { threadIds: undefined, excludeThreadIds: undefined, allowExternal: undefined },
      ]);
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("reports a failed start when no conversation is running", () => {
    const { providerService } = makeClaudeLoginProvider({
      authError: "Start a conversation in this project to sign in to MCP servers.",
    });
    return Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const error = yield* service.startLogin(claudeLogin).pipe(Effect.flip);
      assert.include(error.message, "Start a conversation in this project");
      const status = yield* service.getLoginStatus(claudeLogin);
      assert.equal(status.status, "failed");
      assert.include(status.error, "Start a conversation in this project");
    }).pipe(Effect.provide(runtimeFor(providerService)));
  });

  it.effect("keeps provider-scoped Claude login rejected and reports idle server status", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const error = yield* service
        .startLogin({ provider: "claudeAgent", projectId })
        .pipe(Effect.flip);
      assert.include(error.message, "Settings > Profiles");
      const idle = yield* service.getLoginStatus(claudeLogin);
      assert.deepEqual({ mode: idle.mode, status: idle.status }, { mode: "oauth", status: "idle" });
    }).pipe(Effect.provide(runtimeFor({}))),
  );
});
