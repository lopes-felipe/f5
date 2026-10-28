import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import migration138 from "./138_ScheduledTasks.ts";
import migration139 from "./139_ScheduledTaskQuarantine.ts";
import migration from "./142_ScheduledRunSharedThreads.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* migration138;
  yield* migration139;
  yield* sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,updated_at)
    VALUES('task','project','{}','hash','at',1,1,'at')`;
  for (const [id, thread] of [
    ["run-a", "thread-a"],
    ["run-b", "thread-b"],
  ] as const)
    yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,submission_id,created_at)
      VALUES(${id},'task',${id},'schedule','succeeded','{}','{}',${thread},${`${id}-submission`},'at')`;
  yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES('run-a-submission','run-a','thread-a','message-a','initial')`;
  yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,parent_submission_id,kind,recovery_decision)
    VALUES('run-a-child','run-a','thread-a','message-a-child','run-a-submission','restart','continue')`;
  yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES('run-b-submission','run-b','thread-b','message-b','initial')`;
});
const legacyAlterTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ legacy_alter_table: number }>`PRAGMA legacy_alter_table`)[0]!
    .legacy_alter_table;
});

it.layer(SqliteClient.layerMemory())("142_ScheduledRunSharedThreads", (it) => {
  it.effect("drops the unique thread constraint and keeps every run and submission", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* migration;
      assert.equal(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM scheduled_task_runs`)[0]!.n,
        2,
      );
      assert.deepEqual(
        yield* sql`SELECT submission_id,parent_submission_id,recovery_decision FROM scheduled_run_submissions ORDER BY rowid`,
        [
          {
            submission_id: "run-a-submission",
            parent_submission_id: null,
            recovery_decision: null,
          },
          {
            submission_id: "run-a-child",
            parent_submission_id: "run-a-submission",
            recovery_decision: "continue",
          },
          {
            submission_id: "run-b-submission",
            parent_submission_id: null,
            recovery_decision: null,
          },
        ],
      );
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,created_at)
        VALUES('run-c','task','run-c','schedule','pending','{}','{}','thread-a','at')`;
      const indexes = new Set(
        (yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('scheduled_task_runs','scheduled_run_submissions')`).map(
          (row) => row.name,
        ),
      );
      for (const name of [
        "scheduled_fire_identity",
        "scheduled_execution_owner",
        "scheduled_pending",
        "scheduled_history",
        "scheduled_submission_thread",
        "scheduled_submission_parent",
        "scheduled_run_thread",
      ])
        assert.isTrue(indexes.has(name), name);
      assert.equal(yield* legacyAlterTable, 0);
      // Deleting a run still cascades to its submissions.
      yield* sql`DELETE FROM scheduled_task_runs WHERE id='run-b'`;
      assert.equal(
        (yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM scheduled_run_submissions WHERE run_id='run-b'`)[0]!.n,
        0,
      );
      const before = yield* sql`SELECT sql FROM sqlite_master WHERE name='scheduled_task_runs'`;
      yield* migration;
      assert.deepEqual(
        yield* sql`SELECT sql FROM sqlite_master WHERE name='scheduled_task_runs'`,
        before,
      );
    }),
  );
});

it.layer(SqliteClient.layerMemory())("142_ScheduledRunSharedThreads rollback", (it) => {
  it.effect("rolls back atomically and restores legacy_alter_table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      // An orphaned submission fails the restore after the rename, inside the transaction.
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES('orphan','missing-run','thread-x','message-x','initial')`;
      yield* sql`PRAGMA foreign_keys = ON`;
      const result = yield* Effect.result(migration);
      assert.equal(result._tag, "Failure");
      assert.equal(yield* legacyAlterTable, 0);
      assert.equal(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM scheduled_run_submissions`)[0]!.n,
        4,
      );
      const duplicate = yield* Effect.result(
        sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,created_at)
          VALUES('run-c','task','run-c','schedule','pending','{}','{}','thread-a','at')`,
      );
      assert.equal(duplicate._tag, "Failure");
    }),
  );
});
