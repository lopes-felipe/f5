import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0066 from "./066_ThreadBackgroundWork.ts";

it.layer(SqliteClient.layerMemory())("066_ThreadBackgroundWork", (it) => {
  it.effect("creates the durable background-work projection idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY
        )
      `;
      yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;

      yield* Migration0066;
      yield* Migration0066;

      yield* sql`
        INSERT INTO projection_thread_background_work (
          thread_id,
          provider_work_item_id,
          provider_name,
          classification,
          ownership,
          status,
          active,
          started_at,
          updated_at,
          last_seen_at
        ) VALUES (
          'thread-1',
          'task-1',
          'claudeAgent',
          'working',
          'direct-subagent',
          'running',
          1,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_background_work
      `;
      assert.deepStrictEqual(rows, [{ count: 1 }]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_thread_background_work'
      `;
      assert.equal(
        indexes.some((index) => index.name === "projection_thread_background_work_liveness_idx"),
        true,
      );
    }),
  );
});
