import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PROVIDER_CHECK =
  "CHECK (provider_kind IN ('github', 'gitlab', 'azure-devops', 'bitbucket', 'unknown'))";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tableExists = (table: string) =>
    sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
    `.pipe(Effect.map((rows) => rows.length > 0));
  const providerIsInPrimaryKey = (table: string) =>
    sql<{ readonly name: string; readonly pk: number }>`
      SELECT name, pk FROM pragma_table_info(${table}) WHERE name = 'provider_kind'
    `.pipe(Effect.map((rows) => (rows[0]?.pk ?? 0) > 0));

  const hasPrs = yield* tableExists("pr_hub_prs");
  if (hasPrs && !(yield* providerIsInPrimaryKey("pr_hub_prs"))) {
    yield* sql.unsafe(`
      CREATE TABLE pr_hub_prs_provider_keyed (
        provider_kind TEXT NOT NULL DEFAULT 'github' ${PROVIDER_CHECK},
        host TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
        node_id TEXT, title TEXT NOT NULL, url TEXT NOT NULL, author TEXT,
        state TEXT NOT NULL, draft INTEGER NOT NULL, check_rollup TEXT NOT NULL,
        review_decision TEXT NOT NULL, mergeable TEXT NOT NULL,
        merge_state_status TEXT NOT NULL, additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL, changed_files INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (provider_kind, host, repo, number)
      )
    `);
    yield* sql`
      INSERT INTO pr_hub_prs_provider_keyed
      SELECT provider_kind, host, repo, number, node_id, title, url, author, state, draft,
        check_rollup, review_decision, mergeable, merge_state_status, additions, deletions,
        changed_files, created_at, updated_at, closed_at, payload_json
      FROM pr_hub_prs
    `;
    yield* sql`DROP TABLE pr_hub_prs`;
    yield* sql`ALTER TABLE pr_hub_prs_provider_keyed RENAME TO pr_hub_prs`;
  }

  const hasViewerState = yield* tableExists("pr_hub_viewer_state");
  if (hasViewerState && !(yield* providerIsInPrimaryKey("pr_hub_viewer_state"))) {
    yield* sql.unsafe(`
      CREATE TABLE pr_hub_viewer_state_provider_keyed (
        provider_kind TEXT NOT NULL DEFAULT 'github' ${PROVIDER_CHECK},
        host TEXT NOT NULL, viewer_login TEXT NOT NULL, repo TEXT NOT NULL,
        number INTEGER NOT NULL, roles_json TEXT NOT NULL, attention_state TEXT NOT NULL,
        attention_bucket TEXT NOT NULL, primary_reason TEXT NOT NULL, next_action TEXT NOT NULL,
        sort_timestamp TEXT NOT NULL, attention_fingerprint TEXT NOT NULL,
        last_seen_fingerprint TEXT, last_notified_fingerprint TEXT, last_notified_at TEXT,
        snoozed_until TEXT, ignored_at TEXT, last_matched_at TEXT NOT NULL,
        no_longer_relevant_at TEXT, stale_inaccessible_count INTEGER NOT NULL DEFAULT 0,
        stale_inaccessible_at TEXT,
        PRIMARY KEY (provider_kind, host, viewer_login, repo, number)
      )
    `);
    yield* sql`
      INSERT INTO pr_hub_viewer_state_provider_keyed
      SELECT provider_kind, host, viewer_login, repo, number, roles_json, attention_state,
        attention_bucket, primary_reason, next_action, sort_timestamp, attention_fingerprint,
        last_seen_fingerprint, last_notified_fingerprint, last_notified_at, snoozed_until,
        ignored_at, last_matched_at, no_longer_relevant_at, stale_inaccessible_count,
        stale_inaccessible_at
      FROM pr_hub_viewer_state
    `;
    yield* sql`DROP TABLE pr_hub_viewer_state`;
    yield* sql`
      ALTER TABLE pr_hub_viewer_state_provider_keyed RENAME TO pr_hub_viewer_state
    `;
  }

  const hasRefreshState = yield* tableExists("pr_hub_refresh_state");
  if (hasRefreshState && !(yield* providerIsInPrimaryKey("pr_hub_refresh_state"))) {
    yield* sql.unsafe(`
      CREATE TABLE pr_hub_refresh_state_provider_keyed (
        provider_kind TEXT NOT NULL DEFAULT 'github' ${PROVIDER_CHECK},
        host TEXT NOT NULL, viewer_login TEXT NOT NULL, status TEXT NOT NULL,
        last_polled_at TEXT, last_success_at TEXT, error_kind TEXT, error_message TEXT,
        capped_buckets_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (provider_kind, host, viewer_login)
      )
    `);
    yield* sql`
      INSERT INTO pr_hub_refresh_state_provider_keyed
      SELECT provider_kind, host, viewer_login, status, last_polled_at, last_success_at,
        error_kind, error_message, capped_buckets_json
      FROM pr_hub_refresh_state
    `;
    yield* sql`DROP TABLE pr_hub_refresh_state`;
    yield* sql`
      ALTER TABLE pr_hub_refresh_state_provider_keyed RENAME TO pr_hub_refresh_state
    `;
  }

  const hasAdvisories = yield* tableExists("pr_hub_advisories");
  if (hasAdvisories && !(yield* providerIsInPrimaryKey("pr_hub_advisories"))) {
    yield* sql.unsafe(`
      CREATE TABLE pr_hub_advisories_provider_keyed (
        provider_kind TEXT NOT NULL DEFAULT 'github' ${PROVIDER_CHECK},
        host TEXT NOT NULL, viewer_login TEXT NOT NULL, repo TEXT NOT NULL,
        number INTEGER NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, recommendation TEXT NOT NULL, summary TEXT NOT NULL,
        confidence INTEGER NOT NULL, blockers_json TEXT NOT NULL, findings_json TEXT NOT NULL,
        degraded INTEGER NOT NULL, truncated INTEGER NOT NULL, generated_at TEXT,
        error_kind TEXT, error_message TEXT, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_kind, host, viewer_login, repo, number)
      )
    `);
    yield* sql`
      INSERT INTO pr_hub_advisories_provider_keyed
      SELECT provider_kind, host, viewer_login, repo, number, key, fingerprint, status,
        recommendation, summary, confidence, blockers_json, findings_json, degraded, truncated,
        generated_at, error_kind, error_message, payload_json, updated_at
      FROM pr_hub_advisories
    `;
    yield* sql`DROP TABLE pr_hub_advisories`;
    yield* sql`
      ALTER TABLE pr_hub_advisories_provider_keyed RENAME TO pr_hub_advisories
    `;
  }

  if (hasPrs) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_prs_provider_host
      ON pr_hub_prs(provider_kind, host, repo, number)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_prs_closed
      ON pr_hub_prs(provider_kind, host, state, closed_at)
    `;
  }
  if (hasViewerState) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_provider_host
      ON pr_hub_viewer_state(provider_kind, host, viewer_login)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_bucket_sort
      ON pr_hub_viewer_state(
        provider_kind, host, viewer_login, attention_bucket, sort_timestamp DESC
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_reason
      ON pr_hub_viewer_state(provider_kind, host, viewer_login, primary_reason)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_relevance
      ON pr_hub_viewer_state(
        provider_kind, host, viewer_login, no_longer_relevant_at, stale_inaccessible_at
      )
    `;
  }
  if (hasRefreshState) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_refresh_provider_host
      ON pr_hub_refresh_state(provider_kind, host, viewer_login)
    `;
  }
  if (hasAdvisories) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_provider_host
      ON pr_hub_advisories(provider_kind, host, viewer_login)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_viewer_updated
      ON pr_hub_advisories(provider_kind, host, viewer_login, updated_at DESC)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_status
      ON pr_hub_advisories(provider_kind, host, viewer_login, status)
    `;
  }
});
