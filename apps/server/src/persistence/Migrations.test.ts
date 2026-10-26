import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, ManagedRuntime } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { repairUnreleasedScheduledTaskMigrations } from "./repairUnreleasedScheduledTaskMigrations.ts";
import { LATEST_MIGRATION_ID, MIGRATIONS, runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";
import quarantineMigration from "./Migrations/139_ScheduledTaskQuarantine.ts";
import scheduledMigration from "./Migrations/138_ScheduledTasks.ts";

describe("MIGRATIONS", () => {
  // The migrator only runs IDs above the highest one a database has applied,
  // so a gap is permanent: a migration that later fills it never runs on any
  // database that already has the higher one.
  it("numbers migrations 1..latest without gaps or duplicates", () => {
    const ids = Object.keys(MIGRATIONS)
      .map((key) => Number.parseInt(key, 10))
      .toSorted((left, right) => left - right);
    expect(ids).toEqual(Array.from({ length: LATEST_MIGRATION_ID }, (_, index) => index + 1));
  });
});

type PrecedingVersion =
  | "main126"
  | "main127"
  | "main128"
  | "main137"
  | "schedules124"
  | "schedules127"
  | "schedules128"
  | "schedules129"
  | "schedules130"
  | "schedules138";

const prepareUpgrade = (version: PrecedingVersion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacySchedules = version.startsWith("schedules");
    const through =
      version === "main137"
        ? 137
        : version === "schedules138"
          ? 136
          : version === "schedules124"
            ? 123
            : ["main128", "schedules130"].includes(version)
              ? 128
              : ["main127", "schedules128", "schedules129"].includes(version)
                ? 127
                : 126;
    const preceding = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= through),
    );
    if (legacySchedules)
      preceding[
        version === "schedules138"
          ? "137_ScheduledTasks"
          : version === "schedules124"
            ? "124_ScheduledTasks"
            : version === "schedules127"
              ? "127_ScheduledTasks"
              : version === "schedules130"
                ? "129_ScheduledTasks"
                : "128_ScheduledTasks"
      ] = scheduledMigration;
    if (version === "schedules129") preceding["129_ScheduledTaskQuarantine"] = quarantineMigration;
    if (version === "schedules130") preceding["130_ScheduledTaskQuarantine"] = quarantineMigration;
    if (version === "schedules138") preceding["138_ScheduledTaskQuarantine"] = quarantineMigration;
    yield* Migrator.make({})({ loader: Migrator.fromRecord(preceding) });
    yield* sql`INSERT INTO provider_terminal_events(event_id,thread_id,turn_id,event_type,event_json,received_at,attempt) VALUES('receipt','thread','turn','turn.completed','{}','2026-10-01',2)`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,model_selection_json,branch,created_at,last_interaction_at,updated_at) VALUES('thread','project','Author','test-model','{}','a','now','now','now')`;
    const workflow = JSON.stringify({
      branchA: { authorThreadId: "thread" },
      branchB: { authorThreadId: "other" },
    });
    yield* sql`INSERT INTO projection_planning_workflows(workflow_id,project_id,workflow_json,updated_at) VALUES('workflow','project',${workflow},'now')`;
    if (version === "main137") {
      yield* sql`INSERT INTO upstream_ledger_ops(op_id,project_id,seq,kind,target,payload_json,state,created_at,updated_at) VALUES('upstream-op','project',1,'interval','target','{}','recorded','now','now')`;
    }
    if (legacySchedules) {
      yield* sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,updated_at) VALUES('task','project','{}','hash','2026-10-01',1,1,'2026-10-01')`;
      yield* sql`INSERT INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,state_json,snapshot_json,thread_id,owns_execution,capacity,created_at) VALUES('run','task','2026-10-01','manual','pending','{}','{}','thread',1,1,'2026-10-01')`;
      yield* sql`INSERT INTO scheduled_run_submissions(submission_id,run_id,thread_id,message_id,kind) VALUES('submission','run','thread','message','initial')`;
      yield* sql`INSERT INTO scheduled_notifications(id,task_id,run_id,thread_id,payload_json,created_at) VALUES('notice','task','run','thread','{}','2026-10-01')`;
      yield* sql`UPDATE scheduled_control SET revision=7, epoch=3, enabled=0, ready=1 WHERE id=1`;
      yield* sql`INSERT INTO projection_state(projector,last_applied_sequence,updated_at) VALUES('scheduledTaskRuns',42,'now')`;
      yield* sql`UPDATE projection_threads SET scheduled_origin_json='{"taskId":"task","runId":"run"}' WHERE thread_id='thread'`;
    }
  });

const assertUpgrade = (version: PrecedingVersion) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacySchedules = version.startsWith("schedules");
    expect(
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id>=124 ORDER BY migration_id`,
    ).toEqual([
      { migration_id: 124, name: "ProviderTerminalRetry" },
      { migration_id: 125, name: "ProviderTerminalRetryIndexes" },
      { migration_id: 126, name: "ProviderTerminalRecoveryIndexes" },
      { migration_id: 127, name: "ClearPlanningWorkflowLaneBranches" },
      { migration_id: 128, name: "ProviderTurnDeliveryBoundaryIndex" },
      { migration_id: 129, name: "PrHubReviewGuides" },
      { migration_id: 130, name: "ThreadPullRequestWatches" },
      { migration_id: 131, name: "ThreadSettlement" },
      { migration_id: 132, name: "McpApps" },
      { migration_id: 133, name: "NativeHistoryRetiredTurns" },
      { migration_id: 134, name: "BackgroundWorkEffort" },
      { migration_id: 135, name: "RestartBackgroundWork" },
      { migration_id: 136, name: "ScratchProjects" },
      { migration_id: 137, name: "UpstreamPorts" },
      { migration_id: 138, name: "ScheduledTasks" },
      { migration_id: 139, name: "ScheduledTaskQuarantine" },
    ]);
    expect(
      yield* sql`SELECT event_id,attempt,origin_session_generation,next_due_at IS NOT NULL AS retry FROM provider_terminal_events`,
    ).toEqual([{ event_id: "receipt", attempt: 2, origin_session_generation: null, retry: 1 }]);
    expect(yield* sql`SELECT op_id,state FROM upstream_ledger_ops`).toEqual(
      version === "main137" ? [{ op_id: "upstream-op", state: "recorded" }] : [],
    );
    const indexes = yield* sql<{ name: string }>`PRAGMA index_list(provider_terminal_events)`;
    expect(indexes.some((index) => index.name === "provider_terminal_events_retry_age")).toBe(true);
    // Main's 127 must not run again on a database that already recorded its correct identity.
    expect(
      yield* sql`SELECT branch,scheduled_origin_json FROM projection_threads WHERE thread_id='thread'`,
    ).toEqual([
      {
        branch: [
          "main127",
          "main128",
          "main137",
          "schedules128",
          "schedules129",
          "schedules130",
          "schedules138",
        ].includes(version)
          ? "a"
          : null,
        scheduled_origin_json: legacySchedules ? '{"taskId":"task","runId":"run"}' : null,
      },
    ]);
    expect(
      yield* sql`SELECT s.submission_id,owns_execution,capacity FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON s.run_id=r.id`,
    ).toEqual(
      legacySchedules ? [{ submission_id: "submission", owns_execution: 1, capacity: 1 }] : [],
    );
    expect(yield* sql`SELECT id,acknowledged_at FROM scheduled_notifications`).toEqual(
      legacySchedules ? [{ id: "notice", acknowledged_at: null }] : [],
    );
    if (legacySchedules) {
      expect(yield* sql`SELECT revision,epoch,enabled,ready FROM scheduled_control`).toEqual([
        { revision: 7, epoch: 3, enabled: 0, ready: 1 },
      ]);
      expect(
        yield* sql`SELECT last_applied_sequence FROM projection_state WHERE projector='scheduledTaskRuns'`,
      ).toEqual([{ last_applied_sequence: 42 }]);
      expect(yield* sql`SELECT id,definition_json FROM scheduled_tasks`).toEqual([
        { id: "task", definition_json: "{}" },
      ]);
    }
  });

for (const version of [
  "main126",
  "main127",
  "main128",
  "main137",
  "schedules124",
  "schedules127",
  "schedules128",
  "schedules129",
  "schedules130",
  "schedules138",
] as const) {
  effectIt.effect(`upgrades ${version} without losing durable evidence`, () =>
    Effect.gen(function* () {
      yield* prepareUpgrade(version);
      yield* repairUnreleasedScheduledTaskMigrations;
      yield* runMigrations;
      yield* runMigrations;
      yield* assertUpgrade(version);
    }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
  );
}

for (const version of ["schedules124", "schedules127", "schedules128", "schedules138"] as const) {
  effectIt.effect(`rolls back interrupted ${version} ledger repair and retries safely`, () =>
    Effect.gen(function* () {
      yield* prepareUpgrade(version);
      const sql = yield* SqlClient.SqlClient;
      const id =
        version === "schedules124"
          ? 124
          : version === "schedules127"
            ? 127
            : version === "schedules138"
              ? 137
              : 128;
      yield* sql.unsafe(
        `CREATE TRIGGER interrupt_repair BEFORE UPDATE ON effect_sql_migrations WHEN OLD.migration_id=${id} AND OLD.name='ScheduledTasks' BEGIN SELECT RAISE(ABORT, 'interrupted repair'); END`,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            repairUnreleasedScheduledTaskMigrations.pipe(Effect.andThen(runMigrations)),
          ),
        ),
      ).toBe(true);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id=${id}`).toEqual([
        { name: "ScheduledTasks" },
      ]);
      expect(yield* sql`SELECT branch FROM projection_threads WHERE thread_id='thread'`).toEqual([
        { branch: "a" },
      ]);
      expect(
        yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id=139`,
      ).toEqual([]);
      yield* sql`DROP TRIGGER interrupt_repair`;
      yield* repairUnreleasedScheduledTaskMigrations;
      yield* runMigrations;
      yield* assertUpgrade(version);
    }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
  );
}

it.each(["schedules127", "schedules138"] as const)(
  "upgrades and reopens a file database from %s without losing ownership or history",
  async (version) => {
    const directory = mkdtempSync(join(tmpdir(), `f5-${version}-upgrade-`));
    const filename = join(directory, "state.sqlite");
    try {
      const previous = ManagedRuntime.make(SqliteClient.layer({ filename }));
      try {
        await previous.runPromise(prepareUpgrade(version));
      } finally {
        await previous.dispose();
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const upgraded = ManagedRuntime.make(SqliteClient.layer({ filename }));
        try {
          await upgraded.runPromise(
            Effect.gen(function* () {
              yield* repairUnreleasedScheduledTaskMigrations;
              yield* runMigrations;
              yield* assertUpgrade(version);
            }),
          );
        } finally {
          await upgraded.dispose();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

effectIt.layer(SqliteClient.layerMemory())("migration upgrades", (it) => {
  it.effect("adds session capabilities after database compaction has already run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const previousMigrations = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 107),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(previousMigrations) });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(before.some((column) => column.name === "capabilities_json")).toBe(false);
      const compaction = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 107
      `;
      expect(compaction).toEqual([{ name: "DatabaseCompaction" }]);

      yield* runMigrations;
      yield* runMigrations;

      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(after.filter((column) => column.name === "capabilities_json")).toHaveLength(1);
      const capabilities = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 108
      `;
      expect(capabilities).toEqual([{ name: "ProjectionThreadSessionCapabilities" }]);
    }),
  );
});

effectIt.layer(SqliteClient.layerMemory())("usage account history upgrade", (it) => {
  it.effect("creates usage history tables on a database already at 115", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const throughDeliveryEvidence = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 115),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(throughDeliveryEvidence) });
      const tables = () => sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN (
          'usage_account_snapshots', 'usage_quota_samples', 'usage_quota_samples_sampled_idx'
        )
        ORDER BY name
      `;
      expect(yield* tables()).toEqual([]);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 115`).toEqual([
        { name: "DeliveryHistoryEvidence" },
      ]);

      yield* runMigrations;
      yield* runMigrations;

      expect((yield* tables()).map((row) => row.name)).toEqual([
        "usage_account_snapshots",
        "usage_quota_samples",
        "usage_quota_samples_sampled_idx",
      ]);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 116`).toEqual([
        { name: "UsageAccountHistory" },
      ]);
    }),
  );
});
