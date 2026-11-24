import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [eventLog] = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'
  `;
  if (!eventLog) return;
  const suffix = ":thread-session-capabilities-turn";

  // Repair only totals fully explained by usage facts plus a verified duplicate
  // snapshot of the same completion. Store the correction in the event log so
  // rebuilding the workflow projections produces the same total.
  yield* sql`
    WITH duplicates AS MATERIALIZED (
      SELECT DISTINCT f.thread_id, f.turn_id, f.project_id
      FROM orchestration_events d
      JOIN orchestration_events c
        ON c.command_id = substr(d.command_id, 1, length(d.command_id) - length(${suffix}))
          || ':thread-session-set'
        AND c.event_type = 'thread.session-set'
        AND c.stream_id = d.stream_id
        AND c.sequence < d.sequence
      JOIN projection_turn_usage_facts f
        ON f.thread_id = c.stream_id
        AND f.turn_id = json_extract(c.payload_json, '$.settledTurnId')
        AND f.provider_name = 'claudeAgent'
        AND f.provider_cost_usd = json_extract(c.payload_json, '$.session.turnCostUsd')
      WHERE d.event_type = 'thread.session-set'
        AND substr(d.command_id, -length(${suffix})) = ${suffix}
        AND json_extract(d.payload_json, '$.settledTurnId') IS NULL
        AND f.provider_cost_usd > 0
        AND f.provider_cost_usd = json_extract(d.payload_json, '$.session.turnCostUsd')
    ), candidates AS MATERIALIZED (
      SELECT 'project.workflow-upserted' AS event_type, workflow_id, project_id, workflow_json
      FROM projection_planning_workflows
      WHERE deleted_at IS NULL AND project_id IN (SELECT project_id FROM duplicates)
      UNION ALL
      SELECT 'project.code-review-workflow-upserted', workflow_id, project_id, workflow_json
      FROM projection_code_review_workflows
      WHERE deleted_at IS NULL AND project_id IN (SELECT project_id FROM duplicates)
      UNION ALL
      SELECT 'project.investigation-workflow-upserted', workflow_id, project_id, workflow_json
      FROM projection_investigation_workflows
      WHERE deleted_at IS NULL AND project_id IN (SELECT project_id FROM duplicates)
    ), owned_threads AS (
      SELECT DISTINCT w.event_type, w.workflow_id, w.project_id, j.value AS thread_id
      FROM candidates w, json_tree(w.workflow_json) j
      WHERE j.type = 'text' AND (
        (w.event_type = 'project.workflow-upserted' AND (
          j.fullkey IN ('$.branchA.authorThreadId', '$.branchB.authorThreadId',
            '$.merge.threadId', '$.implementation.threadId', '$.readerPass.readerThreadId')
          OR j.fullkey GLOB '$.branchA.reviews[[]*].threadId'
          OR j.fullkey GLOB '$.branchB.reviews[[]*].threadId'
          OR j.fullkey GLOB '$.implementation.codeReviews[[]*].threadId'
          OR j.fullkey GLOB '$.readerPass.previousReaderThreadIds[[]*]'
        ))
        OR (w.event_type = 'project.code-review-workflow-upserted' AND j.fullkey IN (
          '$.reviewerA.threadId', '$.reviewerB.threadId', '$.consolidation.threadId'
        ))
        OR (w.event_type = 'project.investigation-workflow-upserted' AND j.fullkey IN (
          '$.investigatorA.threadId', '$.investigatorA.crossReviewThreadId', '$.investigatorA.selfReviewThreadId',
          '$.investigatorB.threadId', '$.investigatorB.crossReviewThreadId', '$.investigatorB.selfReviewThreadId',
          '$.synthesis.threadId'
        ))
      )
    ), sums AS (
      SELECT t.event_type, t.workflow_id, t.project_id,
        round(sum(f.provider_cost_usd), 6) AS billed,
        round(sum(CASE WHEN d.turn_id IS NOT NULL THEN f.provider_cost_usd ELSE 0 END), 6) AS duplicate
      FROM owned_threads t
      JOIN projection_turn_usage_facts f ON f.thread_id = t.thread_id AND f.project_id = t.project_id
      LEFT JOIN duplicates d ON d.thread_id = f.thread_id AND d.turn_id = f.turn_id
      WHERE f.provider_cost_usd > 0
      GROUP BY t.event_type, t.workflow_id, t.project_id
    ), repairs AS (
      SELECT w.*, s.billed, 'workflow-cost-repair:' || w.event_type || ':' || w.workflow_id AS repair_id
      FROM candidates w
      JOIN sums s USING (event_type, workflow_id, project_id)
      WHERE s.duplicate > 0
        AND round(json_extract(w.workflow_json, '$.totalCostUsd'), 6) = round(s.billed + s.duplicate, 6)
    ), pending AS (
      SELECT r.*,
        (SELECT coalesce(max(e.stream_version), 0)
          FROM orchestration_events e WHERE e.aggregate_kind = 'project' AND e.stream_id = r.project_id)
        + row_number() OVER (PARTITION BY r.project_id ORDER BY r.event_type, r.workflow_id) AS version
      FROM repairs r
      WHERE NOT EXISTS (SELECT 1 FROM orchestration_events e WHERE e.event_id = r.repair_id)
    )
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    )
    SELECT repair_id, 'project', project_id, version, event_type,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'system',
      json_object('projectId', project_id, 'workflow', json_set(workflow_json, '$.totalCostUsd', billed)),
      '{}'
    FROM pending
  `;
});
