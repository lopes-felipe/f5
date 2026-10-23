import { isKnownProviderKind, UsageTurnFact } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type * as Statement from "effect/unstable/sql/Statement";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  UsageFactRepository,
  type BucketUsageSummaryRow,
  type ScopeUsageSummaryRow,
  type UsageBucketSummaryInput,
  type UsageFactRepositoryShape,
  type UsageScopeTitle,
} from "../Services/UsageFacts.ts";

interface TitleDbRow {
  readonly id: string;
  readonly title: string | null;
  readonly deletedAt: string | null;
  readonly projectId?: string | null;
}

function usageSqlFragments(sql: SqlClient.SqlClient) {
  const legacyProvider = sql`json_extract(e.payload_json, '$.session.providerName')`;
  return {
    // Persisted nullable columns drive field coverage: a reported zero counts
    // as present, and a stored derived total counts as a known total.
    factAggregates: sql`
      f.provider_name AS provider,
      f.model AS model,
      COUNT(*) AS "turnCount",
      SUM(CASE WHEN f.input_tokens IS NOT NULL AND f.output_tokens IS NOT NULL THEN 1 ELSE 0 END)
        AS "estimationEligibleTurnCount",
      SUM(CASE WHEN f.token_provenance <> 'unreported' THEN 1 ELSE 0 END)
        AS "reportedTokenTurnCount",
      COALESCE(SUM(f.input_tokens), 0) AS "inputTokens",
      COALESCE(SUM(f.output_tokens), 0) AS "outputTokens",
      COALESCE(SUM(f.cache_read_tokens), 0) AS "cacheReadTokens",
      COALESCE(SUM(f.cache_write_tokens), 0) AS "cacheWriteTokens",
      COALESCE(SUM(f.total_tokens), 0) AS "totalTokens",
      CASE
        WHEN SUM(CASE WHEN f.provider_cost_usd IS NOT NULL THEN 1 ELSE 0 END) > 0
          THEN SUM(f.provider_cost_usd)
        ELSE NULL
      END AS "providerReportedCostUsd",
      SUM(CASE WHEN f.provider_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS "pricedTurnCount",
      SUM(CASE WHEN f.provider_cost_usd IS NULL THEN 1 ELSE 0 END) AS "unpricedTurnCount",
      COUNT(*) AS "recordedTurnCount",
      0 AS "legacyCostEventCount",
      COUNT(f.input_tokens) AS "inputTokenTurnCount",
      COUNT(f.output_tokens) AS "outputTokenTurnCount",
      COUNT(f.cache_read_tokens) AS "cacheReadTokenTurnCount",
      COUNT(f.cache_write_tokens) AS "cacheWriteTokenTurnCount",
      COUNT(f.total_tokens) AS "totalTokenTurnCount"
    `,
    factPartitions: sql`
      f.provider_name,
      f.model,
      f.provider_cost_usd IS NULL,
      f.token_provenance,
      f.input_tokens IS NOT NULL AND f.output_tokens IS NOT NULL,
      f.total_tokens IS NOT NULL
    `,
    legacyProvider,
    legacyAggregates: sql`
      ${legacyProvider} AS provider,
      NULL AS model,
      COUNT(*) AS "turnCount",
      0 AS "estimationEligibleTurnCount",
      0 AS "reportedTokenTurnCount",
      0 AS "inputTokens",
      0 AS "outputTokens",
      0 AS "cacheReadTokens",
      0 AS "cacheWriteTokens",
      0 AS "totalTokens",
      SUM(CAST(json_extract(e.payload_json, '$.session.turnCostUsd') AS REAL))
        AS "providerReportedCostUsd",
      COUNT(*) AS "pricedTurnCount",
      0 AS "unpricedTurnCount",
      0 AS "recordedTurnCount",
      COUNT(*) AS "legacyCostEventCount",
      0 AS "inputTokenTurnCount",
      0 AS "outputTokenTurnCount",
      0 AS "cacheReadTokenTurnCount",
      0 AS "cacheWriteTokenTurnCount",
      0 AS "totalTokenTurnCount"
    `,
    legacyCostPredicate: sql`
      e.event_type = 'thread.session-set'
      AND json_type(e.payload_json, '$.session.turnCostUsd') IN ('integer', 'real')
      AND CAST(json_extract(e.payload_json, '$.session.turnCostUsd') AS REAL) >= 0
    `,
    legacyThreadId: sql`json_extract(e.payload_json, '$.threadId')`,
  };
}

/**
 * Bucket aggregation statements. Bucket descriptors arrive as parameterized
 * JSON; CROSS JOIN pins the bucket list as the outer loop so every bucket is
 * an indexed range search over unwrapped timestamp columns. Exported so tests
 * can `EXPLAIN QUERY PLAN` the exact statements.
 */
/** `provider` narrows to one provider; `hiddenProviders` leaves providers out. */
function providerFilter(
  sql: SqlClient.SqlClient,
  column: Statement.Fragment,
  input: { readonly provider?: string; readonly hiddenProviders?: ReadonlyArray<string> },
) {
  const only = input.provider ? sql`AND ${column} = ${input.provider}` : sql``;
  const hidden = input.hiddenProviders?.length
    ? sql`AND ${column} NOT IN (SELECT value FROM json_each(${JSON.stringify(input.hiddenProviders)}))`
    : sql``;
  return sql`${only} ${hidden}`;
}

export function makeUsageBucketStatements(
  sql: SqlClient.SqlClient,
  input: UsageBucketSummaryInput,
  factCutoverAt: string,
) {
  const fragments = usageSqlFragments(sql);
  const buckets = JSON.stringify(
    input.buckets.map((bucket) => ({
      key: bucket.key,
      startAt: bucket.startAt,
      endAt: bucket.endAt,
    })),
  );
  const facts = sql<BucketUsageSummaryRow>`
    SELECT
      json_extract(b.value, '$.key') AS "bucketKey",
      ${fragments.factAggregates}
    FROM json_each(${buckets}) AS b
    CROSS JOIN projection_turn_usage_facts AS f
    WHERE f.completed_at >= json_extract(b.value, '$.startAt')
      AND f.completed_at < json_extract(b.value, '$.endAt')
      ${providerFilter(sql, sql`f.provider_name`, input)}
      ${input.projectId ? sql`AND f.project_id = ${input.projectId}` : sql``}
      AND COALESCE(f.recorded_at, f.completed_at) >= ${factCutoverAt}
    GROUP BY "bucketKey", ${fragments.factPartitions}
    ORDER BY "bucketKey" ASC, f.provider_name ASC, f.model ASC
  `;
  const legacy =
    input.buckets.length > 0 && input.buckets[0]!.startAt < factCutoverAt
      ? sql<BucketUsageSummaryRow>`
          SELECT
            json_extract(b.value, '$.key') AS "bucketKey",
            ${fragments.legacyAggregates}
          FROM json_each(${buckets}) AS b
          CROSS JOIN orchestration_events AS e
          WHERE e.occurred_at >= json_extract(b.value, '$.startAt')
            AND e.occurred_at < json_extract(b.value, '$.endAt')
            AND e.occurred_at < ${factCutoverAt}
            AND ${fragments.legacyCostPredicate}
            ${providerFilter(sql, fragments.legacyProvider, input)}
            ${
              input.projectId
                ? sql`AND EXISTS (
                    SELECT 1 FROM projection_threads AS t
                    WHERE t.thread_id = ${fragments.legacyThreadId}
                      AND t.project_id = ${input.projectId}
                  )`
                : sql``
            }
          GROUP BY "bucketKey", ${fragments.legacyProvider}
          ORDER BY "bucketKey" ASC
        `
      : null;
  return { facts, legacy };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fragments = usageSqlFragments(sql);

  const recordQuery = SqlSchema.void({
    Request: UsageTurnFact,
    execute: (fact) => sql`
      INSERT INTO projection_turn_usage_facts (
        turn_id,
        thread_id,
        project_id,
        provider_name,
        provider_instance_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        provider_cost_usd,
        token_provenance,
        cost_provenance,
        completed_at,
        recorded_at,
        source_event_id
      ) VALUES (
        ${fact.turnId},
        ${fact.threadId},
        ${fact.projectId},
        ${fact.provider},
        ${fact.providerInstanceId},
        ${fact.model},
        ${fact.inputTokens},
        ${fact.outputTokens},
        ${fact.cacheReadTokens},
        ${fact.cacheWriteTokens},
        ${fact.totalTokens},
        ${fact.providerReportedCostUsd},
        ${fact.tokenProvenance},
        ${fact.costProvenance},
        ${fact.completedAt},
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        ${fact.sourceEventId}
      )
      ON CONFLICT (turn_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        project_id = excluded.project_id,
        provider_name = excluded.provider_name,
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_tokens = excluded.total_tokens,
        provider_cost_usd = excluded.provider_cost_usd,
        token_provenance = excluded.token_provenance,
        cost_provenance = excluded.cost_provenance,
        completed_at = excluded.completed_at,
        source_event_id = excluded.source_event_id
      WHERE excluded.completed_at >= projection_turn_usage_facts.completed_at
    `,
  });

  const record: UsageFactRepositoryShape["record"] = (fact) =>
    recordQuery(fact).pipe(Effect.mapError(toPersistenceSqlError("UsageFactRepository.record")));

  const readUsageMetadata: UsageFactRepositoryShape["readUsageMetadata"] = sql<{
    readonly coverageStartedAt: string;
    readonly factCutoverAt: string;
  }>`
    SELECT
      coverage_started_at AS "coverageStartedAt",
      COALESCE(fact_cutover_at, coverage_started_at) AS "factCutoverAt"
    FROM projection_usage_metadata
    WHERE singleton_id = 1
  `.pipe(
    Effect.mapError(toPersistenceSqlError("UsageFactRepository.readUsageMetadata")),
    Effect.flatMap((rows) => {
      const metadata = rows[0];
      return metadata?.coverageStartedAt && metadata.factCutoverAt
        ? Effect.succeed(metadata)
        : Effect.fail(toPersistenceSqlError("UsageFactRepository.readUsageMetadata")(null));
    }),
  );

  const readCoverageStartedAt: UsageFactRepositoryShape["readCoverageStartedAt"] =
    readUsageMetadata.pipe(
      Effect.map((metadata) => metadata.coverageStartedAt),
      Effect.mapError(toPersistenceSqlError("UsageFactRepository.readCoverageStartedAt")),
    );

  const summarizeBuckets: UsageFactRepositoryShape["summarizeBuckets"] = (input) =>
    Effect.gen(function* () {
      if (input.buckets.length === 0) return [];
      const { factCutoverAt } = yield* readUsageMetadata;
      const statements = makeUsageBucketStatements(sql, input, factCutoverAt);
      const factRows = yield* statements.facts;
      const legacyRows = statements.legacy ? yield* statements.legacy : [];
      return [...factRows, ...legacyRows].filter(
        (row) => typeof row.bucketKey === "string" && isKnownProviderKind(row.provider),
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("UsageFactRepository.summarizeBuckets")));

  const summarizeByScope: UsageFactRepositoryShape["summarizeByScope"] = (input) =>
    Effect.gen(function* () {
      const { factCutoverAt } = yield* readUsageMetadata;
      const factRows = yield* sql<ScopeUsageSummaryRow>`
        SELECT
          f.thread_id AS "threadId",
          f.project_id AS "projectId",
          ${fragments.factAggregates}
        FROM projection_turn_usage_facts AS f
        WHERE f.completed_at >= ${input.startedAt}
          AND f.completed_at < ${input.endedAt}
          ${providerFilter(sql, sql`f.provider_name`, input)}
          AND COALESCE(f.recorded_at, f.completed_at) >= ${factCutoverAt}
        GROUP BY f.thread_id, f.project_id, ${fragments.factPartitions}
      `;
      const legacyEndedAt = factCutoverAt < input.endedAt ? factCutoverAt : input.endedAt;
      const legacyRows =
        input.startedAt < legacyEndedAt
          ? yield* sql<ScopeUsageSummaryRow>`
              SELECT
                ${fragments.legacyThreadId} AS "threadId",
                t.project_id AS "projectId",
                ${fragments.legacyAggregates}
              FROM orchestration_events AS e
              LEFT JOIN projection_threads AS t ON t.thread_id = ${fragments.legacyThreadId}
              WHERE e.occurred_at >= ${input.startedAt}
                AND e.occurred_at < ${legacyEndedAt}
                AND ${fragments.legacyCostPredicate}
                ${providerFilter(sql, fragments.legacyProvider, input)}
              GROUP BY ${fragments.legacyThreadId}, t.project_id, ${fragments.legacyProvider}
            `
          : [];
      return [...factRows, ...legacyRows]
        .filter((row) => isKnownProviderKind(row.provider))
        .map((row) => ({
          ...row,
          threadId: typeof row.threadId === "string" && row.threadId ? row.threadId : null,
          projectId: typeof row.projectId === "string" && row.projectId ? row.projectId : null,
        }));
    }).pipe(Effect.mapError(toPersistenceSqlError("UsageFactRepository.summarizeByScope")));

  const toTitles = (
    ids: ReadonlyArray<string>,
    rows: ReadonlyArray<TitleDbRow>,
  ): Array<UsageScopeTitle> => {
    const found = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = found.get(id);
      if (!row) return { id, title: null, deleted: true, projectId: null };
      return {
        id,
        title: row.title?.trim() ? row.title.trim() : null,
        deleted: row.deletedAt !== null,
        ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
      };
    });
  };

  const readScopeTitles: UsageFactRepositoryShape["readScopeTitles"] = (input) =>
    Effect.gen(function* () {
      const threadIds = [...new Set(input.threadIds)];
      const projectIds = [...new Set(input.projectIds)];
      const threadRows =
        threadIds.length > 0
          ? yield* sql<TitleDbRow>`
              SELECT
                thread_id AS id,
                title,
                deleted_at AS "deletedAt",
                project_id AS "projectId"
              FROM projection_threads
              WHERE ${sql.in("thread_id", threadIds)}
            `
          : [];
      const projectRows =
        projectIds.length > 0
          ? yield* sql<TitleDbRow>`
              SELECT project_id AS id, title, deleted_at AS "deletedAt"
              FROM projection_projects
              WHERE ${sql.in("project_id", projectIds)}
            `
          : [];
      return {
        threads: toTitles(threadIds, threadRows),
        projects: toTitles(projectIds, projectRows),
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("UsageFactRepository.readScopeTitles")));

  return {
    record,
    readCoverageStartedAt,
    readUsageMetadata,
    summarizeBuckets,
    summarizeByScope,
    readScopeTitles,
  } satisfies UsageFactRepositoryShape;
});

export const UsageFactRepositoryLive = Layer.effect(UsageFactRepository, make);
