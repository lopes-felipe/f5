import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProjectId, type McpProjectServersConfig, type ProviderSession } from "@t3tools/contracts";

import type { CodexControlClient } from "../codex/CodexControlClient.ts";
import { CodexControlClientRegistry } from "../codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "../codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "../codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "../codex/CodexOAuthManager.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { McpRuntimeService, McpRuntimeServiceLive } from "./McpRuntimeService.ts";
import { ProjectMcpConfigService } from "./ProjectMcpConfigService.ts";

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
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function hangingSpawnerLayer() {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

function makeProviderServiceStub(): ProviderServiceShape {
  const unused = () => Effect.die(new Error("unused in McpRuntimeService tests"));

  return {
    startSession: (_threadId, _input) => unused(),
    sendTurn: (_input) => unused(),
    interruptTurn: (_input) => unused(),
    respondToRequest: (_input) => unused(),
    respondToUserInput: (_input) => unused(),
    stopSession: (_input) => unused(),
    listSessions: () => Effect.succeed([] satisfies ReadonlyArray<ProviderSession>),
    getCapabilities: (_provider) => unused(),
    readThread: (_threadId) => unused(),
    rollbackConversation: (_input) => unused(),
    runOneOffPrompt: (_input) => unused(),
    compactConversation: (_input) => unused(),
    reloadMcpConfigForProject: (_input) => Effect.void,
    streamEvents: Stream.empty,
  };
}

function makeProjectMcpConfigServiceLayer(
  servers: McpProjectServersConfig,
  effectiveVersion = "mcp-effective-v1",
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

function makeRuntimeLayer(input?: {
  readonly servers?: McpProjectServersConfig;
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
  }>;
}) {
  const oauthStartStatus = input?.oauthStartStatus ??
    input?.oauthStatus ?? { status: "idle" as const };
  const oauthStatus = input?.oauthStatus ?? { status: "idle" as const };
  const controlStatuses = input?.controlStatuses;
  return McpRuntimeServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeProjectMcpConfigServiceLayer(input?.servers ?? {}),
        Layer.succeed(CodexMcpSyncService, {
          getStatus: ({ projectId }) =>
            Effect.succeed({
              projectId,
              support: "supported" as const,
              configVersion: "mcp-effective-v1",
            }),
        }),
        Layer.succeed(CodexControlClientRegistry, {
          getAdminClient: (_input) =>
            controlStatuses
              ? Effect.succeed({
                  listMcpServerStatus: async () => ({
                    data: controlStatuses.map((status) => ({
                      name: status.name,
                      authStatus: status.authStatus,
                      tools: {},
                      resources: [],
                      resourceTemplates: [],
                    })),
                    nextCursor: null,
                  }),
                } as unknown as CodexControlClient)
              : Effect.die(new Error("unused in McpRuntimeService tests")),
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
        Layer.succeed(ProviderService, makeProviderServiceStub()),
        Layer.succeed(CodexMcpEventBus, {
          publishStatusUpdated: () => Effect.void,
          streamStatusUpdates: Stream.empty,
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

  it.effect("matches Codex MCP server statuses case-insensitively", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const statuses = yield* service.getServerStatuses({
        provider: "codex",
        projectId,
      });

      assert.strictEqual(statuses.statuses.length, 1);
      assert.strictEqual(statuses.statuses[0]?.name, "Glean");
      assert.strictEqual(statuses.statuses[0]?.state, "ready");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: {
            Glean: {
              type: "http",
              url: "https://example.test/mcp",
            },
          },
          controlStatuses: [
            {
              name: "glean",
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

  it.effect("rejects integrated Claude login with instructions to use a real terminal", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const error = yield* Effect.flip(
        service.startLogin({
          provider: "claudeAgent",
          projectId,
        }),
      );

      assert.ok(error.message.includes("claude auth login"));
    }).pipe(Effect.provide(makeRuntimeLayer())),
  );

  it.effect("fails codex login when the server name is not defined in the shared config", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;
      const error = yield* Effect.flip(
        service.startLogin({
          provider: "codex",
          projectId,
          serverName: "missing-server",
        }),
      );

      assert.ok(error.message.includes("missing-server"));
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: {
            otherServer: {
              type: "stdio",
              command: "npx",
            },
          },
        }),
      ),
    ),
  );

  it.effect("marks codex CLI login as failed after the timeout elapses", () =>
    Effect.gen(function* () {
      const service = yield* McpRuntimeService;

      const pending = yield* service.startLogin({
        provider: "codex",
        projectId,
        serverName: "cli-server",
      });
      assert.strictEqual(pending.status, "pending");

      yield* TestClock.adjust("6 minutes");

      const status = yield* service.getLoginStatus({
        provider: "codex",
        projectId,
        serverName: "cli-server",
      });
      assert.strictEqual(status.status, "failed");
      assert.strictEqual(status.error, "Codex MCP login timed out before completion.");
    }).pipe(
      Effect.provide(
        makeRuntimeLayer({
          servers: {
            "cli-server": {
              type: "stdio",
              command: "npx",
            },
          },
          spawnerLayer: hangingSpawnerLayer(),
        }),
      ),
    ),
  );

  it.effect(
    "routes HTTP codex login through OAuth even without oauthResource in the shared config",
    () => {
      const oauthStartCalls: Array<unknown> = [];
      return Effect.gen(function* () {
        const service = yield* McpRuntimeService;

        const pending = yield* service.startLogin({
          provider: "codex",
          projectId,
          serverName: "Glean",
        });
        assert.strictEqual(pending.mode, "oauth");
        assert.strictEqual(pending.status, "pending");
        assert.strictEqual(pending.authorizationUrl, "https://auth.example.test");
        assert.strictEqual(oauthStartCalls.length, 1);

        const status = yield* service.getLoginStatus({
          provider: "codex",
          projectId,
          serverName: "Glean",
        });
        assert.strictEqual(status.mode, "oauth");
        assert.strictEqual(status.status, "completed");
        assert.strictEqual(status.message, "OAuth finished");
      }).pipe(
        Effect.provide(
          makeRuntimeLayer({
            servers: {
              Glean: {
                type: "http",
                url: "https://example.test/mcp",
              },
            },
            oauthStartStatus: {
              status: "pending",
              authorizationUrl: "https://auth.example.test",
              startedAt: "2026-04-29T10:00:00.000Z",
            },
            oauthStatus: {
              status: "completed",
              authorizationUrl: "https://auth.example.test",
              startedAt: "2026-04-29T10:00:00.000Z",
              completedAt: "2026-04-29T10:00:10.000Z",
              message: "OAuth finished",
            },
            oauthStartCalls,
          }),
        ),
      );
    },
  );

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
          servers: {
            "oauth-server": {
              type: "http",
              url: "https://example.test/mcp",
              oauthResource: "https://example.test/oauth",
            },
          },
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
