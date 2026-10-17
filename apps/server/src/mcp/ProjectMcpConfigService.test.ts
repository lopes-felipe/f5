import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectMcpConfigRepositoryLive } from "../persistence/Layers/ProjectMcpConfigs.ts";
import { type McpProjectServersConfig, ProjectId } from "@t3tools/contracts";
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
    listByScope: (scope) =>
      Effect.sync(() => [...rows.values()].filter((row) => row.scope === scope)),
    withTransaction: (effect) => effect,

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

async function runServiceEffect<T, E, RepositoryError>(
  effect: Effect.Effect<T, E, ProjectMcpConfigService>,
  repositoryLayer: Layer.Layer<ProjectMcpConfigRepository, RepositoryError>,
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
              oauthClientId: "client-1",
              oauthCallbackPort: 3118,
              oauthCallbackUrl: "http://127.0.0.1:3118/callback",
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
        oauthClientId: "client-1",
        oauthCallbackPort: 3118,
        oauthCallbackUrl: "http://127.0.0.1:3118/callback",
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
    expect(codex.servers.projectOnly).toMatchObject({
      oauth: {
        client_id: "client-1",
      },
    });
    expect(codex.oauthCallbackPort).toBe(3118);
    expect(codex.oauthCallbackUrl).toBe("http://127.0.0.1:3118/callback");
  });

  it("fails Codex server reads when enabled OAuth callback ports conflict", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-conflicting-oauth-ports");
    const { layer } = makeRepositoryLayer();

    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceProjectConfig({
          projectId,
          servers: {
            slack: {
              type: "http",
              url: "https://mcp.slack.com/mcp",
              oauthCallbackPort: 3118,
            },
            observability: {
              type: "http",
              url: "https://observability.example.test/mcp",
              oauthCallbackPort: 4118,
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
          return yield* service.readCodexServers(projectId);
        }),
        layer,
      ),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("must be the same for all enabled servers"),
    });
  });

  it("fails Codex server reads when enabled OAuth callback URLs conflict", async () => {
    const projectId = ProjectId.makeUnsafe("project-mcp-conflicting-oauth-urls");
    const { layer } = makeRepositoryLayer();

    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceProjectConfig({
          projectId,
          servers: {
            slack: {
              type: "http",
              url: "https://mcp.slack.com/mcp",
              oauthCallbackUrl: "http://127.0.0.1:3118/callback",
            },
            observability: {
              type: "http",
              url: "https://observability.example.test/mcp",
              oauthCallbackUrl: "http://127.0.0.1:4118/callback",
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
          return yield* service.readCodexServers(projectId);
        }),
        layer,
      ),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("must be the same for all enabled servers"),
    });
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

describe("configuration write validation", () => {
  const projectId = ProjectId.makeUnsafe("repair-project");
  const stdio = { type: "stdio" as const, command: "node" };

  it("rejects layer overflow on the server and preserves all 32 effective entries", async () => {
    const { layer } = makeRepositoryLayer();
    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        const servers = Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`common-${i}`, stdio]),
        );
        const overflow = yield* service.replaceCommonConfig({ servers }).pipe(Effect.result);
        expect(overflow._tag).toBe("Failure");
        expect((yield* service.readCommonConfig()).version).toBeUndefined();
        delete servers["common-16"];
        yield* service.replaceCommonConfig({ servers });
        yield* service.replaceProjectConfig({
          projectId,
          servers: Object.fromEntries(
            Array.from({ length: 16 }, (_, i) => [`project-${i}`, stdio]),
          ),
        });
        expect(Object.keys((yield* service.readEffectiveConfig(projectId)).servers)).toHaveLength(
          32,
        );
      }),
      layer,
    );
  });

  it("keeps legacy-invalid entries during edits, removals, and repairs without rewriting args", async () => {
    const { layer, rows } = makeRepositoryLayer();
    const servers = {
      ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`legacy-${i}`, stdio])),
      broken: { type: "http" as const, url: "old-invalid-url" },
    };
    rows.set(scopeKey("project", projectId), {
      scope: "project",
      projectId,
      version: "legacy",
      servers,
      updatedAt: new Date().toISOString(),
    });
    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        const edited: McpProjectServersConfig = {
          ...servers,
          "legacy-16": {
            ...stdio,
            args: ["", "  space  "],
            supportsParallelToolCalls: false,
            startupTimeoutSec: 0,
          },
        };
        const saved = yield* service.replaceProjectConfig({
          projectId,
          expectedVersion: "legacy",
          servers: edited,
        });
        expect(saved.servers.broken).toEqual(servers.broken);
        expect(saved.servers["legacy-16"]).toEqual(edited["legacy-16"]);
        expect(saved.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ serverName: "broken" })]),
        );
        const invalid = yield* service
          .replaceProjectConfig({
            projectId,
            expectedVersion: saved.version,
            servers: { ...edited, broken: { type: "http", url: "new-invalid-url" } },
          })
          .pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
        const removed = { ...edited };
        delete removed["legacy-0"];
        const repaired = yield* service.replaceProjectConfig({
          projectId,
          expectedVersion: saved.version,
          servers: { ...removed, broken: { type: "http", url: "http://localhost:3000/mcp" } },
        });
        expect(Object.keys(repaired.servers)).toHaveLength(17);
        expect(repaired.servers.broken?.url).toBe("http://localhost:3000/mcp");
      }),
      layer,
    );
  });

  it("serializes common and project writes that would introduce a cross-layer alias", async () => {
    const { layer } = makeRepositoryLayer();
    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        const results = yield* Effect.all(
          [
            service.replaceCommonConfig({ servers: { GitHub: stdio } }).pipe(Effect.result),
            service
              .replaceProjectConfig({ projectId, servers: { github: stdio } })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
        for (const result of results)
          if (result._tag === "Failure") expect(result.failure.code).toBe("validation");
      }),
      layer,
    );
  });

  it("warns about cross-layer OAuth conflicts, names affected projects, and keeps Claude config readable", async () => {
    const { layer, rows } = makeRepositoryLayer();
    await runServiceEffect(
      Effect.gen(function* () {
        const service = yield* ProjectMcpConfigService;
        yield* service.replaceProjectConfig({
          projectId,
          servers: {
            project: { type: "http", url: "http://localhost/mcp", oauthCallbackPort: 3001 },
          },
        });
        const key = scopeKey("project", projectId);
        rows.set(key, { ...rows.get(key)!, projectName: "Docs workspace" });
        const saved = yield* service.replaceCommonConfig({
          servers: {
            common: { type: "http", url: "http://localhost/mcp", oauthCallbackPort: 3002 },
          },
        });
        expect(saved.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "compatibility",
              projectIds: [projectId],
              message: expect.stringContaining("1 project(s): Docs workspace"),
            }),
          ]),
        );
        expect(
          Object.keys((yield* service.readEffectiveStoredConfig(projectId)).servers),
        ).toHaveLength(2);
        const codex = yield* service.readCodexServers(projectId).pipe(Effect.result);
        expect(codex._tag).toBe("Failure");
        const project = yield* service.readProjectConfig(projectId);
        expect(project.issues?.some((issue) => issue.kind === "compatibility")).toBe(true);
      }),
      layer,
    );
  });
});

it("serializes cross-layer validation inside real SQLite transactions", async () => {
  const projectId = ProjectId.makeUnsafe("transaction-project");
  await runServiceEffect(
    Effect.gen(function* () {
      const service = yield* ProjectMcpConfigService;
      const results = yield* Effect.all(
        [
          service
            .replaceCommonConfig({ servers: { GitHub: { type: "stdio", command: "node" } } })
            .pipe(Effect.result),
          service
            .replaceProjectConfig({
              projectId,
              servers: { github: { type: "stdio", command: "node" } },
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
      const effective = yield* service.readEffectiveConfig(projectId);
      expect(Object.keys(effective.servers)).toHaveLength(1);
    }),
    ProjectMcpConfigRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
  );
});
