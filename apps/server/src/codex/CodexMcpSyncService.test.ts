import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { McpHub } from "../mcp/hub/McpHub.ts";
import { CODEX_ADMIN_HUB_CONFIG_VERSION } from "../mcp/hub/nativeHubOptions.ts";
import { makeFakeMcpHub } from "../mcp/hub/testing/fakeMcpHub.ts";
import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import {
  CodexControlClientRegistry,
  type CodexControlClientAccessInput,
} from "./CodexControlClientRegistry.ts";
import { CodexMcpSyncService, CodexMcpSyncServiceLive } from "./CodexMcpSyncService.ts";

describe("CodexMcpSyncService", () => {
  const makeDependencies = (registryInputs: CodexControlClientAccessInput[]) =>
    Layer.mergeAll(
      Layer.succeed(ProjectMcpConfigService, {
        readCommonStoredConfig: () => Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readProjectStoredConfig: (_projectId: ProjectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readEffectiveStoredConfig: (_projectId: ProjectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readEffectiveRuntimeConfig: (_projectId: ProjectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readCommonConfig: () => Effect.die(new Error("unused in CodexMcpSyncService tests")),
        replaceCommonConfig: (_input) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readProjectConfig: (_projectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        replaceProjectConfig: (_input) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readEffectiveConfig: (_projectId: ProjectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readCodexServers: (requestedProjectId) =>
          Effect.succeed({
            projectId: requestedProjectId,
            effectiveVersion: "mcp-version-9",
            servers: {
              filesystem: {
                type: "stdio" as const,
                command: "npx",
              },
            },
            oauthCallbackPort: 3118,
            oauthCallbackUrl: "http://127.0.0.1:3118/callback",
          }),
      }),
      Layer.succeed(CodexControlClientRegistry, {
        getAdminClient: (input) =>
          Effect.sync(() => {
            registryInputs.push(input);
            return {
              capabilities: {
                configRead: true,
                listMcpServerStatus: true,
              },
              close: vi.fn(),
            } as never;
          }),
        hasOauthLease: (_input) => Effect.die(new Error("unused in CodexMcpSyncService tests")),
        acquireOauthClient: (_input) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
      }),
    );

  it("starts none of F5's servers in the admin client", async () => {
    const projectId = ProjectId.makeUnsafe("project-sync-hub");
    const registryInputs: CodexControlClientAccessInput[] = [];
    const layer = CodexMcpSyncServiceLive.pipe(
      Layer.provideMerge(makeDependencies(registryInputs)),
      Layer.provide(Layer.succeed(McpHub, makeFakeMcpHub().hub)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodexMcpSyncService;
        return yield* service.getStatus({ projectId });
      }).pipe(Effect.provide(layer)),
    );
    // The saved version is still reported; only the pooled client's key is fixed.
    expect(result.configVersion).toBe("mcp-version-9");
    expect(registryInputs).toEqual([
      { projectId, mcpEffectiveConfigVersion: CODEX_ADMIN_HUB_CONFIG_VERSION, mcpServers: {} },
    ]);
  });

  it("reports the saved config version and passes provider options, never F5's servers", async () => {
    const projectId = ProjectId.makeUnsafe("project-sync-service");
    const registryInputs: CodexControlClientAccessInput[] = [];
    const layer = CodexMcpSyncServiceLive.pipe(
      Layer.provideMerge(makeDependencies(registryInputs)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CodexMcpSyncService;
        return yield* service.getStatus({
          projectId,
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      projectId,
      support: "supported",
      configVersion: "mcp-version-9",
    });
    expect(registryInputs).toEqual([
      {
        projectId,
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex",
          },
        },
        mcpEffectiveConfigVersion: CODEX_ADMIN_HUB_CONFIG_VERSION,
        mcpServers: {},
      },
    ]);
  });
});
