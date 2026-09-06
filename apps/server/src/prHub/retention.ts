import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Non-expiring user work remains reachable when monitoring caches are cleared or compacted. */
export const protectedPrHubWork = (sql: SqlClient.SqlClient) => sql`
        SELECT provider_kind, host, viewer_id, repo, number FROM pr_hub_review_drafts
          WHERE frozen = 1 OR trim(json_extract(content_json, '$.body')) <> '' OR json_array_length(content_json, '$.comments') > 0
        UNION SELECT provider_kind, host, viewer_id, repo, number FROM pr_hub_reply_drafts WHERE trim(body) <> ''
        UNION SELECT provider_kind, host, viewer_id, repo, number FROM pr_hub_operations
          WHERE status IN ('prepared', 'creating', 'created', 'submitting', 'outcome_unknown')
        UNION SELECT provider_kind, host, viewer_id, repo, number FROM pr_hub_viewer_state
          WHERE json_extract(viewer_payload_json, '$.manuallyTracked') = 1`;
