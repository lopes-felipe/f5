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
import { makeMcpRepositoryServers, repositoryApprovalLimitIssue } from "./McpRepositoryServers.ts";

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
        assert.deepStrictEqual(listed.withdrawn, ["docs"]);
        assert.deepStrictEqual(repository.trustedProjects(), []);

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
        assert.deepStrictEqual(approved.withdrawn, []);
        assert.deepStrictEqual(repository.trustedProjects(), [projectId]);

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
        assert.deepStrictEqual(changed.withdrawn, ["docs"]);

        // An approved server the file stops listing is withdrawn too, so live sessions drop it.
        yield* Effect.promise(() => writeFile(path.join(root, ".mcp.json"), file({})));
        assert.deepStrictEqual((yield* repository.readLayer(projectId)).withdrawn, ["docs"]);

        const revoked = yield* repository.setTrust({
          projectId,
          serverName: "docs",
          trusted: false,
        });
        assert.deepStrictEqual(revoked.withdrawn, []);
        assert.deepStrictEqual(repository.trustedProjects(), []);
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

it.effect("runs nothing from a repository when its approvals cannot be read", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "f5-mcp-repo-")));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(root, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      writeFile(path.join(root, ".mcp.json"), file({ docs: { command: "docs" } })),
    );
    yield* run(
      root,
      Effect.gen(function* () {
        const repository = yield* makeMcpRepositoryServers;
        const docs = (yield* repository.readLayer(projectId)).entries[0]!;
        yield* repository.setTrust({
          projectId,
          serverName: "docs",
          trusted: true,
          definitionHash: docs.definitionHash,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE mcp_repository_trust`;
        const restarted = yield* (yield* makeMcpRepositoryServers).readLayer(projectId);
        assert.deepStrictEqual(restarted.approved, {});
        assert.isFalse(restarted.entries[0]!.approved);
      }),
    );
  }).pipe(Effect.scoped),
);

it("refuses an approval that would take the project past the effective limit", () => {
  const entry = { type: "stdio" as const, command: "node" };
  const servers = (prefix: string, count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, entry]));
  const layer = {
    found: true,
    entries: [
      { name: "docs", server: entry, definitionHash: "h", approved: false, changed: false },
      { name: "kept", server: entry, definitionHash: "k", approved: true, changed: false },
    ],
    issues: [],
    approved: { kept: entry },
    version: "v",
    withdrawn: ["docs"],
  };
  const full = { layer, common: servers("c", 16), project: servers("p", 15) };
  assert.match(
    repositoryApprovalLimitIssue({ ...full, serverName: "Docs" }) ?? "",
    /Approving 'docs' would exceed the 32-server limit/,
  );
  // Already approved, unknown, or overriding a project entry of the same name: no growth.
  assert.isUndefined(repositoryApprovalLimitIssue({ ...full, serverName: "kept" }));
  assert.isUndefined(repositoryApprovalLimitIssue({ ...full, serverName: "missing" }));
  assert.isUndefined(
    repositoryApprovalLimitIssue({
      ...full,
      project: { ...servers("p", 14), docs: entry },
      serverName: "docs",
    }),
  );
});
