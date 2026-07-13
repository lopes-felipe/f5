import {
  type GlobalSearchQueryInput,
  type GlobalSearchQueryResult,
  type GlobalSearchResult,
  type GlobalSearchResultKind,
  MessageId,
  OrchestrationFileChangeId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface SearchRow {
  readonly documentKey: string;
  readonly kind: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threadId: string | null;
  readonly workflowId: string | null;
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly fileChangeId: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly rawPath: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly providerInstanceId: string | null;
  readonly status: string | null;
  readonly createdAt: string;
  readonly rank: number;
}

function buildFtsQuery(query: string): string | null {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((token) => token.length > 0)
    .slice(0, 12);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function resolveMatchedPath(rawPath: string, query: string): string | null {
  if (!rawPath) return null;
  try {
    const paths = JSON.parse(rawPath) as unknown;
    if (!Array.isArray(paths)) return rawPath;
    const validPaths = paths.filter((path): path is string => typeof path === "string");
    const normalizedTokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    return (
      validPaths.find((path) =>
        normalizedTokens.some((token) => path.toLowerCase().includes(token)),
      ) ??
      validPaths[0] ??
      null
    );
  } catch {
    return rawPath;
  }
}

function decodeRow(row: SearchRow, query: string): GlobalSearchResult {
  const kind = row.kind as GlobalSearchResultKind;
  const path = kind === "fileChange" ? resolveMatchedPath(row.rawPath, query) : null;
  const title =
    kind === "fileChange" && path ? path.split("/").filter(Boolean).at(-1) || row.title : row.title;
  return {
    documentKey: row.documentKey,
    kind,
    projectId: ProjectId.makeUnsafe(row.projectId),
    projectTitle: row.projectTitle,
    threadId: row.threadId ? ThreadId.makeUnsafe(row.threadId) : null,
    workflowId: row.workflowId,
    messageId: row.messageId ? MessageId.makeUnsafe(row.messageId) : null,
    turnId: row.turnId ? TurnId.makeUnsafe(row.turnId) : null,
    fileChangeId: row.fileChangeId ? OrchestrationFileChangeId.makeUnsafe(row.fileChangeId) : null,
    title,
    snippet: row.snippet,
    path,
    role: row.role,
    model: row.model,
    providerInstanceId: row.providerInstanceId,
    status: row.status,
    createdAt: row.createdAt,
    rank: row.rank,
  };
}

export interface GlobalSearchService {
  readonly query: (
    input: GlobalSearchQueryInput,
  ) => Effect.Effect<GlobalSearchQueryResult, SqlError>;
}

export const makeGlobalSearch: Effect.Effect<GlobalSearchService, never, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return {
      query: (input) => {
        const ftsQuery = buildFtsQuery(input.query);
        if (!ftsQuery) return Effect.succeed({ results: [] });
        const projectId = input.projectId ?? null;
        const providerInstanceId = input.providerInstanceId ?? null;
        const model = input.model ?? null;
        const status = input.status ?? null;
        const dateFrom = input.dateFrom ?? null;
        const dateTo = input.dateTo ?? null;
        const includeArchived = input.includeArchived ? 1 : 0;
        const limit = input.limit ?? 24;

        return sql<SearchRow>`
          SELECT
            document.document_key AS "documentKey",
            document.kind,
            document.project_id AS "projectId",
            project.title AS "projectTitle",
            document.thread_id AS "threadId",
            document.workflow_id AS "workflowId",
            document.message_id AS "messageId",
            document.turn_id AS "turnId",
            document.file_change_id AS "fileChangeId",
            CASE
              WHEN document.kind = 'message' THEN coalesce(thread.title, document.title)
              ELSE document.title
            END AS title,
            CASE
              WHEN length(trim(snippet(search_documents_fts, 1, '', '', ' … ', 18))) > 0
                THEN snippet(search_documents_fts, 1, '', '', ' … ', 18)
              WHEN length(document.path) > 0 THEN document.path
              ELSE document.title
            END AS snippet,
            document.path AS "rawPath",
            document.role,
            thread.model,
            coalesce(session.provider_instance_id, session.provider_name) AS "providerInstanceId",
            session.status,
            document.created_at AS "createdAt",
            bm25(search_documents_fts, 5.0, 1.0, 2.5) AS rank
          FROM search_documents_fts
          JOIN search_documents AS document ON document.rowid = search_documents_fts.rowid
          JOIN projection_projects AS project ON project.project_id = document.project_id
          LEFT JOIN projection_threads AS thread ON thread.thread_id = document.thread_id
          LEFT JOIN projection_thread_sessions AS session ON session.thread_id = document.thread_id
          WHERE search_documents_fts MATCH ${ftsQuery}
            AND project.deleted_at IS NULL
            AND (document.thread_id IS NULL OR thread.deleted_at IS NULL)
            AND (${includeArchived} OR document.thread_id IS NULL OR thread.archived_at IS NULL)
            AND (${projectId} IS NULL OR document.project_id = ${projectId})
            AND (
              ${providerInstanceId} IS NULL
              OR coalesce(session.provider_instance_id, session.provider_name) = ${providerInstanceId}
            )
            AND (${model} IS NULL OR thread.model = ${model})
            AND (${status} IS NULL OR session.status = ${status})
            AND (${dateFrom} IS NULL OR document.created_at >= ${dateFrom})
            AND (${dateTo} IS NULL OR document.created_at <= ${dateTo})
          ORDER BY document.created_at DESC, rank ASC, document.document_key ASC
          LIMIT ${limit}
        `.pipe(Effect.map((rows) => ({ results: rows.map((row) => decodeRow(row, input.query)) })));
      },
    };
  });
