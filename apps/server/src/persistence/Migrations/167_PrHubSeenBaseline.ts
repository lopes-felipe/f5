import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `pr_hub_viewer_state.seen_baseline_json`: the facts of a pull request when its
 * viewer last looked at it. PR Hub compares them with the current facts to say what
 * changed since (new commits, new comments, a failed check).
 *
 * Rows the viewer has already seen start from today's facts, so an upgrade does not
 * report old activity as new. Rows never seen keep no baseline and read as new. A row
 * that was only found by search and not yet read in full holds placeholder facts, so
 * just its state is recorded.
 *
 * Safe to run twice: the column and the seeded rows are left alone the second time.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_viewer_state')`;
  // Repair fixtures and partially initialized installations may not yet own PR Hub tables.
  if (!columns.length || columns.some((column) => column.name === "seen_baseline_json")) return;
  yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN seen_baseline_json TEXT`;
  yield* sql`
    UPDATE pr_hub_viewer_state
    SET seen_baseline_json = (
      SELECT CASE
        WHEN json_valid(pr_hub_viewer_state.viewer_payload_json)
          AND json_extract(pr_hub_viewer_state.viewer_payload_json, '$.lastVerifiedAt') IS NOT NULL
        THEN json_object(
          'at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          'state', p.state,
          'checkRollup', p.check_rollup,
          'reviewDecision', p.review_decision,
          'mergeable', p.mergeable,
          'attentionState', pr_hub_viewer_state.attention_state,
          'headRefOid', CASE WHEN json_valid(p.payload_json)
            THEN json_extract(p.payload_json, '$.headRefOid') END,
          'commentsCount', CASE WHEN json_valid(p.payload_json)
            THEN json_extract(p.payload_json, '$.commentsCount') END
        )
        ELSE json_object('at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'state', p.state)
      END
      FROM pr_hub_prs p
      WHERE p.provider_kind = pr_hub_viewer_state.provider_kind
        AND p.host = pr_hub_viewer_state.host
        AND p.repo = pr_hub_viewer_state.repo
        AND p.number = pr_hub_viewer_state.number
    )
    WHERE last_seen_fingerprint IS NOT NULL
  `;
});
