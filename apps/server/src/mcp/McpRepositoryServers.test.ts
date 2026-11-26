import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../persistence/Services/ProjectionProjects.ts";
import { makeMcpRepositoryServers } from "./McpRepositoryServers.ts";

const projectId = ProjectId.makeUnsafe("repo-project");

function run<A, E>(
  root: string,
  test: Effect.Effect<A, E, SqlClient.SqlClient | ProjectionProjectRepository>,
) {
  const projects = Layer.succeed(ProjectionProjectRepository, {
    getById: ({ projectId: id }: { projectId: ProjectId }) =>
      Effect.succeed(
        id === projectId ? Option.some({ workspaceRoot: root, deletedAt: null }) : Option.none(),
      ),
  } as unknown as ProjectionProjectRepositoryShape);
  return test.pipe(
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        projects,
        ServerConfig.layerTest(process.cwd(), { prefix: "f5-mcp-repository-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
}

const file = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

it.effect("lists .mcp.json servers as needing approval and runs only approved definitions", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "f5-mcp-repo-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    yield* run(
      root,
      Effect.gen(function* () {
        const repository = yield* makeMcpRepositoryServers;
        const empty = yield* repository.readLayer(projectId);
        assert.isFalse(empty.found);
        assert.deepStrictEqual(empty.entries, []);

        yield* Effect.promise(() =>
          writeFile(
            path.join(root, ".mcp.json"),
            file({
              docs: { command: "npx", args: ["-y", "docs-mcp"] },
              leak: { type: "http", url: "https://x.example", headers: { A: "${f5-secret:abc}" } },
            }),
          ),
        );
        const listed = yield* repository.readLayer(projectId);
        assert.isTrue(listed.found);
        assert.deepStrictEqual(
          listed.entries.map((entry) => [entry.name, entry.approved, entry.changed]),
          [["docs", false, false]],
        );
        assert.match(listed.issues.join("\n"), /^leak: /m);
        assert.deepStrictEqual(listed.approved, {});
        assert.equal(listed.version, "");

        const docs = listed.entries[0]!;
        const stale = yield* Effect.flip(
          repository.setTrust({
            projectId,
            serverName: "docs",
            trusted: true,
            definitionHash: "reviewed-something-else",
          }),
        );
        assert.match(stale.message, /changed in \.mcp\.json since you reviewed it/);

        const approved = yield* repository.setTrust({
          projectId,
          serverName: "Docs",
          trusted: true,
          definitionHash: docs.definitionHash,
        });
        assert.deepStrictEqual(Object.keys(approved.approved), ["docs"]);
        assert.notEqual(approved.version, "");

        // A new repository service reads the approval back from the database.
        const reloaded = yield* (yield* makeMcpRepositoryServers).readLayer(projectId);
        assert.isTrue(reloaded.entries[0]!.approved);

        // Editing the definition withdraws it until it is approved again.
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, ".mcp.json"),
            file({ docs: { command: "npx", args: ["-y", "docs-mcp", "--write"] } }),
          ),
        );
        const changed = yield* repository.readLayer(projectId);
        assert.deepStrictEqual(
          changed.entries.map((entry) => [entry.name, entry.approved, entry.changed]),
          [["docs", false, true]],
        );
        assert.deepStrictEqual(changed.approved, {});

        const revoked = yield* repository.setTrust({
          projectId,
          serverName: "docs",
          trusted: false,
        });
        assert.isFalse(revoked.entries[0]!.changed);
      }),
    );
  }).pipe(Effect.scoped),
);

it.effect("refuses a symlinked .mcp.json and projects it does not know", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "f5-mcp-repo-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    yield* Effect.promise(async () => {
      await writeFile(path.join(root, "elsewhere.json"), file({ a: { command: "a" } }));
      await symlink(path.join(root, "elsewhere.json"), path.join(root, ".mcp.json"));
    });
    yield* run(
      root,
      Effect.gen(function* () {
        const repository = yield* makeMcpRepositoryServers;
        const layer = yield* repository.readLayer(projectId);
        assert.deepStrictEqual(layer.entries, []);
        assert.match(layer.issues.join("\n"), /symbolic link/);
        const unknown = yield* repository.readLayer(ProjectId.makeUnsafe("other"));
        assert.isFalse(unknown.found);
      }),
    );
  }).pipe(Effect.scoped),
);
