import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { protectedPrHubWork } from "./retention.ts";
import { RESOLVED_RETENTION_MS } from "./discoveryModel.ts";
import type { DiscoveryAccount } from "./discovery.ts";

/** Recovery and its progress indicator must use the same account and retention scope. */
export function prHubRecoveryCandidates(
  sql: SqlClient.SqlClient,
  account: DiscoveryAccount,
  excluded: ReadonlySet<string>,
  now = Date.now(),
) {
  const protectedWork = protectedPrHubWork(sql);
  const resolvedBefore = new Date(now - RESOLVED_RETENTION_MS).toISOString();
  return sql`SELECT p.*, v.viewer_id, v.facts_verified, v.attention_bucket, v.viewer_payload_json
    FROM pr_hub_prs p JOIN pr_hub_viewer_state v
      ON p.provider_kind = v.provider_kind AND p.host = v.host AND p.repo = v.repo AND p.number = v.number
    WHERE p.provider_kind = 'github' AND p.host = ${account.host} AND v.viewer_id = ${account.viewerId}
      AND lower(p.repo) NOT IN (SELECT value FROM json_each(${JSON.stringify([...excluded])}))
      AND (v.no_longer_relevant_at IS NULL OR json_extract(v.viewer_payload_json, '$.manuallyTracked') = 1)
      AND (p.state = 'open' OR p.closed_at >= ${resolvedBefore} OR EXISTS (
        SELECT 1 FROM (${protectedWork}) protected WHERE protected.provider_kind = p.provider_kind
          AND protected.host = p.host AND protected.viewer_id = v.viewer_id
          AND protected.repo = p.repo AND protected.number = p.number))`;
}
