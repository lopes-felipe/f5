import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionProjectRepository", (it) => {
  it.effect("stores a project written without a kind as a standard project", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionProjectRepository;
      const projectId = ProjectId.makeUnsafe("project-without-kind");
      const now = "2026-10-22T03:00:00.000Z";

      // `kind` is optional for callers written before scratch projects existed.
      yield* repository.upsert({
        projectId,
        title: "Before scratch projects",
        workspaceRoot: "/tmp/before-scratch",
        defaultModel: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const stored = yield* repository.getById({ projectId });
      assert.equal(Option.getOrThrow(stored).kind, "standard");
    }),
  );
});
