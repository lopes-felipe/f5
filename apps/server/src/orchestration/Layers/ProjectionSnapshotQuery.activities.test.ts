import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MAX_READ_MODEL_ACTIVITIES, MAX_THREAD_ACTIVITIES } from "../readModelRetention.ts";
import { retainedThreadActivitiesSql } from "./ProjectionSnapshotQuery.ts";

/** The query before the rank index, kept verbatim as the equivalence oracle. */
const previousRetainedThreadActivitiesSql = (sql: SqlClient.SqlClient, threadId: ThreadId | null) =>
  sql`
        WITH ranked_activities AS (
          SELECT
            activity_id AS "activityId",
            thread_id AS "threadId",
            turn_id AS "turnId",
            tone,
            kind,
            summary,
            payload_json AS "payload",
            sequence,
            created_at AS "createdAt",
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS row_number
          FROM projection_thread_activities
        WHERE ${threadId === null ? sql`thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL)` : sql`thread_id = ${threadId}`}
        ),
        bounded_activities AS (
          SELECT *
          FROM ranked_activities
          WHERE row_number <= ${MAX_THREAD_ACTIVITIES}
          ORDER BY
            row_number ASC,
            (sequence IS NULL) ASC,
            sequence DESC,
            "createdAt" DESC,
            "activityId" DESC
          -- Fetch one sentinel row so the caller can report when the global
          -- materialization budget truncated retained history.
          LIMIT ${MAX_READ_MODEL_ACTIVITIES + 1}
        )
        SELECT
          "activityId",
          "threadId",
          "turnId",
          tone,
          kind,
          summary,
          "payload",
          sequence,
          "createdAt"
        FROM bounded_activities
        ORDER BY
          "threadId" ASC,
          sequence ASC,
          "createdAt" ASC,
          "activityId" ASC
      `;

const insertThreads = (sql: SqlClient.SqlClient, count: number, prefix: string, deleted = false) =>
  sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO projection_threads (
      thread_id, project_id, title, model, created_at, last_interaction_at, updated_at, deleted_at
    )
    SELECT ${prefix} || i, 'project-1', 'Thread', 'gpt-5-codex', '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      ${deleted ? "2026-10-02T00:00:00.000Z" : null}
    FROM n
  `;

/**
 * `perThread` activities for every thread whose id starts with `prefix`. Every
 * seventh row has a NULL sequence, sequences repeat in pairs and timestamps in
 * threes, so ties fall through to `activity_id`.
 */
const insertActivities = (sql: SqlClient.SqlClient, prefix: string, perThread: number) =>
  sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${perThread})
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    SELECT
      thread_id || ':' || printf('%04d', (i * 37) % 1009),
      thread_id,
      'turn-' || (i / 10),
      'info',
      'tool.completed',
      'Step ' || i,
      json_object('step', i),
      CASE WHEN i % 7 = 0 THEN NULL ELSE i / 2 END,
      '2026-10-01T00:00:' || printf('%02d', (i / 3) % 60) || '.000Z'
    FROM projection_threads, n
    WHERE thread_id LIKE ${prefix} || '%'
  `;

const expectEquivalent = (sql: SqlClient.SqlClient, threadId: ThreadId | null) =>
  Effect.gen(function* () {
    const previous = yield* previousRetainedThreadActivitiesSql(sql, threadId);
    const current = yield* retainedThreadActivitiesSql(sql, threadId);
    assert.deepStrictEqual(current, previous);
    return current.length;
  });

it.layer(SqlitePersistenceMemory)("retained thread activities query", (it) => {
  it.effect("returns the same ordered rows as the previous query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThreads(sql, 2, "live-");
      yield* insertThreads(sql, 1, "gone-", true);
      yield* insertActivities(sql, "live-1", MAX_THREAD_ACTIVITIES + 50);
      yield* insertActivities(sql, "live-2", 20);
      yield* insertActivities(sql, "gone-", MAX_THREAD_ACTIVITIES + 5);

      // The deleted thread is excluded from the all-threads read.
      assert.strictEqual(yield* expectEquivalent(sql, null), MAX_THREAD_ACTIVITIES + 20);
      assert.strictEqual(
        yield* expectEquivalent(sql, ThreadId.makeUnsafe("live-1")),
        MAX_THREAD_ACTIVITIES,
      );
      assert.strictEqual(yield* expectEquivalent(sql, ThreadId.makeUnsafe("live-2")), 20);
      assert.strictEqual(
        yield* expectEquivalent(sql, ThreadId.makeUnsafe("gone-1")),
        MAX_THREAD_ACTIVITIES,
      );
      assert.strictEqual(yield* expectEquivalent(sql, ThreadId.makeUnsafe("missing")), 0);
    }),
  );

  it.effect(
    "keeps the global budget's sentinel row",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = Math.ceil((MAX_READ_MODEL_ACTIVITIES + 1) / MAX_THREAD_ACTIVITIES) + 1;
        yield* insertThreads(sql, threads, "budget-");
        yield* insertActivities(sql, "budget-", MAX_THREAD_ACTIVITIES + 1);

        assert.strictEqual(yield* expectEquivalent(sql, null), MAX_READ_MODEL_ACTIVITIES + 1);
      }),
    120_000,
  );

  it.effect("ranks from the covering index without sorting the window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const threadId of [null, ThreadId.makeUnsafe("live-1")]) {
        const statement = retainedThreadActivitiesSql(sql, threadId);
        const [query, params] = statement.compile();
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
        const details = plan.map((row) => row.detail);
        assert.isTrue(
          details.some((detail) =>
            detail.includes("COVERING INDEX idx_projection_thread_activities_thread_rank"),
          ),
          details.join("\n"),
        );
        // Only the budget and final orderings sort; the window reads index order.
        assert.isAtMost(
          details.filter((detail) => detail.includes("TEMP B-TREE")).length,
          2,
          details.join("\n"),
        );
      }
    }),
  );
});
