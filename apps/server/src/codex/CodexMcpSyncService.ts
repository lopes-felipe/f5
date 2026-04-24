import {
  type McpCodexStatusResult,
  type ProjectId,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import { CodexControlClientRegistry } from "./CodexControlClientRegistry.ts";
import { isMethodNotFoundError } from "./CodexControlClient.ts";

export interface CodexMcpSyncServiceShape {
  readonly getStatus: (input: {
    readonly projectId: ProjectId;
    readonly providerOptions?: ProviderStartOptions;
  }) => Effect.Effect<McpCodexStatusResult, never>;
}

export class CodexMcpSyncService extends ServiceMap.Service<
  CodexMcpSyncService,
  CodexMcpSyncServiceShape
>()("t3/codex/CodexMcpSyncService") {}

const makeCodexMcpSyncService = Effect.gen(function* () {
  const registry = yield* CodexControlClientRegistry;
  const projectMcpConfigService = yield* ProjectMcpConfigService;

  return {
    getStatus: ({ projectId, providerOptions }) =>
      projectMcpConfigService.readCodexServers(projectId).pipe(
        Effect.flatMap((stored) =>
          registry
            .getAdminClient({
              projectId,
              ...(providerOptions ? { providerOptions } : {}),
              mcpEffectiveConfigVersion: stored.effectiveVersion,
              mcpServers: stored.servers,
            })
            .pipe(
              Effect.map(
                (client): McpCodexStatusResult => ({
                  projectId,
                  support: client.capabilities.listMcpServerStatus ? "supported" : "unsupported",
                  ...(client.capabilities.listMcpServerStatus
                    ? {}
                    : {
                        supportMessage:
                          "The installed Codex CLI does not expose MCP control/status RPCs.",
                      }),
                  configVersion: stored.effectiveVersion,
                }),
              ),
            ),
        ),
        Effect.catch((error): Effect.Effect<McpCodexStatusResult> => {
          if (isMethodNotFoundError(error)) {
            return Effect.succeed({
              projectId,
              support: "unsupported",
              supportMessage: "The installed Codex CLI does not expose MCP control/status RPCs.",
            });
          }
          return Effect.succeed({
            projectId,
            support: "unavailable",
            supportMessage:
              error instanceof Error
                ? error.message
                : "Unable to create a Codex control client for this project.",
          });
        }),
      ),
  } satisfies CodexMcpSyncServiceShape;
});

export const CodexMcpSyncServiceLive = Layer.effect(CodexMcpSyncService, makeCodexMcpSyncService);
