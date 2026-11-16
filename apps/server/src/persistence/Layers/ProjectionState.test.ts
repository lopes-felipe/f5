import { assert, it } from "@effect/vitest";
import { Effect, Layer, Metric } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { sqlExecutionDuration } from "../../observability/Metrics.ts";
import { ProjectionStateRepository } from "../Services/ProjectionState.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(ProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "ProjectionStateRepository",
  (it) => {
    it.effect(
      "writes all command cursors in one statement, with identical scalar upsert semantics",
      () =>
        Effect.gen(function* () {
          const repository = yield* ProjectionStateRepository;
          const rows = Array.from({ length: 14 }, (_, index) => ({
            projector: `projector-${String(index).padStart(2, "0")}`,
            lastAppliedSequence: index,
            updatedAt: "2026-10-19T00:00:00.000Z",
          }));
          const count = () =>
            Metric.value(Metric.withAttributes(sqlExecutionDuration, { outcome: "success" })).pipe(
              Effect.map((value) => value.count),
            );
          const before = yield* count();
          yield* repository.upsertMany([]);
          yield* repository.upsertMany(rows);
          // Execution metrics are owned by the Node adapter; data parity also runs on Bun.
          if (!process.versions.bun) assert.equal((yield* count()) - before, 1);
          assert.deepStrictEqual(yield* repository.listAll(), rows);
          const updated = rows.map((row) => ({
            ...row,
            lastAppliedSequence: row.lastAppliedSequence + 10,
          }));
          yield* repository.upsertMany(updated);
          assert.deepStrictEqual(yield* repository.listAll(), updated);
          for (const row of rows) yield* repository.upsert(row);
          assert.deepStrictEqual(yield* repository.listAll(), rows);
        }),
    );
    it.effect("rolls an interrupted cursor group back without leaving partial progress", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionStateRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_state`;
        const old = {
          projector: "before",
          lastAppliedSequence: 1,
          updatedAt: "2026-10-19T00:00:00.000Z",
        };
        yield* repository.upsert(old);
        yield* sql`CREATE TRIGGER fail_cursor_group BEFORE INSERT ON projection_state WHEN NEW.projector = 'poison' BEGIN SELECT RAISE(ABORT, 'interrupted cursor group'); END`;
        const result = yield* Effect.result(
          repository.upsertMany([
            { ...old, lastAppliedSequence: 2 },
            { ...old, projector: "new" },
            { ...old, projector: "poison" },
          ]),
        );
        assert.equal(result._tag, "Failure");
        assert.deepStrictEqual(yield* repository.listAll(), [old]);
        yield* sql`DROP TRIGGER fail_cursor_group`;
      }),
    );
  },
);
