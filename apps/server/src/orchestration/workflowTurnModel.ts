import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect } from "effect";
import { runtimeCompletionModel } from "./providerTerminalLifecycle.ts";

export function recordEffectiveTurnModel(sql: SqlClient.SqlClient, event: ProviderRuntimeEvent) {
  if (!event.turnId) return Effect.succeed(false);
  const rerouted = event.type === "model.rerouted";
  const model = (
    rerouted
      ? event.payload.toModel
      : event.type === "turn.started"
        ? event.payload?.model
        : event.type === "turn.completed"
          ? runtimeCompletionModel(event)
          : undefined
  )?.trim();
  if (!model) return Effect.succeed(false);
  return sql`
      INSERT INTO workflow_benchmark_turn_models (thread_id, turn_id, model, rerouted, reported_at)
      SELECT ${event.threadId}, ${event.turnId}, ${model}, ${Number(rerouted)}, ${event.createdAt}
      WHERE EXISTS (SELECT 1 FROM provider_turn_deliveries d
        WHERE d.thread_id = ${event.threadId}
          AND (d.provider_turn_id = ${event.turnId} OR d.state IN ('sending','ambiguous'))
          AND json_extract(d.event_json, '$.payload.workflowAttribution') IS NOT NULL)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        model = CASE WHEN excluded.reported_at >= reported_at THEN excluded.model ELSE model END,
        rerouted = MAX(rerouted, excluded.rerouted),
        reported_at = MAX(reported_at, excluded.reported_at)
      RETURNING 1
    `.pipe(Effect.map((rows) => rows.length > 0));
}
