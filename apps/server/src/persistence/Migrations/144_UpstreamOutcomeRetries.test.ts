import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration137 from "./137_UpstreamPorts.ts";
import Migration143 from "./143_UpstreamPortQueue.ts";
import Migration144 from "./144_UpstreamOutcomeRetries.ts";

it.layer(SqliteClient.layerMemory())("144_UpstreamOutcomeRetries", (it) => {
  it.effect("preserves existing checks and initializes the retry budget", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration137;
      yield* Migration143;
      yield* sql`INSERT INTO upstream_port_outcome_checks
        (project_id,thread_id,turn_id,result,detail,checked_at)
        VALUES ('p','t','turn','failed','busy','now')`;
      yield* Migration144;
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id,turn_id,result,attempts,retry_at FROM upstream_port_outcome_checks`,
        [{ thread_id: "t", turn_id: "turn", result: "failed", attempts: 0, retry_at: null }],
      );
    }),
  );
});
