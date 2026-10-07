import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration from "./103_UsageLimitResume.ts";

it.layer(SqliteClient.layerMemory())("103_UsageLimitResume", (it) => {
  it.effect(
    "adds durable recovery state idempotently and enforces one live resume per thread",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE projection_thread_sessions(thread_id TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE provider_turn_deliveries(delivery_id TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE next_turn_queue(item_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,deleted_at TEXT)`;
        yield* Migration;
        yield* Migration;
        for (const table of ["projection_thread_sessions", "provider_turn_deliveries"]) {
          const columns = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM pragma_table_info('${table}')`,
          );
          assert.equal(columns.filter((c) => c.name === "usage_limit_json").length, 1);
        }
        yield* sql`INSERT INTO projection_threads VALUES('limited')`;
        yield* sql`INSERT INTO next_turn_queue(item_id,thread_id,schedule_reason) VALUES('first','limited','usage_limit_reset')`;
        const duplicate = yield* Effect.exit(
          sql`INSERT INTO next_turn_queue(item_id,thread_id,schedule_reason) VALUES('second','limited','usage_limit_reset')`,
        );
        assert.equal(duplicate._tag, "Failure");
        yield* sql`UPDATE next_turn_queue SET deleted_at='2026-10-07T12:00:00.000Z' WHERE item_id='first'`;
        yield* sql`INSERT INTO next_turn_queue(item_id,thread_id,schedule_reason) VALUES('second','limited','usage_limit_reset')`;
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage_limit_resumes','usage_limit_resume_streaks')`;
        assert.equal(tables.length, 2);
      }),
  );
});
