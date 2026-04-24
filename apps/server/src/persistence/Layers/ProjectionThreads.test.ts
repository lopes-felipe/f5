import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadRepository", (it) => {
  it.effect("round-trips archived_at through upsert and read paths", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.makeUnsafe("thread-archived");
      const projectId = ProjectId.makeUnsafe("project-1");

      yield* repository.upsert({
        threadId,
        projectId,
        title: "Archived thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        tasks: [
          {
            id: "task-1",
            content: "Run tests",
            activeForm: "Running tests",
            status: "in_progress",
          },
        ],
        tasksTurnId: TurnId.makeUnsafe("turn-1"),
        tasksUpdatedAt: "2026-03-10T08:45:00.000Z",
        compaction: null,
        estimatedContextTokens: 72_000,
        modelContextWindowTokens: 400_000,
        sessionNotes: null,
        threadReferences: [],
        archivedAt: "2026-03-10T09:00:00.000Z",
        createdAt: "2026-03-10T08:00:00.000Z",
        lastInteractionAt: "2026-03-10T08:30:00.000Z",
        updatedAt: "2026-03-10T09:00:00.000Z",
        deletedAt: null,
      });

      const row = yield* repository.getById({ threadId });
      const rows = yield* repository.listByProjectId({ projectId });

      assert.equal(row._tag, "Some");
      if (row._tag !== "Some") {
        throw new Error("Expected archived projection thread row.");
      }
      assert.equal(row.value.archivedAt, "2026-03-10T09:00:00.000Z");
      assert.equal(row.value.compaction, null);
      assert.equal(row.value.estimatedContextTokens, 72_000);
      assert.equal(row.value.modelContextWindowTokens, 400_000);
      assert.equal(row.value.tasksTurnId, "turn-1");
      assert.equal(row.value.tasksUpdatedAt, "2026-03-10T08:45:00.000Z");
      assert.deepEqual(row.value.tasks, [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
        },
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.archivedAt, "2026-03-10T09:00:00.000Z");
      assert.equal(rows[0]?.estimatedContextTokens, 72_000);
      assert.equal(rows[0]?.modelContextWindowTokens, 400_000);
      assert.equal(rows[0]?.tasks[0]?.id, "task-1");
      assert.equal(rows[0]?.tasksTurnId, "turn-1");
    }),
  );
});
