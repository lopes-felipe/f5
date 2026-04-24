import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectMcpConfigRepository,
  type ProjectMcpConfigRecord,
  type ProjectMcpConfigRepositoryShape,
} from "../persistence/Services/ProjectMcpConfigs.ts";
import { ProjectMcpConfigService, ProjectMcpConfigServiceLive } from "./ProjectMcpConfigService.ts";

function scopeKey(scope: "common" | "project", projectId: string | null): string {
  return scope === "common" ? "common" : `project:${projectId ?? ""}`;
}

function makeRepositoryLayer() {
  const rows = new Map<string, ProjectMcpConfigRecord>();

  const repository: ProjectMcpConfigRepositoryShape = {
    get: ({ scope, projectId }) =>
      Effect.succeed(
        rows.has(scopeKey(scope, projectId))
          ? Option.some(rows.get(scopeKey(scope, projectId))!)
          : Option.none(),
      ),
    replaceIfVersionMatches: ({
      scope,
      projectId,
      expectedVersion,
      nextVersion,
      servers,
      updatedAt,
    }) =>
      Effect.sync(() => {
        const key = scopeKey(scope, projectId);
        const existing = rows.get(key);
        const existingVersion = existing?.version ?? null;
        if (existingVersion !== expectedVersion) {
          return Option.none<ProjectMcpConfigRecord>();
        }

        const row: ProjectMcpConfigRecord = {
          scope,
          projectId,
          version: nextVersion,
          servers,
          updatedAt,
        };
        rows.set(key, row);
        return Option.some(row);
      }),
  };

  return {
    rows,
    layer: Layer.succeed(ProjectMcpConfigRepository, repository),
  };
}

async function runServiceEffect<T, E>(
  effect: Effect.Effect<T, E, ProjectMcpConfigService>,
  repositoryLayer: Layer.Layer<ProjectMcpConfigRepository>,
) {
  const layer = ProjectMcpConfigServiceLive.pipe(Layer.provideMerge(repositoryLayer));
  return await Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

describe("ProjectMcpConfigService", () => {
  it("reads raw common and project config and merges effective config with project precedence", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-service-merge");
    const { layer } = makeRepositoryLayer();

    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceCommonConfig({
          servers: {
            shared: {
              type: "stdio",
              command: "npx",
              env: {
                API_KEY: "common-secret",
              },
            },
            overridden: {
              type: "stdio",
              command: "common-command",
            },
            disabled: {
              type: "stdio",
              command: "node",
              enabled: false,
            },
          },
        });
        yield* service.replaceProjectConfig({
          projectId,
          servers: {
            overridden: {
              type: "stdio",
              command: "project-command",
            },
            projectOnly: {
              type: "http",
              url: "https://example.test/mcp",
              headers: {
                Authorization: "Bearer project-token",
              },
            },
          },
        });
      }),
      layer,
    );

    const common = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readCommonConfig();
      }),
      layer,
    );
    expect(common.servers.shared?.type).toBe("stdio");
    expect(common.servers.shared?.env).toEqual({ API_KEY: "common-secret" });

    const project = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readProjectConfig(projectId);
      }),
      layer,
    );
    expect(project.servers.overridden?.type).toBe("stdio");
    expect(project.servers.overridden?.command).toBe("project-command");

    const effective = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readEffectiveConfig(projectId);
      }),
      layer,
    );
    expect(effective.servers).toEqual({
      shared: {
        type: "stdio",
        command: "npx",
        env: {
          API_KEY: "common-secret",
        },
      },
      overridden: {
        type: "stdio",
        command: "project-command",
      },
      disabled: {
        type: "stdio",
        command: "node",
        enabled: false,
      },
      projectOnly: {
        type: "http",
        url: "https://example.test/mcp",
        headers: {
          Authorization: "Bearer project-token",
        },
      },
    });

    const codex = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readCodexServers(projectId);
      }),
      layer,
    );
    expect(codex.effectiveVersion).toBe(effective.effectiveVersion);
    expect(codex.servers.disabled).toBeUndefined();
    expect(codex.servers.overridden?.type).toBe("stdio");
    expect(codex.servers.projectOnly?.type).toBe("http");
  });

  it("keeps the effective version stable when only fully overridden common config changes", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-effective-version");
    const { layer } = makeRepositoryLayer();

    const firstEffective = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceCommonConfig({
          servers: {
            shared: {
              type: "stdio",
              command: "common-v1",
            },
          },
        });
        yield* service.replaceProjectConfig({
          projectId,
          servers: {
            shared: {
              type: "stdio",
              command: "project-wins",
            },
          },
        });
        return yield* service.readEffectiveConfig(projectId);
      }),
      layer,
    );

    const secondEffective = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceCommonConfig({
          expectedVersion: firstEffective.commonVersion,
          servers: {
            shared: {
              type: "stdio",
              command: "common-v2",
            },
          },
        });
        return yield* service.readEffectiveConfig(projectId);
      }),
      layer,
    );

    expect(secondEffective.effectiveVersion).toBe(firstEffective.effectiveVersion);
    expect(secondEffective.servers.shared?.command).toBe("project-wins");
  });

  it("round-trips raw env and header values without redaction", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-round-trip");
    const { layer } = makeRepositoryLayer();

    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.replaceProjectConfig({
          projectId,
          servers: {
            filesystem: {
              type: "stdio",
              command: "npx",
              env: {
                API_KEY: "super-secret",
              },
            },
            remote: {
              type: "http",
              url: "https://mcp.example.test",
              headers: {
                Authorization: "Bearer secret-token",
              },
            },
          },
        });
      }),
      layer,
    );

    const stored = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readProjectConfig(projectId);
      }),
      layer,
    );

    expect(stored.servers.filesystem?.env).toEqual({
      API_KEY: "super-secret",
    });
    expect(stored.servers.remote?.headers).toEqual({
      Authorization: "Bearer secret-token",
    });
  });

  it("rejects stale expected versions", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-service-conflict");
    const { layer } = makeRepositoryLayer();

    const saved = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.replaceProjectConfig({
          projectId,
          servers: {
            filesystem: {
              type: "stdio",
              command: "npx",
            },
          },
        });
      }),
      layer,
    );

    await expect(
      runServiceEffect(
        Effect.gen(function* () {
          const service = yield* ProjectMcpConfigService;
          return yield* service.replaceProjectConfig({
            projectId,
            expectedVersion: "stale-version",
            servers: {
              filesystem: {
                type: "stdio",
                command: "node",
              },
            },
          });
        }),
        layer,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    const stored = await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        return yield* service.readProjectConfig(projectId);
      }),
      layer,
    );
    expect(stored.version).toBe(saved.version);
    expect(stored.servers.filesystem?.command).toBe("npx");
  });
});
