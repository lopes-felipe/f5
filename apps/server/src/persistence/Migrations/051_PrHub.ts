import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pr_hub_prs (
      host TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      node_id TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT,
      state TEXT NOT NULL,
      draft INTEGER NOT NULL,
      check_rollup TEXT NOT NULL,
      review_decision TEXT NOT NULL,
      mergeable TEXT NOT NULL,
      merge_state_status TEXT NOT NULL,
      additions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      changed_files INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (host, repo, number)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pr_hub_viewer_state (
      host TEXT NOT NULL,
      viewer_login TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      roles_json TEXT NOT NULL,
      attention_state TEXT NOT NULL,
      attention_bucket TEXT NOT NULL,
      primary_reason TEXT NOT NULL,
      next_action TEXT NOT NULL,
      sort_timestamp TEXT NOT NULL,
      attention_fingerprint TEXT NOT NULL,
      last_seen_fingerprint TEXT,
      last_notified_fingerprint TEXT,
      last_notified_at TEXT,
      snoozed_until TEXT,
      ignored_at TEXT,
      last_matched_at TEXT NOT NULL,
      no_longer_relevant_at TEXT,
      stale_inaccessible_count INTEGER NOT NULL DEFAULT 0,
      stale_inaccessible_at TEXT,
      PRIMARY KEY (host, viewer_login, repo, number)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pr_hub_refresh_state (
      host TEXT NOT NULL,
      viewer_login TEXT NOT NULL,
      status TEXT NOT NULL,
      last_polled_at TEXT,
      last_success_at TEXT,
      error_kind TEXT,
      error_message TEXT,
      capped_buckets_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (host, viewer_login)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_bucket_sort
    ON pr_hub_viewer_state(host, viewer_login, attention_bucket, sort_timestamp DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_reason
    ON pr_hub_viewer_state(host, viewer_login, primary_reason)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_prs_repo_number
    ON pr_hub_prs(host, repo, number)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_prs_closed
    ON pr_hub_prs(host, state, closed_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_relevance
    ON pr_hub_viewer_state(host, viewer_login, no_longer_relevant_at, stale_inaccessible_at)
  `;
});
