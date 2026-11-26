import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, ManagedRuntime } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { repairUnreleasedScheduledTaskMigrations } from "./repairUnreleasedScheduledTaskMigrations.ts";
import { BASELINE_MIGRATION_ID } from "./BaselineSchema.ts";
import {
  applyBaselineSchemaIfFresh,
  LATEST_MIGRATION_ID,
  MIGRATIONS,
  runIncrementalMigrations,
  runMigrations,
} from "./Migrations.ts";
import { WorktreePreparationsLive } from "./Layers/WorktreePreparations.ts";
import { WorktreePreparations } from "./Services/WorktreePreparations.ts";
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

effectIt.effect("upgrades a version 173 database for managed workspace groups", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const oldMigrations = Object.fromEntries(
      Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 173),
    );
    yield* Migrator.make({})({ loader: Migrator.fromRecord(oldMigrations) });
    expect(
      yield* sql`SELECT name FROM pragma_table_info('projection_thread_pull_requests')
      WHERE name = 'repository_path'`,
    ).toEqual([]);
    yield* runMigrations;
    expect(
      yield* sql`SELECT name FROM pragma_table_info('projection_thread_pull_requests')
      WHERE name = 'repository_path'`,
    ).toEqual([{ name: "repository_path" }]);
    yield* Effect.gen(function* () {
      const preparations = yield* WorktreePreparations;
      const group = {
        projectId: "project",
        threadId: "thread",
        projectRoot: "/project",
        path: "/worktree",
        branch: "work",
        repositories: ["/project/api"],
        members: [
          {
            path: "/worktree/api",
            source: "/project/api",
            identity: "/project/api/.git",
            baseOid: "a".repeat(40),
          },
        ],
      };
      yield* preparations.saveGroup(group);
      expect(yield* preparations.getGroup(group.path)).toEqual(group);
      expect(yield* preparations.getGroupLayoutPhase(group.path)).toBe("pending");
      yield* preparations.deleteGroup({ ...group, threadId: "other-thread" });
      expect(yield* preparations.getGroup(group.path)).toEqual(group);
      yield* preparations.deleteGroup(group);
      expect(yield* preparations.getGroup(group.path)).toBeNull();
      yield* sql`WITH RECURSIVE paths(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM paths WHERE i < 128)
        INSERT INTO project_repository_roots(project_id, path)
        SELECT 'project', '/extra-' || i FROM paths`;
      yield* preparations.setProjectRepositoryRoot("project", "/extra-1", true);
      const result = yield* Effect.result(
        preparations.setProjectRepositoryRoot("project", "/too-many", true),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("128 registered external repositories") },
      });
    }).pipe(Effect.provide(WorktreePreparationsLive));
  }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
);

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
      { migration_id: 140, name: "UpstreamTopicHistoryIndex" },
      { migration_id: 141, name: "QueueHumanSend" },
      { migration_id: 142, name: "ScheduledRunSharedThreads" },
      { migration_id: 143, name: "UpstreamPortQueue" },
      { migration_id: 144, name: "UpstreamOutcomeRetries" },
      { migration_id: 145, name: "UpstreamPortReviews" },
      { migration_id: 146, name: "ProjectionThreadMessagesReasoningTokens" },
      { migration_id: 147, name: "StorageMachineCleanupAudit" },
      { migration_id: 148, name: "ProjectionThreadActivitiesRankIndex" },
      { migration_id: 149, name: "ThreadReferenceGrants" },
      { migration_id: 150, name: "ExcludeImageOnlyPromptFromSearch" },
      { migration_id: 151, name: "ProviderHandoffState" },
      { migration_id: 152, name: "UpstreamTopicOutcomes" },
      { migration_id: 153, name: "ProjectionThreadCommandExecutionsDescription" },
      { migration_id: 154, name: "DesktopActivityPendingIndex" },
      { migration_id: 155, name: "BackgroundWorkNativeParentSession" },
      { migration_id: 156, name: "UpstreamReclassifyRuns" },
      { migration_id: 157, name: "ProjectionThreadActivitiesWorktreeSetupIndex" },
      { migration_id: 158, name: "ProviderTurnDeliveryPendingIndex" },
      { migration_id: 159, name: "EventCompactionKeepLast" },
      { migration_id: 160, name: "DropUnreadEventIndexes" },
      { migration_id: 161, name: "UsageNativeIdentity" },
      { migration_id: 162, name: "UsageFactsThreadIndex" },
      { migration_id: 163, name: "DropUnreadReceiptIndexes" },
      { migration_id: 164, name: "UpstreamPortReviewRecovery" },
      { migration_id: 165, name: "UsageResetCreditGrant" },
      { migration_id: 166, name: "ThreadPullRequestLookupIndex" },
      { migration_id: 167, name: "PrHubSeenBaseline" },
      { migration_id: 168, name: "ProviderExtensionStatuses" },
      { migration_id: 169, name: "ThreadContextBoundaries" },
      { migration_id: 170, name: "ProjectPinArchive" },
      { migration_id: 171, name: "SessionAutoCompactThreshold" },
      { migration_id: 172, name: "ThreadSideChat" },
      { migration_id: 173, name: "SessionAuthFailure" },
      { migration_id: 174, name: "WorktreeGroups" },
      { migration_id: 175, name: "UsageSpeedAndExternalIdentity" },
      { migration_id: 176, name: "McpHubGovernance" },
    ]);
    // The queue reads linked threads by pull request; the lookup uses its own index.
    const linkLookup = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT thread_id FROM projection_thread_pull_requests
      WHERE provider = 'github' AND host = 'github.com' AND repository = 'octo/repo' AND number = 1`;
    expect(linkLookup.map((step) => step.detail).join(" ")).toContain(
      "projection_thread_pull_requests_pull_request_idx",
    );
    // Receipts are only ever found by command id, which the primary key serves.
    const receiptIndexes = yield* sql<{
      name: string;
    }>`PRAGMA index_list(orchestration_command_receipts)`;
    expect(receiptIndexes.map((index) => index.name)).toEqual([
      "sqlite_autoindex_orchestration_command_receipts_1",
    ]);
    // The event log keeps the indexes its readers use: stream, sequence and type.
    const eventIndexes = yield* sql<{ name: string }>`PRAGMA index_list(orchestration_events)`;
    expect(eventIndexes.map((index) => index.name).toSorted()).toEqual([
      "idx_orch_events_stream_sequence",
      "idx_orch_events_stream_version",
      "idx_orch_events_type_occurred_at",
      "sqlite_autoindex_orchestration_events_1",
    ]);
    const usageFactIndexes = yield* sql<{
      name: string;
    }>`PRAGMA index_list(projection_turn_usage_facts)`;
    expect(
      usageFactIndexes.some(
        (index) => index.name === "projection_turn_usage_facts_thread_completed_idx",
      ),
    ).toBe(true);
    const activityIndexes = yield* sql<{
      name: string;
    }>`PRAGMA index_list(projection_thread_activities)`;
    expect(
      activityIndexes.some(
        (index) => index.name === "idx_projection_thread_activities_thread_rank",
      ),
    ).toBe(true);
    expect(
      activityIndexes.some(
        (index) => index.name === "idx_projection_thread_activities_thread_sequence",
      ),
    ).toBe(true);
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

effectIt.layer(SqliteClient.layerMemory())("thread reference grants upgrade", (it) => {
  it.effect("creates the grants table on a database already at 148", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const throughActivityRankIndex = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 148),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(throughActivityRankIndex) });
      const tables = () =>
        sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE name = 'thread_reference_grants'`;
      expect(yield* tables()).toEqual([]);

      yield* runMigrations;
      yield* runMigrations;

      expect(yield* tables()).toEqual([{ name: "thread_reference_grants" }]);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 149`).toEqual([
        { name: "ThreadReferenceGrants" },
      ]);
    }),
  );
});

const inspectDatabaseSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const master = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;

  const userTables = master
    .filter((row) => row.type === "table" && !row.name.startsWith("search_documents_fts_"))
    .map((row) => row.name);

  const tableInfo: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  const foreignKeys: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  const rowCounts: Record<string, number> = {};
  for (const table of userTables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    tableInfo[table] = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA table_info(${quoted})`);
    foreignKeys[table] = yield* sql.unsafe<Record<string, unknown>>(
      `PRAGMA foreign_key_list(${quoted})`,
    );
    if (table !== "effect_sql_migrations") {
      const [countRow] = yield* sql.unsafe<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM ${quoted}`,
      );
      rowCounts[table] = countRow?.count ?? 0;
    }
  }

  const indexInfo: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  for (const row of master) {
    if (row.type === "index") {
      const quoted = `"${row.name.replaceAll('"', '""')}"`;
      indexInfo[row.name] = yield* sql.unsafe<Record<string, unknown>>(
        `PRAGMA index_info(${quoted})`,
      );
    }
  }

  const appliedMigrations = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;

  const seeded = {
    agentBridgeRevision: yield* sql`SELECT id, revision FROM agent_bridge_revision`,
    prHubPublication: yield* sql`SELECT id, revision FROM pr_hub_publication`,
    threadPinState: yield* sql`SELECT singleton_id, revision FROM projection_thread_pin_state`,
    usageMetadata: yield* sql<{
      readonly singleton_id: number;
      readonly coverage_started_at: string;
      readonly fact_cutover_at: string | null;
    }>`SELECT singleton_id, coverage_started_at, fact_cutover_at FROM projection_usage_metadata`,
    scheduledControl: yield* sql<{
      readonly id: number;
      readonly revision: number;
      readonly enabled: number;
      readonly ready: number;
      readonly epoch: number;
      readonly cutover_at: string;
    }>`SELECT id, revision, enabled, ready, epoch, cutover_at FROM scheduled_control`,
  };

  return { master, tableInfo, foreignKeys, indexInfo, rowCounts, appliedMigrations, seeded };
});

describe("squashed baseline schema bootstrap", () => {
  it("runs the baseline fast path on a fresh DB and matches incremental migrations 1..latest identically", async () => {
    const baselineRuntime = ManagedRuntime.make(SqliteClient.layerMemory());
    const incrementalRuntime = ManagedRuntime.make(SqliteClient.layerMemory());
    try {
      const { appliedFirst, appliedSecond, baselineTimestamps, baseline } =
        await baselineRuntime.runPromise(
          Effect.gen(function* () {
            const appliedFirst = yield* applyBaselineSchemaIfFresh;
            const appliedSecond = yield* applyBaselineSchemaIfFresh;
            yield* runMigrations;
            const sql = yield* SqlClient.SqlClient;
            const baselineTimestamps = yield* sql<{ readonly created_at: string }>`
              SELECT DISTINCT created_at FROM effect_sql_migrations
              WHERE migration_id <= ${BASELINE_MIGRATION_ID}
            `;
            const baseline = yield* inspectDatabaseSchema;
            return { appliedFirst, appliedSecond, baselineTimestamps, baseline };
          }),
        );
      const incremental = await incrementalRuntime.runPromise(
        Effect.gen(function* () {
          yield* runIncrementalMigrations;
          return yield* inspectDatabaseSchema;
        }),
      );

      // Explicitly prove the baseline fast path executed once and skipped on re-run.
      expect(appliedFirst).toBe(true);
      expect(appliedSecond).toBe(false);
      expect(baselineTimestamps).toHaveLength(1);

      expect(baseline.master).toEqual(incremental.master);
      expect(baseline.tableInfo).toEqual(incremental.tableInfo);
      expect(baseline.foreignKeys).toEqual(incremental.foreignKeys);
      expect(baseline.indexInfo).toEqual(incremental.indexInfo);
      expect(baseline.rowCounts).toEqual(incremental.rowCounts);
      expect(baseline.appliedMigrations).toEqual(incremental.appliedMigrations);

      expect(baseline.seeded.agentBridgeRevision).toEqual(incremental.seeded.agentBridgeRevision);
      expect(baseline.seeded.prHubPublication).toEqual(incremental.seeded.prHubPublication);
      expect(baseline.seeded.threadPinState).toEqual(incremental.seeded.threadPinState);

      // Compare every non-timestamp column of seeded singleton tables directly against incremental.
      expect(baseline.seeded.usageMetadata).toHaveLength(incremental.seeded.usageMetadata.length);
      expect(baseline.seeded.usageMetadata[0]?.singleton_id).toBe(
        incremental.seeded.usageMetadata[0]?.singleton_id,
      );
      expect(baseline.seeded.usageMetadata[0]?.fact_cutover_at).toBe(
        baseline.seeded.usageMetadata[0]?.coverage_started_at,
      );
      expect(baseline.seeded.usageMetadata[0]?.coverage_started_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );

      expect(baseline.seeded.scheduledControl).toHaveLength(
        incremental.seeded.scheduledControl.length,
      );
      const { cutover_at: baselineCutover, ...baselineControlNonTime } =
        baseline.seeded.scheduledControl[0]!;
      const { cutover_at: _incCutover, ...incrementalControlNonTime } =
        incremental.seeded.scheduledControl[0]!;
      expect(baselineControlNonTime).toEqual(incrementalControlNonTime);
      expect(baselineCutover).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      await baselineRuntime.dispose();
      await incrementalRuntime.dispose();
    }
  });

  it("serializes concurrent fresh-DB baseline bootstraps cleanly inside the IMMEDIATE transaction", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "f5-baseline-race-"));
    const dbPath = join(tempDir, "concurrent.sqlite");
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: dbPath }));
    try {
      const [appliedA, appliedB] = await runtime.runPromise(
        Effect.all([applyBaselineSchemaIfFresh, applyBaselineSchemaIfFresh], {
          concurrency: "unbounded",
        }),
      );
      // Exactly one fiber creates the baseline tables; the other acquires the transaction
      // second, re-checks sqlite_master inside it, and skips the DDL cleanly.
      expect([appliedA, appliedB].filter(Boolean)).toHaveLength(1);
      await runtime.runPromise(
        Effect.all([runMigrations, runMigrations], { concurrency: "unbounded" }),
      );
    } finally {
      await runtime.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  effectIt.effect(
    "applies subsequent migrations cleanly on top of a baseline-bootstrapped DB",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations;
        const nextId = LATEST_MIGRATION_ID + 1;
        expect(LATEST_MIGRATION_ID).toBeGreaterThanOrEqual(BASELINE_MIGRATION_ID);

        const nextMigration = Effect.gen(function* () {
          const db = yield* SqlClient.SqlClient;
          yield* db`CREATE TABLE future_baseline_test (id INTEGER PRIMARY KEY)`;
        });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            ...MIGRATIONS,
            [`${nextId}_FutureBaselineTest`]: nextMigration,
          }),
        });

        expect(
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_baseline_test'`,
        ).toEqual([{ name: "future_baseline_test" }]);
        expect(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = ${nextId}`,
        ).toEqual([{ migration_id: nextId, name: "FutureBaselineTest" }]);
      }).pipe(Effect.provide(SqliteClient.layerMemory()), Effect.scoped),
  );
});
