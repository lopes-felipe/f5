import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pr_hub_advisories (
      host TEXT NOT NULL,
      viewer_login TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      blockers_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      degraded INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      generated_at TEXT,
      error_kind TEXT,
      error_message TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, viewer_login, repo, number)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_viewer_updated
    ON pr_hub_advisories(host, viewer_login, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_status
    ON pr_hub_advisories(host, viewer_login, status)
  `;
});
