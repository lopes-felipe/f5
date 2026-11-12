import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration137 from "./137_UpstreamPorts.ts";
import Migration143 from "./143_UpstreamPortQueue.ts";
import Migration156 from "./156_UpstreamReclassifyRuns.ts";

it.layer(SqliteClient.layerMemory())("156_UpstreamReclassifyRuns", (it) => {
  it.effect("keeps runs, allows reclassify and keeps one running run per project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration137;
      yield* Migration143;
      yield* sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status,llm_calls)
        VALUES ('old','p','retriage','manual','llm','now','succeeded',3)`;
      yield* Migration156;
      assert.deepStrictEqual(yield* sql`SELECT run_id,kind,llm_calls FROM upstream_port_runs`, [
        { run_id: "old", kind: "retriage", llm_calls: 3 },
      ]);
      yield* sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
        VALUES ('new','p','reclassify','manual','rules-only','now','running')`;
      assert.equal(
        (yield* Effect.exit(sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
          VALUES ('duplicate','p','upstream','manual','llm','now','running')`))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
          VALUES ('bad','q','other','manual','llm','now','succeeded')`))._tag,
        "Failure",
      );
      yield* sql`INSERT INTO upstream_budget_state(project_id,last_digest_at) VALUES ('p','now')`;
      assert.deepStrictEqual(
        yield* sql`SELECT project_id,last_digest_at FROM upstream_budget_state`,
        [{ project_id: "p", last_digest_at: "now" }],
      );
    }),
  );
});
