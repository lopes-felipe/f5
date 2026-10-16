/**
 * SQL persistence for the Agent Bridge: clients, idempotency receipts, the
 * threads each client created, and the workspace revision.
 *
 * @module agentBridge/AgentBridgeStore
 */
import {
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  AGENT_BRIDGE_LOCAL_CLIENT_NAME,
  AGENT_BRIDGE_SCOPES,
  type AgentBridgeClientKind,
  type AgentBridgeScope,
} from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class AgentBridgeStoreError extends Data.TaggedError("AgentBridgeStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Agent Bridge storage failed during ${this.operation}.`;
  }
}

export interface AgentBridgeClientRecord {
  readonly id: string;
  readonly kind: AgentBridgeClientKind;
  readonly name: string;
  readonly label: string | null;
  readonly scopes: ReadonlyArray<AgentBridgeScope>;
  /** The client's own allowlist. The local client's is empty: it sees every exposed project. */
  readonly projectIds: ReadonlyArray<string>;
  readonly grantGeneration: number;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  /** Exact redirect URIs registered for an OAuth client. */
  readonly redirectUris: ReadonlyArray<string>;
}

export interface AgentBridgeRequestRecord {
  readonly namespace: string;
  readonly requestId: string;
  readonly tool: string;
  readonly argsHash: string;
  readonly command: unknown;
  readonly relatedIds: Readonly<Record<string, string>>;
  readonly result: unknown;
  readonly status: "pending" | "completed";
  readonly createdAt: string;
}

interface ClientRow {
  readonly id: string;
  readonly kind: AgentBridgeClientKind;
  readonly name: string;
  readonly label: string | null;
  readonly scopes_json: string;
  readonly project_ids_json: string;
  readonly grant_generation: number;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly redirect_uris_json: string;
}

interface RequestRow {
  readonly namespace: string;
  readonly request_id: string;
  readonly tool: string;
  readonly args_hash: string;
  readonly command_json: string | null;
  readonly related_ids_json: string;
  readonly result_json: string | null;
  readonly status: "pending" | "completed";
  readonly created_at: string;
}

const parseJson = <A>(value: string | null, fallback: A): A => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

const toClient = (row: ClientRow): AgentBridgeClientRecord => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  label: row.label,
  scopes: parseJson<string[]>(row.scopes_json, []).filter((scope): scope is AgentBridgeScope =>
    (AGENT_BRIDGE_SCOPES as ReadonlyArray<string>).includes(scope),
  ),
  projectIds: parseJson<string[]>(row.project_ids_json, []),
  grantGeneration: row.grant_generation,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  redirectUris: parseJson<string[]>(row.redirect_uris_json, []),
});

const toRequest = (row: RequestRow): AgentBridgeRequestRecord => ({
  namespace: row.namespace,
  requestId: row.request_id,
  tool: row.tool,
  argsHash: row.args_hash,
  command: parseJson<unknown>(row.command_json, null),
  relatedIds: parseJson<Record<string, string>>(row.related_ids_json, {}),
  result: parseJson<unknown>(row.result_json, null),
  status: row.status,
  createdAt: row.created_at,
});

export interface AgentBridgeStore {
  /** Creates the fixed local client on first use. */
  readonly ensureLocalClient: Effect.Effect<void, AgentBridgeStoreError>;
  readonly listClients: Effect.Effect<
    ReadonlyArray<AgentBridgeClientRecord>,
    AgentBridgeStoreError
  >;
  readonly getClient: (
    id: string,
  ) => Effect.Effect<AgentBridgeClientRecord | null, AgentBridgeStoreError>;
  readonly touchClient: (id: string, at: string) => Effect.Effect<void, AgentBridgeStoreError>;
  readonly getRevision: Effect.Effect<number, AgentBridgeStoreError>;
  readonly getRequest: (
    namespace: string,
    requestId: string,
  ) => Effect.Effect<AgentBridgeRequestRecord | null, AgentBridgeStoreError>;
  /** The receipt of one turn submission, scoped to one namespace. */
  readonly findRequestBySubmissionId: (input: {
    readonly namespace: string;
    readonly submissionId: string;
  }) => Effect.Effect<AgentBridgeRequestRecord | null, AgentBridgeStoreError>;
  /** Submission ids this namespace sent to one thread. */
  readonly listSubmissionIdsForThread: (input: {
    readonly namespace: string;
    readonly threadId: string;
  }) => Effect.Effect<ReadonlyArray<string>, AgentBridgeStoreError>;
  /** Deletes completed receipts last written before `before`; returns how many. */
  readonly pruneCompletedRequests: (before: string) => Effect.Effect<number, AgentBridgeStoreError>;
  /**
   * Inserts a pending receipt (and, for a created thread, its ownership row)
   * and increments the workspace revision, in one transaction. Returns the
   * existing receipt instead when the key is already taken.
   */
  readonly insertPendingRequest: (input: {
    readonly namespace: string;
    readonly requestId: string;
    readonly tool: string;
    readonly argsHash: string;
    readonly command: unknown;
    readonly relatedIds: Readonly<Record<string, string>>;
    readonly createdThread?: { readonly threadId: string; readonly clientId: string };
    readonly at: string;
  }) => Effect.Effect<
    | { readonly inserted: true; readonly revision: number }
    | {
        readonly inserted: false;
        readonly existing: AgentBridgeRequestRecord;
      },
    AgentBridgeStoreError
  >;
  /** Stores the result once; a second completion keeps the first. */
  readonly completeRequest: (input: {
    readonly namespace: string;
    readonly requestId: string;
    readonly result: unknown;
    readonly at: string;
  }) => Effect.Effect<number, AgentBridgeStoreError>;
  readonly threadCreator: (threadId: string) => Effect.Effect<string | null, AgentBridgeStoreError>;
  readonly listCreatedThreadIds: (
    clientId?: string,
  ) => Effect.Effect<ReadonlyArray<string>, AgentBridgeStoreError>;
}

export const makeAgentBridgeStore = (sql: SqlClient.SqlClient): AgentBridgeStore => {
  const wrap =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AgentBridgeStoreError, R> =>
      effect.pipe(Effect.mapError((cause) => new AgentBridgeStoreError({ operation, cause })));

  const bumpRevision = Effect.gen(function* () {
    yield* sql`UPDATE agent_bridge_revision SET revision = revision + 1 WHERE id = 1`;
    const rows = yield* sql<{
      revision: number;
    }>`SELECT revision FROM agent_bridge_revision WHERE id = 1`;
    return rows[0]?.revision ?? 0;
  });

  const getRequest = (namespace: string, requestId: string) =>
    sql<RequestRow>`SELECT namespace, request_id, tool, args_hash, command_json, related_ids_json,
        result_json, status, created_at
      FROM agent_bridge_requests WHERE namespace = ${namespace} AND request_id = ${requestId}`.pipe(
      Effect.map((rows) => (rows[0] ? toRequest(rows[0]) : null)),
    );

  return {
    ensureLocalClient: sql`INSERT OR IGNORE INTO agent_bridge_clients
        (id, kind, name, label, scopes_json, project_ids_json, grant_generation, created_at)
      VALUES (${AGENT_BRIDGE_LOCAL_CLIENT_ID}, 'local', ${AGENT_BRIDGE_LOCAL_CLIENT_NAME}, NULL,
        ${JSON.stringify(AGENT_BRIDGE_SCOPES)}, '[]', 0, ${new Date().toISOString()})`.pipe(
      Effect.asVoid,
      wrap("ensureLocalClient"),
    ),
    listClients: sql<ClientRow>`SELECT * FROM agent_bridge_clients ORDER BY created_at, id`.pipe(
      Effect.map((rows) => rows.map(toClient)),
      wrap("listClients"),
    ),
    getClient: (id) =>
      sql<ClientRow>`SELECT * FROM agent_bridge_clients WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? toClient(rows[0]) : null)),
        wrap("getClient"),
      ),
    touchClient: (id, at) =>
      sql`UPDATE agent_bridge_clients SET last_used_at = ${at} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        wrap("touchClient"),
      ),
    getRevision: sql<{
      revision: number;
    }>`SELECT revision FROM agent_bridge_revision WHERE id = 1`.pipe(
      Effect.map((rows) => rows[0]?.revision ?? 0),
      wrap("getRevision"),
    ),
    getRequest: (namespace, requestId) => getRequest(namespace, requestId).pipe(wrap("getRequest")),
    findRequestBySubmissionId: ({ namespace, submissionId }) =>
      sql<RequestRow>`SELECT namespace, request_id, tool, args_hash, command_json, related_ids_json,
          result_json, status, created_at
        FROM agent_bridge_requests
        WHERE namespace = ${namespace} AND submission_id = ${submissionId}
        LIMIT 1`.pipe(
        Effect.map((rows) => (rows[0] ? toRequest(rows[0]) : null)),
        wrap("findRequestBySubmissionId"),
      ),
    listSubmissionIdsForThread: ({ namespace, threadId }) =>
      sql<{ submission_id: string }>`SELECT submission_id
        FROM agent_bridge_requests
        WHERE namespace = ${namespace} AND thread_id = ${threadId}
          AND submission_id IS NOT NULL`.pipe(
        Effect.map((rows) => rows.map((row) => row.submission_id)),
        wrap("listSubmissionIdsForThread"),
      ),
    pruneCompletedRequests: (before) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_requests
              WHERE status = 'completed' AND updated_at < ${before}`;
            yield* sql`DELETE FROM agent_bridge_requests
              WHERE status = 'completed' AND updated_at < ${before}`;
            return rows[0]?.n ?? 0;
          }),
        )
        .pipe(wrap("pruneCompletedRequests")),
    insertPendingRequest: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* getRequest(input.namespace, input.requestId);
            if (existing) return { inserted: false as const, existing };
            yield* sql`INSERT INTO agent_bridge_requests
                (namespace, request_id, tool, args_hash, command_json, related_ids_json,
                 thread_id, submission_id, result_json, status, created_at, updated_at)
              VALUES (${input.namespace}, ${input.requestId}, ${input.tool}, ${input.argsHash},
                ${JSON.stringify(input.command)}, ${JSON.stringify(input.relatedIds)},
                ${input.relatedIds.threadId ?? null}, ${input.relatedIds.submissionId ?? null},
                NULL, 'pending', ${input.at}, ${input.at})`;
            if (input.createdThread) {
              yield* sql`INSERT INTO agent_bridge_threads (thread_id, client_id, request_id, created_at)
                VALUES (${input.createdThread.threadId}, ${input.createdThread.clientId},
                  ${input.requestId}, ${input.at})`;
            }
            const revision = yield* bumpRevision;
            return { inserted: true as const, revision };
          }),
        )
        .pipe(wrap("insertPendingRequest")),
    completeRequest: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE agent_bridge_requests
              SET result_json = ${JSON.stringify(input.result)}, status = 'completed',
                updated_at = ${input.at}
              WHERE namespace = ${input.namespace} AND request_id = ${input.requestId}
                AND status = 'pending'`;
            return yield* bumpRevision;
          }),
        )
        .pipe(wrap("completeRequest")),
    threadCreator: (threadId) =>
      sql<{ client_id: string }>`SELECT client_id FROM agent_bridge_threads
        WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.client_id ?? null),
        wrap("threadCreator"),
      ),
    listCreatedThreadIds: (clientId) =>
      (clientId === undefined
        ? sql<{ thread_id: string }>`SELECT thread_id FROM agent_bridge_threads`
        : sql<{ thread_id: string }>`SELECT thread_id FROM agent_bridge_threads
            WHERE client_id = ${clientId}`
      ).pipe(
        Effect.map((rows) => rows.map((row) => row.thread_id)),
        wrap("listCreatedThreadIds"),
      ),
  };
};
