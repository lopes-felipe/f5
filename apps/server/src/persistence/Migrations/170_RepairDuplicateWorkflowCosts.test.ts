import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqlite from "../NodeSqliteClient.ts";
import repair from "./170_RepairDuplicateWorkflowCosts.ts";

const at = "2026-11-23T00:00:00.000Z";

it.layer(NodeSqlite.layerMemory())("workflow cost repair", (it) => {
  it.effect("appends one replayable correction for proven duplicate costs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations;
      for (const [id, cost] of [
        ["double", 0.5],
        ["ambiguous", 0.6],
      ] as const) {
        const workflow = JSON.stringify({
          id,
          projectId: "project",
          branchA: { reviews: [{ threadId: id }] },
          totalCostUsd: cost,
        });
        yield* sql`
          INSERT INTO projection_planning_workflows (workflow_id, project_id, workflow_json, updated_at)
          VALUES (${id}, 'project', ${workflow}, ${at})
        `;
        yield* sql`
          INSERT INTO projection_turn_usage_facts
            (turn_id, thread_id, project_id, provider_name, provider_cost_usd, token_provenance,
              cost_provenance, completed_at, recorded_at, source_event_id)
          VALUES (${id}, ${id}, 'project', 'claudeAgent', 0.25, 'unreported', 'provider-reported',
            ${at}, ${at}, ${"turn-" + id})
        `;
        yield* sql`
          INSERT INTO orchestration_events
            (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id,
              actor_kind, payload_json, metadata_json)
          VALUES
            (${"terminal-" + id}, 'thread', ${id}, 1, 'thread.session-set', ${at},
              ${"provider:" + id + ":thread-session-set"}, 'system',
              json_object('settledTurnId', ${id}, 'session', json_object('turnCostUsd', 0.25)), '{}'),
            (${"capabilities-" + id}, 'thread', ${id}, 2, 'thread.session-set', ${at},
              ${"provider:" + id + ":thread-session-capabilities-turn"}, 'system',
              '{"session":{"turnCostUsd":0.25}}', '{}')
        `;
      }
      yield* sql`
        INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind,
            payload_json, metadata_json)
        VALUES ('project-old', 'project', 'project', 7, 'project.workflow-upserted', ${at}, 'system', '{}', '{}')
      `;

      yield* repair;
      yield* repair;

      const rows = yield* sql`
        SELECT stream_version AS version, event_type AS type,
          json_extract(payload_json, '$.workflow.id') AS workflow,
          json_extract(payload_json, '$.workflow.totalCostUsd') AS totalCostUsd
        FROM orchestration_events WHERE event_id LIKE 'workflow-cost-repair:%'
      `;
      expect(rows).toEqual([
        { version: 8, type: "project.workflow-upserted", workflow: "double", totalCostUsd: 0.25 },
      ]);
    }),
  );
});
