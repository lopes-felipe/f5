import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import prHubReviewGuides from "./129_PrHubReviewGuides.ts";
import threadPullRequestWatches from "./130_ThreadPullRequestWatches.ts";
import restartBackgroundWork from "./135_RestartBackgroundWork.ts";

// These migrations moved to new numbers when main took 124-128, so a development database can
// already hold their tables and columns when they run under the new numbers.
it.layer(SqliteClient.layerMemory())("renumbered migrations", (it) => {
  it.effect("run again over their own tables and columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE restart_turn_markers (thread_id TEXT, turn_id TEXT, marked_at TEXT, continuation_id TEXT)`;
      for (const migration of [prHubReviewGuides, threadPullRequestWatches, restartBackgroundWork])
        for (let run = 0; run < 2; run++) yield* migration;
      const columns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('restart_turn_markers')`;
      assert.isTrue(columns.some((column) => column.name === "interrupted_background_work"));
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_pull_request_watches`, []);
    }),
  );
});
