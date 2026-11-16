import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { browserOpenThreadIsFullAccess } from "./BrowserOpenPreapproval.ts";

it.layer(SqlitePersistenceMemory)("browser-open preapproval", (it) => {
  it.effect("qualifies only live full-access threads, archived included", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A renamed column fails here rather than silently sending every request to the prompt.
      const columns = yield* sql<{ name: string }>`PRAGMA main.table_info(projection_threads)`;
      for (const column of ["thread_id", "runtime_mode", "archived_at", "deleted_at"])
        assert.include(
          columns.map((entry) => entry.name),
          column,
        );
      // A temporary table shadows the migrated one, so rows need only the columns read here.
      yield* sql`CREATE TEMP TABLE projection_threads (thread_id TEXT PRIMARY KEY, runtime_mode TEXT, archived_at TEXT, deleted_at TEXT)`;
      for (const [id, mode, archived, deleted] of [
        ["full", "full-access", null, null],
        ["archived", "full-access", "2026-11-01T00:00:00.000Z", null],
        ["deleted", "full-access", null, "2026-11-01T00:00:00.000Z"],
        ["supervised", "approval-required", null, null],
      ] as const)
        yield* sql`INSERT INTO projection_threads (thread_id, runtime_mode, archived_at, deleted_at) VALUES (${id}, ${mode}, ${archived}, ${deleted})`;
      assert.isTrue(yield* browserOpenThreadIsFullAccess("full"));
      assert.isTrue(yield* browserOpenThreadIsFullAccess("archived"));
      assert.isFalse(yield* browserOpenThreadIsFullAccess("deleted"));
      assert.isFalse(yield* browserOpenThreadIsFullAccess("supervised"));
      assert.isFalse(yield* browserOpenThreadIsFullAccess("missing"));
    }),
  );
});
