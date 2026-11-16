import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Late checkpoint/tool completion cannot resurrect a turn removed by native ancestry proof. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS native_history_retired_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, retired_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, turn_id)
  )`;
});
