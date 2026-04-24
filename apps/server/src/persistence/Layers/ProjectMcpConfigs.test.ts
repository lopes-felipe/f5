import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectId } from "@t3tools/contracts";
import { ProjectMcpConfigRepository } from "../Services/ProjectMcpConfigs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectMcpConfigRepositoryLive } from "./ProjectMcpConfigs.ts";

const layer = it.layer(
  ProjectMcpConfigRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectMcpConfigRepositoryLive", (it) => {
  it.effect("persists project-scoped configs with version checks", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectMcpConfigRepository;
      const projectId = ProjectId.makeUnsafe("project-mcp-repository");

      const saved = yield* repository.replaceIfVersionMatches({
        scope: "project",
        projectId,
        expectedVersion: null,
        nextVersion: "version-1",
        servers: {
          filesystem: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
          },
        },
        updatedAt: "2026-04-15T00:00:00.000Z",
      });

      assert.equal(Option.isSome(saved), true);
      if (Option.isNone(saved)) {
        return;
      }

      const fetched = yield* repository.get({ scope: "project", projectId });
      assert.equal(Option.isSome(fetched), true);
      if (Option.isSome(fetched)) {
        assert.deepEqual(fetched.value.servers, saved.value.servers);
      }
    }),
  );

  it.effect("keeps common and project scopes isolated", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectMcpConfigRepository;
      const projectId = ProjectId.makeUnsafe("project-mcp-repository-scopes");

      yield* repository.replaceIfVersionMatches({
        scope: "common",
        projectId: null,
        expectedVersion: null,
        nextVersion: "common-version-1",
        servers: {
          shared: {
            type: "stdio",
            command: "common",
          },
        },
        updatedAt: "2026-04-15T00:00:00.000Z",
      });

      yield* repository.replaceIfVersionMatches({
        scope: "project",
        projectId,
        expectedVersion: null,
        nextVersion: "project-version-1",
        servers: {
          shared: {
            type: "stdio",
            command: "project",
          },
        },
        updatedAt: "2026-04-15T00:00:01.000Z",
      });

      const common = yield* repository.get({ scope: "common", projectId: null });
      const project = yield* repository.get({ scope: "project", projectId });

      assert.equal(Option.isSome(common), true);
      assert.equal(Option.isSome(project), true);
      if (Option.isSome(common) && Option.isSome(project)) {
        assert.equal(common.value.scope, "common");
        assert.equal(project.value.scope, "project");
        assert.equal(common.value.projectId, null);
        assert.equal(project.value.projectId, projectId);
        assert.equal(common.value.servers.shared?.command, "common");
        assert.equal(project.value.servers.shared?.command, "project");
      }
    }),
  );
});
