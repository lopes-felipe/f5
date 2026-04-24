import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import {
  CodexControlClientRegistry,
  type CodexControlClientAccessInput,
} from "./CodexControlClientRegistry.ts";
import { CodexMcpSyncService, CodexMcpSyncServiceLive } from "./CodexMcpSyncService.ts";

describe("CodexMcpSyncService", () => {
  it("reads project-scoped MCP config and passes it into the control registry", async () => {
    const projectId = ProjectId.makeUnsafe("project-sync-service");
    const registryInputs: CodexControlClientAccessInput[] = [];
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectMcpConfigService, {
        readCommonStoredConfig: () => Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readProjectStoredConfig: (_projectId: ProjectId) =>
          Effect.die(new Error("unused in CodexMcpSyncService tests")),
        readEffectiveStoredConfig: (_projectId: ProjectId) =>
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
    const layer = CodexMcpSyncServiceLive.pipe(Layer.provideMerge(dependencies));

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
        mcpEffectiveConfigVersion: "mcp-version-9",
        mcpServers: {
          filesystem: {
            type: "stdio",
            command: "npx",
          },
        },
      },
    ]);
  });
});
