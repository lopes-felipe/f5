import { EventEmitter } from "node:events";

import {
  ProjectId,
  type McpOauthLoginStatusRequest,
  type ProviderSession,
} from "@t3tools/contracts";
import { CODEX_MCP_OAUTH_LOGIN_TIMEOUT_SEC } from "@t3tools/shared/codexOAuthTiming";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { CodexControlClient } from "./CodexControlClient.ts";
import {
  CodexControlClientRegistry,
  CodexControlClientRegistryError,
} from "./CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "./CodexMcpSyncService.ts";
import { CodexOAuthManager, CodexOAuthManagerLive } from "./CodexOAuthManager.ts";

const request: McpOauthLoginStatusRequest = {
  projectId: ProjectId.makeUnsafe("project-oauth"),
  serverName: "filesystem",
  binaryPath: "/tmp/codex",
  homePath: "/tmp/codex-home",
};

interface FakeOauthStatus {
  readonly name: string;
  readonly authStatus?: string;
  readonly startupStatus?: "starting" | "ready" | "failed" | "cancelled";
  readonly error?: string;
  readonly tools?: Record<string, unknown>;
  readonly resources?: ReadonlyArray<unknown>;
  readonly resourceTemplates?: ReadonlyArray<unknown>;
}

class FakeOauthClient extends EventEmitter {
  statuses: ReadonlyArray<FakeOauthStatus> = [
    {
      name: request.serverName,
      authStatus: "notLoggedIn",
    },
  ];
  readonly close = vi.fn();
  readonly startOAuthLogin = vi.fn(async () => ({
    authorizationUrl: "https://auth.example.test/login",
  }));
  readonly listMcpServerStatus = vi.fn(async () => ({
    data: this.statuses.map((status) => ({
      name: status.name,
      authStatus: status.authStatus,
      ...(status.startupStatus ? { startupStatus: status.startupStatus } : {}),
      ...(status.error ? { error: status.error } : {}),
      tools: status.tools ?? {},
      resources: status.resources ?? [],
      resourceTemplates: status.resourceTemplates ?? [],
    })),
    nextCursor: null,
  }));
}

function makeProviderServiceStub(input?: {
  readonly reloadMcpConfigForProject?: ProviderServiceShape["reloadMcpConfigForProject"];
}): ProviderServiceShape {
  const unused = () => Effect.die(new Error("unused in CodexOAuthManager tests"));

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
    reloadMcpConfigForProject: input?.reloadMcpConfigForProject ?? ((_input) => Effect.void),
    streamEvents: Stream.empty,
  };
}

const makeProjectMcpConfigServiceStub = () =>
  Layer.succeed(ProjectMcpConfigService, {
    readCommonStoredConfig: () => Effect.die(new Error("unused in CodexOAuthManager tests")),
    readProjectStoredConfig: (_projectId: ProjectId) =>
      Effect.die(new Error("unused in CodexOAuthManager tests")),
    readEffectiveStoredConfig: (_projectId: ProjectId) =>
      Effect.die(new Error("unused in CodexOAuthManager tests")),
    readCommonConfig: () => Effect.die(new Error("unused in CodexOAuthManager tests")),
    replaceCommonConfig: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
    readProjectConfig: (_projectId) => Effect.die(new Error("unused in CodexOAuthManager tests")),
    replaceProjectConfig: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
    readEffectiveConfig: (_projectId: ProjectId) =>
      Effect.die(new Error("unused in CodexOAuthManager tests")),
    readCodexServers: (projectId) =>
      Effect.succeed({
        projectId,
        effectiveVersion: "mcp-version-1",
        servers: {},
      }),
  });

async function withManagerRuntime(
  layer: Layer.Layer<CodexOAuthManager, never, never>,
  run: (runtime: ManagedRuntime.ManagedRuntime<CodexOAuthManager, never>) => Promise<void>,
) {
  const runtime = ManagedRuntime.make(layer);
  try {
    await run(runtime);
  } finally {
    await runtime.dispose();
  }
}

describe("CodexOAuthManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a failed status when OAuth client acquisition fails", async () => {
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexMcpSyncService, {
        getStatus: ({ projectId }) =>
          Effect.succeed({
            projectId,
            support: "supported" as const,
          }),
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(false),
        acquireOauthClient: (_input) =>
          Effect.fail(
            new CodexControlClientRegistryError({
              message: "boom",
            }),
          ),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      await expect(
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* CodexOAuthManager;
            return yield* manager.startLogin(request);
          }),
        ),
      ).rejects.toThrow("boom");

      const status = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.getStatus(request);
        }),
      );

      expect(status.status).toBe("failed");
      expect(status.error).toBe("boom");
    });
  });

  it("keeps setup pending while the OAuth control client is still starting", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;
    let resolveLease:
      | ((value: {
          readonly client: CodexControlClient;
          readonly release: Effect.Effect<void>;
        }) => void)
      | undefined;
    let resolveAcquireStarted: (() => void) | undefined;
    const leasePromise = new Promise<{
      readonly client: CodexControlClient;
      readonly release: Effect.Effect<void>;
    }>((resolve) => {
      resolveLease = resolve;
    });
    const acquireStarted = new Promise<void>((resolve) => {
      resolveAcquireStarted = resolve;
    });

    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.promise(async () => {
            resolveAcquireStarted?.();
            return await leasePromise;
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      const startLoginPromise = runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );

      await acquireStarted;

      const statusDuringSetup = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.getStatus(request);
        }),
      );

      expect(statusDuringSetup.status).toBe("pending");
      expect(client.startOAuthLogin).not.toHaveBeenCalled();

      leaseActive = true;
      resolveLease?.({
        client: client as unknown as CodexControlClient,
        release: Effect.sync(() => {
          leaseActive = false;
        }),
      });

      const pending = await startLoginPromise;
      expect(pending.status).toBe("pending");
      expect(client.startOAuthLogin).toHaveBeenCalledTimes(1);
    });
  });

  it("expires stale pending status once the OAuth lease is gone", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;

    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexMcpSyncService, {
        getStatus: ({ projectId }) =>
          Effect.succeed({
            projectId,
            support: "supported" as const,
          }),
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.sync(() => {
            leaseActive = true;
            return {
              client: client as unknown as CodexControlClient,
              release: Effect.sync(() => {
                leaseActive = false;
              }),
            };
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      const pending = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );
      expect(pending.status).toBe("pending");
      expect(client.startOAuthLogin).toHaveBeenCalledWith({
        name: request.serverName,
        timeoutSecs: CODEX_MCP_OAUTH_LOGIN_TIMEOUT_SEC,
      });

      leaseActive = false;

      const expired = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.getStatus(request);
        }),
      );
      expect(expired.status).toBe("failed");
      expect(expired.error).toContain("timed out");

      const retried = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );
      expect(retried.status).toBe("pending");
      expect(client.startOAuthLogin).toHaveBeenCalledTimes(2);
    });
  });

  it("marks OAuth login completed before live MCP reload finishes", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;

    const dependencies = Layer.mergeAll(
      Layer.succeed(
        ProviderService,
        makeProviderServiceStub({
          reloadMcpConfigForProject: (_input) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 100);
                }),
            ),
        }),
      ),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.sync(() => {
            leaseActive = true;
            return {
              client: client as unknown as CodexControlClient,
              release: Effect.sync(() => {
                leaseActive = false;
              }),
            };
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );

      client.emit("notification", {
        method: "mcpServer/oauthLogin/completed",
        params: {
          name: request.serverName.toUpperCase(),
          success: true,
        },
      });

      await vi.waitFor(async () => {
        const status = await runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* CodexOAuthManager;
            return yield* manager.getStatus(request);
          }),
        );

        expect(status.status).toBe("completed");
      });
    });
  });

  it("reconciles a pending OAuth login from live MCP auth status", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;

    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.sync(() => {
            leaseActive = true;
            return {
              client: client as unknown as CodexControlClient,
              release: Effect.sync(() => {
                leaseActive = false;
              }),
            };
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );

      client.statuses = [
        {
          name: request.serverName,
          authStatus: "oAuth",
          startupStatus: "ready",
        },
      ];

      const status = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.getStatus(request);
        }),
      );

      expect(status.status).toBe("completed");
      expect(leaseActive).toBe(false);
      expect(client.listenerCount("notification")).toBe(0);
    });
  });

  it("does not complete pending OAuth login from stale failed auth status", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;

    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.sync(() => {
            leaseActive = true;
            return {
              client: client as unknown as CodexControlClient,
              release: Effect.sync(() => {
                leaseActive = false;
              }),
            };
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );

      client.statuses = [
        {
          name: request.serverName,
          authStatus: "oAuth",
          startupStatus: "failed",
          error: "OAuth token refresh failed: Failed to parse server response",
        },
      ];

      const status = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.getStatus(request);
        }),
      );

      expect(status.status).toBe("pending");
      expect(leaseActive).toBe(true);
      expect(client.listenerCount("notification")).toBe(1);
    });
  });

  it("throttles pending OAuth reconciliation polls", async () => {
    const client = new FakeOauthClient();
    let leaseActive = false;

    const dependencies = Layer.mergeAll(
      Layer.succeed(ProviderService, makeProviderServiceStub()),
      makeProjectMcpConfigServiceStub(),
      Layer.succeed(CodexMcpEventBus, {
        publishStatusUpdated: () => Effect.void,
        streamStatusUpdates: Stream.empty,
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (_input) => Effect.die(new Error("unused in CodexOAuthManager tests")),
        hasOauthLease: (_input) => Effect.succeed(leaseActive),
        acquireOauthClient: (_input) =>
          Effect.sync(() => {
            leaseActive = true;
            return {
              client: client as unknown as CodexControlClient,
              release: Effect.sync(() => {
                leaseActive = false;
              }),
            };
          }),
      }),
    );
    const layer = CodexOAuthManagerLive.pipe(Layer.provide(dependencies));

    await withManagerRuntime(layer, async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* CodexOAuthManager;
          return yield* manager.startLogin(request);
        }),
      );

      const readStatus = () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const manager = yield* CodexOAuthManager;
            return yield* manager.getStatus(request);
          }),
        );

      const first = await readStatus();
      const second = await readStatus();

      expect(first.status).toBe("pending");
      expect(second.status).toBe("pending");
      expect(client.listMcpServerStatus).toHaveBeenCalledTimes(1);
    });
  });
});
