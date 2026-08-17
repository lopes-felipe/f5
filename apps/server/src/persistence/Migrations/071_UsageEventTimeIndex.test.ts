import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0071 from "./071_UsageEventTimeIndex.ts";

it.layer(SqliteClient.layerMemory())("071_UsageEventTimeIndex", (it) => {
  it.effect("is a no-op for synthetic schemas without the event table", () => Migration0071);

  it.effect("adds the usage event lookup index idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        )
      `;

      yield* Migration0071;
      yield* Migration0071;

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events'
      `;
      assert.equal(
        indexes.some((index) => index.name === "idx_orch_events_type_occurred_at"),
        true,
      );
    }),
  );
});
