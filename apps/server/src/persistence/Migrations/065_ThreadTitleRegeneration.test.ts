import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0065 from "./065_ThreadTitleRegeneration.ts";

it.layer(SqliteClient.layerMemory())("065_ThreadTitleRegeneration", (it) => {
  it.effect("adds race-safe title state and preserves existing titles as legacy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        )
      `;
      yield* sql`INSERT INTO projection_threads (thread_id, title) VALUES ('thread-1', 'Existing')`;

      yield* Migration0065;
      yield* Migration0065;

      const row = yield* sql<{
        readonly title_source: string;
        readonly title_revision: number;
        readonly title_updated_at: string | null;
        readonly title_regeneration_request_id: string | null;
        readonly title_regeneration_started_at: string | null;
      }>`
        SELECT
          title_source,
          title_revision,
          title_updated_at,
          title_regeneration_request_id,
          title_regeneration_started_at
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(row, [
        {
          title_source: "legacy",
          title_revision: 0,
          title_updated_at: null,
          title_regeneration_request_id: null,
          title_regeneration_started_at: null,
        },
      ]);
    }),
  );
});
