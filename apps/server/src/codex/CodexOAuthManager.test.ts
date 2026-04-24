import { EventEmitter } from "node:events";

import {
  ProjectId,
  type McpOauthLoginStatusRequest,
  type ProviderSession,
} from "@t3tools/contracts";
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

class FakeOauthClient extends EventEmitter {
  readonly close = vi.fn();
  readonly startOAuthLogin = vi.fn(async () => ({
    authorizationUrl: "https://auth.example.test/login",
  }));
}

function makeProviderServiceStub(): ProviderServiceShape {
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
    reloadMcpConfigForProject: (_input) => Effect.void,
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
      expect(client.startOAuthLogin).toHaveBeenCalledTimes(1);

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
});
