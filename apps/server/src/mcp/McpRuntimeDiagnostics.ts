import { type McpServerStartupStatus, ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export interface McpRuntimeServerDiagnostic {
  readonly name: string;
  readonly status: McpServerStartupStatus;
  readonly message?: string;
  readonly createdAt: string;
}

export const ListLatestMcpRuntimeDiagnosticsInput = Schema.Struct({
  projectId: ProjectId,
  provider: Schema.String,
  configVersion: Schema.optional(Schema.String),
});
export type ListLatestMcpRuntimeDiagnosticsInput = typeof ListLatestMcpRuntimeDiagnosticsInput.Type;

const LatestMcpRuntimeDiagnosticRow = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export interface McpRuntimeDiagnosticsShape {
  readonly listLatestServerDiagnostics: (
    input: ListLatestMcpRuntimeDiagnosticsInput,
  ) => Effect.Effect<ReadonlyArray<McpRuntimeServerDiagnostic>>;
}

export class McpRuntimeDiagnostics extends ServiceMap.Service<
  McpRuntimeDiagnostics,
  McpRuntimeDiagnosticsShape
>()("t3/mcp/McpRuntimeDiagnostics") {}

function asMcpStartupStatus(value: string): McpServerStartupStatus | undefined {
  switch (value) {
    case "starting":
    case "ready":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function normalizeMcpRuntimeDiagnosticName(name: string): string {
  return name.trim().toLowerCase();
}

export function indexMcpRuntimeServerDiagnostics(
  diagnostics: ReadonlyArray<McpRuntimeServerDiagnostic>,
): ReadonlyMap<string, McpRuntimeServerDiagnostic> {
  return new Map(
    diagnostics.map((diagnostic) => [
      normalizeMcpRuntimeDiagnosticName(diagnostic.name),
      diagnostic,
    ]),
  );
}

export function compactMcpRuntimeDiagnosticMessage(message: string): string | undefined {
  let compacted = message.trim();
  if (compacted.length === 0) {
    return undefined;
  }

  for (;;) {
    const next = compacted
      .replace(/^MCP client for `[^`]+` failed to start:\s*/u, "")
      .replace(/^MCP startup failed:\s*/u, "")
      .replace(/^handshaking with MCP server failed:\s*/u, "")
      .replace(/^Send message error\s*/u, "")
      .replace(/^Transport \[[^\]]+\] error:\s*/u, "")
      .replace(/^Auth error:\s*/u, "")
      .trim();

    if (next === compacted) {
      return compacted || undefined;
    }
    compacted = next;
  }
}

const makeMcpRuntimeDiagnostics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listLatestRows = SqlSchema.findAll({
    Request: ListLatestMcpRuntimeDiagnosticsInput,
    Result: LatestMcpRuntimeDiagnosticRow,
    execute: ({ projectId, provider, configVersion }) =>
      sql`
        WITH runtime_threads AS (
          SELECT thread_id
          FROM provider_session_runtime
          WHERE project_id = ${projectId}
            AND provider_name = ${provider}
            AND status = 'running'
            AND (${configVersion ?? null} IS NULL OR mcp_config_version = ${configVersion ?? null})
        ),
        ranked_mcp_statuses AS (
          SELECT
            json_extract(activity.payload_json, '$.name') AS name,
            json_extract(activity.payload_json, '$.status') AS status,
            json_extract(activity.payload_json, '$.error') AS error,
            json_extract(activity.payload_json, '$.detail') AS detail,
            activity.created_at AS "createdAt",
            ROW_NUMBER() OVER (
              PARTITION BY lower(json_extract(activity.payload_json, '$.name'))
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS row_number
          FROM projection_thread_activities AS activity
          JOIN runtime_threads ON runtime_threads.thread_id = activity.thread_id
          WHERE activity.kind = 'mcp.status.updated'
            AND json_type(activity.payload_json, '$.name') = 'text'
            AND json_type(activity.payload_json, '$.status') = 'text'
        )
        SELECT
          name,
          status,
          error,
          detail,
          "createdAt"
        FROM ranked_mcp_statuses
        WHERE row_number = 1
      `,
  });

  const listLatestServerDiagnostics: McpRuntimeDiagnosticsShape["listLatestServerDiagnostics"] = (
    input,
  ) =>
    listLatestRows(input).pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const status = asMcpStartupStatus(row.status);
          if (!status) {
            return [];
          }

          const rawMessage = row.error?.trim() || row.detail?.trim() || undefined;
          const message = rawMessage ? compactMcpRuntimeDiagnosticMessage(rawMessage) : undefined;
          return [
            {
              name: row.name,
              status,
              ...(message ? { message } : {}),
              createdAt: row.createdAt,
            },
          ];
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load latest MCP runtime diagnostics.", {
          cause,
          provider: input.provider,
          projectId: input.projectId,
        }).pipe(Effect.as([])),
      ),
    );

  return {
    listLatestServerDiagnostics,
  } satisfies McpRuntimeDiagnosticsShape;
});

export const McpRuntimeDiagnosticsLive = Layer.effect(
  McpRuntimeDiagnostics,
  makeMcpRuntimeDiagnostics,
);
