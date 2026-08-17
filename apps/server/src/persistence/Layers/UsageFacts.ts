import { isKnownProviderKind, UsageTurnFact } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  UsageFactRepository,
  type HourlyUsageFactSummary,
  type UsageFactRepositoryShape,
} from "../Services/UsageFacts.ts";

interface HourlyUsageDbRow {
  readonly hourStartedAt: string;
  readonly provider: string;
  readonly model: string | null;
  readonly turnCount: number;
  readonly reportedTokenTurnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly providerReportedCostUsd: number | null;
  readonly pricedTurnCount: number;
  readonly unpricedTurnCount: number;
  readonly historicalCostTurnCount: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  const readCoverageStartedAt: UsageFactRepositoryShape["readCoverageStartedAt"] = sql<{
    readonly coverageStartedAt: string;
  }>`
    SELECT coverage_started_at AS "coverageStartedAt"
    FROM projection_usage_metadata
    WHERE singleton_id = 1
  `.pipe(
    Effect.mapError(toPersistenceSqlError("UsageFactRepository.readCoverageStartedAt")),
    Effect.flatMap((rows) =>
      rows[0]?.coverageStartedAt
        ? Effect.succeed(rows[0].coverageStartedAt)
        : Effect.fail(toPersistenceSqlError("UsageFactRepository.readCoverageStartedAt")(null)),
    ),
  );

  const summarizeHourly: UsageFactRepositoryShape["summarizeHourly"] = (input) =>
    Effect.gen(function* () {
      const coverageStartedAt = yield* readCoverageStartedAt;
      const factStartedAt =
        coverageStartedAt > input.startedAt ? coverageStartedAt : input.startedAt;
      const factRows = yield* sql<HourlyUsageDbRow>`
        SELECT
          strftime('%Y-%m-%dT%H:00:00.000Z', completed_at) AS "hourStartedAt",
          provider_name AS provider,
          model,
          COUNT(*) AS "turnCount",
          SUM(CASE WHEN token_provenance <> 'unreported' THEN 1 ELSE 0 END)
            AS "reportedTokenTurnCount",
          COALESCE(SUM(input_tokens), 0) AS "inputTokens",
          COALESCE(SUM(output_tokens), 0) AS "outputTokens",
          COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
          COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
          COALESCE(SUM(total_tokens), 0) AS "totalTokens",
          CASE
            WHEN SUM(CASE WHEN provider_cost_usd IS NOT NULL THEN 1 ELSE 0 END) > 0
              THEN SUM(provider_cost_usd)
            ELSE NULL
          END AS "providerReportedCostUsd",
          SUM(CASE WHEN provider_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS "pricedTurnCount",
          SUM(CASE WHEN provider_cost_usd IS NULL THEN 1 ELSE 0 END) AS "unpricedTurnCount",
          0 AS "historicalCostTurnCount"
        FROM projection_turn_usage_facts
        WHERE completed_at >= ${factStartedAt} AND completed_at < ${input.endedAt}
        GROUP BY hourStartedAt, provider_name, model
        ORDER BY hourStartedAt ASC, provider_name ASC, model ASC
      `;

      const legacyEndedAt = coverageStartedAt < input.endedAt ? coverageStartedAt : input.endedAt;
      const legacyRows =
        input.startedAt < legacyEndedAt
          ? yield* sql<HourlyUsageDbRow>`
              SELECT
                strftime('%Y-%m-%dT%H:00:00.000Z', occurred_at) AS "hourStartedAt",
                json_extract(payload_json, '$.session.providerName') AS provider,
                NULL AS model,
                COUNT(*) AS "turnCount",
                0 AS "reportedTokenTurnCount",
                0 AS "inputTokens",
                0 AS "outputTokens",
                0 AS "cacheReadTokens",
                0 AS "cacheWriteTokens",
                0 AS "totalTokens",
                SUM(CAST(json_extract(payload_json, '$.session.turnCostUsd') AS REAL))
                  AS "providerReportedCostUsd",
                COUNT(*) AS "pricedTurnCount",
                0 AS "unpricedTurnCount",
                COUNT(*) AS "historicalCostTurnCount"
              FROM orchestration_events
              WHERE
                event_type = 'thread.session-set'
                AND occurred_at >= ${input.startedAt}
                AND occurred_at < ${legacyEndedAt}
                AND json_type(payload_json, '$.session.turnCostUsd') IN ('integer', 'real')
                AND CAST(json_extract(payload_json, '$.session.turnCostUsd') AS REAL) >= 0
              GROUP BY hourStartedAt, provider
              ORDER BY hourStartedAt ASC, provider ASC
            `
          : [];

      return [...factRows, ...legacyRows].filter(
        (row): row is HourlyUsageFactSummary =>
          typeof row.hourStartedAt === "string" && isKnownProviderKind(row.provider),
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("UsageFactRepository.summarizeHourly")));

  return { record, readCoverageStartedAt, summarizeHourly } satisfies UsageFactRepositoryShape;
});

export const UsageFactRepositoryLive = Layer.effect(UsageFactRepository, make);
