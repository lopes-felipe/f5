import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration137 from "./137_UpstreamPorts.ts";
import Migration141 from "./141_UpstreamPortQueue.ts";

it.layer(SqliteClient.layerMemory())("141_UpstreamPortQueue", (it) => {
  it.effect(
    "preserves old rows, widens kinds, keeps uniqueness and excludes preexisting ports",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Migration137;
        yield* sql`INSERT INTO upstream_ledger_ops VALUES ('old','p',1,'decision','pr-1','{}','recorded','now','now')`;
        yield* sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
      VALUES ('old','p','upstream','manual','llm','now','succeeded')`;
        yield* sql`INSERT INTO upstream_port_links VALUES ('p','pr-1',1,'thread','request',0,'active')`;
        yield* sql`CREATE TABLE search_source (id TEXT)`;
        yield* sql`CREATE TRIGGER broken_search AFTER INSERT ON search_source BEGIN INSERT INTO absent_table VALUES(new.id); END`;
        yield* Migration141;
        assert.deepStrictEqual(yield* sql`SELECT op_id,kind FROM upstream_ledger_ops`, [
          { op_id: "old", kind: "decision" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT run_id,kind FROM upstream_port_runs`, [
          { run_id: "old", kind: "upstream" },
        ]);
        yield* sql`INSERT INTO upstream_ledger_ops VALUES ('new','p',2,'suggestion','pr-1','{}','recorded','now','now')`;
        yield* sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
      VALUES ('new','p','retriage','manual','llm','now','running')`;
        assert.equal(
          (yield* Effect.exit(sql`INSERT INTO upstream_port_runs(run_id,project_id,kind,trigger,triage,started_at,status)
      VALUES ('duplicate','p','upstream','manual','llm','now','running')`))._tag,
          "Failure",
        );
        assert.deepStrictEqual(
          yield* sql`SELECT project_id,thread_id,result FROM upstream_port_outcome_checks`,
          [{ project_id: "p", thread_id: "thread", result: "preexisting" }],
        );
        assert.equal(
          (yield* sql<{ legacy_alter_table: number }>`PRAGMA legacy_alter_table`)[0]!
            .legacy_alter_table,
          0,
        );
        assert.equal(
          (yield* sql`SELECT name FROM sqlite_master WHERE name = 'upstream_ledger_ops_target'`)
            .length,
          1,
        );
      }),
  );
});
