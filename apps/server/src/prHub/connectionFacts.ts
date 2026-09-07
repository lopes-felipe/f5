import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { DiscoveryAccount } from "./discovery.ts";

export interface ConnectionOwner extends DiscoveryAccount {
  kind: string;
  key: string;
  identity: string;
}
export function discardPrConnectionFacts(owner: ConnectionOwner) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM pr_hub_connection_facts WHERE provider_kind = 'github' AND host = ${owner.host}
      AND viewer_id = ${owner.viewerId} AND task_kind = ${owner.kind} AND task_key = ${owner.key}`;
  });
}

/** Store one provider page, deduplicated by node identity, without a growing checkpoint blob. */
export function appendPrConnectionFacts(
  owner: ConnectionOwner,
  nodes: readonly unknown[],
  offset: number,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO pr_hub_connection_facts(provider_kind, host, viewer_id, task_kind, task_key, comparison, node_id, ordinal, payload_json)
      SELECT 'github', ${owner.host}, ${owner.viewerId}, ${owner.kind}, ${owner.key}, ${owner.identity},
        json_extract(value, '$.id'), ${offset} + CAST(key AS INTEGER), value FROM json_each(${JSON.stringify(nodes)})
      WHERE json_type(value, '$.id') = 'text'
      ON CONFLICT(provider_kind, host, viewer_id, task_kind, task_key, comparison, node_id) DO NOTHING`;
  });
}

/** Counters cover the entire traversal; only display evidence is capped. */
export function readPrConnectionFacts(owner: ConnectionOwner, connection: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const viewer = (owner.viewerLogin ?? "").toLowerCase();
    const counts = yield* sql<{
      fetched: number;
      unresolved: number;
      actionable: number;
    }>`SELECT count(*) AS fetched,
      COALESCE(sum(COALESCE(json_extract(payload_json, '$.isResolved'), 0) <> 1), 0) AS unresolved,
      COALESCE(sum(COALESCE(json_extract(payload_json, '$.isResolved'), 0) <> 1
        AND COALESCE(json_extract(payload_json, '$.isOutdated'), 0) <> 1
        AND COALESCE(lower(json_extract(payload_json, '$.comments.nodes[0].author.login')), '') <> ${viewer}), 0) AS actionable
      FROM pr_hub_connection_facts WHERE provider_kind = 'github' AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND task_kind = ${owner.kind} AND task_key = ${owner.key} AND comparison = ${owner.identity}`;
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM pr_hub_connection_facts
      WHERE provider_kind = 'github' AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND task_kind = ${owner.kind} AND task_key = ${owner.key} AND comparison = ${owner.identity}
      ORDER BY CASE
        WHEN ${connection} = 'reviewThreads' AND COALESCE(json_extract(payload_json, '$.isResolved'), 0) <> 1
          AND COALESCE(json_extract(payload_json, '$.isOutdated'), 0) <> 1
          AND COALESCE(lower(json_extract(payload_json, '$.comments.nodes[0].author.login')), '') <> ${viewer} THEN 0
        WHEN ${connection} = 'latestReviews' AND lower(json_extract(payload_json, '$.author.login')) = ${viewer} THEN 0
        WHEN ${connection} IN ('assignees', 'participants') AND lower(json_extract(payload_json, '$.login')) = ${viewer} THEN 0
        WHEN ${connection} = 'reviewRequests' AND (lower(json_extract(payload_json, '$.requestedReviewer.login')) = ${viewer}
          OR lower(json_extract(payload_json, '$.requestedReviewer.combinedSlug')) IN (SELECT value FROM json_each(${JSON.stringify(owner.viewerTeams?.map((team) => team.toLowerCase()) ?? [])}))) THEN 0
        WHEN ${connection} = 'latestReviews' AND json_extract(payload_json, '$.state') = 'CHANGES_REQUESTED' THEN 1
        ELSE 2 END, ordinal DESC LIMIT 50`;
    const count = counts[0]!;
    return {
      nodes: [...rows]
        .reverse()
        .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>),
      fetched: count.fetched,
      unresolvedCount: count.unresolved,
      actionableCount: count.actionable,
      evidenceTruncated: count.fetched > rows.length,
    };
  });
}
