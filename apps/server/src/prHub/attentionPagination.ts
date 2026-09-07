import { assertPrHubDiscoveryLease, withPrHubDiscoveryWork } from "./discoveryLease.ts";
import {
  appendPrConnectionFacts,
  discardPrConnectionFacts,
  readPrConnectionFacts,
} from "./connectionFacts.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { DiscoveryAccount } from "./discovery.ts";

export const ATTENTION_CONNECTION_FIELDS = {
  reviewThreads: "id isResolved isOutdated comments(last:1){ nodes { id url author { login } } }",
  latestReviews: "id url author { login } state commit { oid }",
} as const;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
interface Checkpoint {
  identity: string;
  cursor: string | null;
  complete: boolean;
  fetched?: number;
  nodes?: unknown[];
}

/** One page per connection per pass. Checkpoints survive budget exhaustion and restarts. */
function continueConnections<E, R>(
  account: DiscoveryAccount,
  initial: Record<string, unknown>,
  query: (document: string, variables: Record<string, string>) => Effect.Effect<unknown, E, R>,
  fields: Readonly<Record<string, string>> = ATTENTION_CONNECTION_FIELDS,
  taskKind = "attention_page",
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const identityOf = (node: Record<string, unknown>) =>
      JSON.stringify([node.id, node.headRefOid, node.baseRefOid, node.baseRefName, node.updatedAt]);
    const identity = identityOf(initial);
    const node = { ...initial };
    let complete = true;
    for (const name of Object.keys(fields)) {
      const connection = record(initial[name]);
      const page = record(connection?.pageInfo);
      // Older stored fixtures/providers lack pagination metadata; never issue a guessed cursor.
      if (!connection || !Array.isArray(connection.nodes)) {
        complete = false;
        continue;
      }
      const key = `${String(initial.id)}:${name}`;
      const owner = { ...account, kind: taskKind, key, identity };
      if (page?.hasNextPage !== true) {
        yield* discardPrConnectionFacts(owner);
        if (page?.hasNextPage !== false) complete = false;
        if (
          typeof connection.totalCount === "number" &&
          connection.totalCount > connection.nodes.length
        )
          complete = false;
        yield* sql`DELETE FROM pr_hub_sync_tasks WHERE provider_kind = 'github' AND host = ${account.host}
          AND viewer_id = ${account.viewerId} AND kind = ${taskKind} AND task_key = ${key}`;
        continue;
      }
      const rows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM pr_hub_sync_tasks
        WHERE provider_kind = 'github' AND host = ${account.host} AND viewer_id = ${account.viewerId}
        AND kind = ${taskKind} AND task_key = ${key}`;
      const stored = rows[0] ? (JSON.parse(rows[0].payload_json) as Checkpoint) : null;
      let checkpoint: Checkpoint =
        stored?.identity === identity
          ? stored
          : {
              identity,
              cursor: typeof page.endCursor === "string" ? page.endCursor : null,
              complete: false,
              nodes: connection.nodes,
            };
      if (checkpoint.nodes) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertPrHubDiscoveryLease;
            yield* discardPrConnectionFacts(owner);
            yield* appendPrConnectionFacts(owner, checkpoint.nodes!, 0);
          }),
        );
        checkpoint = {
          identity,
          cursor: checkpoint.cursor,
          complete: checkpoint.complete,
          fetched: (yield* readPrConnectionFacts(owner, name)).fetched,
        };
      }
      let pendingNodes: unknown[] = [];
      let pendingOffset = 0;
      if (!checkpoint.complete && checkpoint.cursor) {
        const response = yield* query(
          `query PrHubAttentionPage($id:ID!,$cursor:String!) {
          node(id:$id) { ... on PullRequest {
            id headRefOid baseRefOid baseRefName updatedAt
            ${name}(first:100,after:$cursor) { totalCount pageInfo { hasNextPage endCursor }
              nodes { ${fields[name]} }
            }
          } }
          rateLimit { cost remaining limit resetAt }
        }`,
          { id: String(initial.id), cursor: checkpoint.cursor },
        ).pipe(Effect.option);
        if (response._tag === "Some") {
          const root = record(response.value);
          const current = record(record(root?.data)?.node);
          const next = record(current?.[name]);
          const info = record(next?.pageInfo);
          const cursor = typeof info?.endCursor === "string" ? info.endCursor : null;
          if (
            current &&
            identityOf(current) === identity &&
            (!Array.isArray(root?.errors) || root.errors.length === 0) &&
            Array.isArray(next?.nodes) &&
            typeof info?.hasNextPage === "boolean" &&
            (info.hasNextPage === false || (cursor && cursor !== checkpoint.cursor))
          ) {
            const nodes = next.nodes;
            const ids = nodes.map((item) => record(item)?.id);
            const known = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM pr_hub_connection_facts
              WHERE provider_kind = 'github' AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
                AND task_kind = ${owner.kind} AND task_key = ${owner.key} AND comparison = ${identity}
                AND node_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
            const fetched = (checkpoint.fetched ?? 0) + nodes.length;
            if (
              ids.every((id) => typeof id === "string") &&
              new Set(ids).size === ids.length &&
              known[0]?.count === 0 &&
              (info.hasNextPage !== false ||
                (typeof next.totalCount === "number" && fetched === next.totalCount))
            ) {
              pendingNodes = nodes;
              pendingOffset = checkpoint.fetched ?? 0;
              checkpoint = { identity, cursor, fetched, complete: info.hasNextPage === false };
            }
          }
        }
      }
      const now = new Date().toISOString();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPrHubDiscoveryLease;
          if (pendingNodes.length)
            yield* appendPrConnectionFacts(owner, pendingNodes, pendingOffset);
          yield* sql`INSERT INTO pr_hub_sync_tasks(provider_kind, host, viewer_id, kind, task_key, payload_json, created_at, updated_at)
        VALUES ('github', ${account.host}, ${account.viewerId}, ${taskKind}, ${key}, ${JSON.stringify(checkpoint)}, ${now}, ${now})
        ON CONFLICT(provider_kind, host, viewer_id, kind, task_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`;
        }),
      );
      const facts = yield* readPrConnectionFacts(owner, name);
      node[name] = { ...connection, ...facts };
      complete &&= checkpoint.complete;
    }
    return { node, complete };
  });
}

export function continuePrConnectionPagination<E, R>(
  account: DiscoveryAccount,
  initial: Record<string, unknown>,
  query: (document: string, variables: Record<string, string>) => Effect.Effect<unknown, E, R>,
  fields: Readonly<Record<string, string>> = ATTENTION_CONNECTION_FIELDS,
  taskKind = "attention_page",
) {
  return withPrHubDiscoveryWork(
    account,
    taskKind,
    String(initial.id),
    continueConnections(account, initial, query, fields, taskKind),
  ).pipe(
    Effect.map((result) =>
      result._tag === "Some" ? result.value : { node: initial, complete: false },
    ),
  );
}
