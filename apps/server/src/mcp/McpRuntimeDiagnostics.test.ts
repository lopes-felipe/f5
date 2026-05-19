import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { McpRuntimeDiagnostics, McpRuntimeDiagnosticsLive } from "./McpRuntimeDiagnostics.ts";

const diagnosticsLayer = it.layer(
  McpRuntimeDiagnosticsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

diagnosticsLayer("McpRuntimeDiagnostics", (it) => {
  it.effect("returns latest MCP status details for active sessions on the current config", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM provider_session_runtime`;

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          project_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          mcp_config_version,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES
          (
            'thread-current',
            'project-1',
            'codex',
            'codex',
            'full-access',
            'running',
            '2026-05-18T20:05:00.000Z',
            'mcp-v2',
            NULL,
            NULL
          ),
          (
            'thread-stale',
            'project-1',
            'codex',
            'codex',
            'full-access',
            'running',
            '2026-05-18T20:05:00.000Z',
            'mcp-v1',
            NULL,
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-starting',
            'thread-current',
            NULL,
            'info',
            'mcp.status.updated',
            'MCP server Observability: starting',
            '{"name":"Observability","status":"starting"}',
            NULL,
            '2026-05-18T20:05:20.000Z'
          ),
          (
            'activity-failed',
            'thread-current',
            NULL,
            'error',
            'mcp.status.updated',
            'MCP server Observability: failed',
            '{"name":"Observability","status":"failed","error":"MCP startup failed: handshaking with MCP server failed: Send message error Transport [rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker>] error: Auth error: OAuth token refresh failed: Failed to parse server response, when send initialize request"}',
            NULL,
            '2026-05-18T20:05:24.000Z'
          ),
          (
            'activity-stale',
            'thread-stale',
            NULL,
            'error',
            'mcp.status.updated',
            'MCP server Observability: failed',
            '{"name":"Observability","status":"failed","error":"Stale failure"}',
            NULL,
            '2026-05-18T20:05:25.000Z'
          )
      `;

      const service = yield* McpRuntimeDiagnostics;
      const diagnostics = yield* service.listLatestServerDiagnostics({
        projectId: ProjectId.makeUnsafe("project-1"),
        provider: "codex",
        configVersion: "mcp-v2",
      });

      assert.strictEqual(diagnostics.length, 1);
      assert.deepStrictEqual(diagnostics[0], {
        name: "Observability",
        status: "failed",
        message:
          "OAuth token refresh failed: Failed to parse server response, when send initialize request",
        createdAt: "2026-05-18T20:05:24.000Z",
      });
    }),
  );
});
