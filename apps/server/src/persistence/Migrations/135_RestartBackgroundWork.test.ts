import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration from "./135_RestartBackgroundWork.ts";

it.layer(SqliteClient.layerMemory())("135_RestartBackgroundWork", (it) => {
  it.effect(
    "preserves old restart markers with no claimed background cut and bounds new counts",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE restart_turn_markers (thread_id TEXT, turn_id TEXT, marked_at TEXT, continuation_id TEXT)`;
        yield* sql`INSERT INTO restart_turn_markers VALUES ('thread', 'turn', 'at', 'continuation')`;
        yield* migration;
        assert.deepEqual(
          yield* sql`SELECT continuation_id, interrupted_background_work FROM restart_turn_markers`,
          [{ continuation_id: "continuation", interrupted_background_work: 0 }],
        );
        for (const count of [-1, 202, 1.5]) {
          const rejected =
            yield* sql`UPDATE restart_turn_markers SET interrupted_background_work = ${count}`.pipe(
              Effect.result,
            );
          assert.equal(rejected._tag, "Failure");
        }
        yield* sql`UPDATE restart_turn_markers SET interrupted_background_work = 201`;
      }),
  );
});
