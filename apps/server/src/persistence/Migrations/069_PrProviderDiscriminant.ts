import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const TABLES = [
  "pr_hub_prs",
  "pr_hub_viewer_state",
  "pr_hub_refresh_state",
  "pr_hub_advisories",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingTables = new Set<string>();

  for (const table of TABLES) {
    const existing = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ${table}
    `;
    if (existing.length === 0) continue;
    existingTables.add(table);
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    if (columns.some((column) => column.name === "provider_kind")) continue;
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'github' CHECK (provider_kind IN ('github', 'gitlab', 'azure-devops', 'bitbucket', 'unknown'))`,
    );
  }

  if (existingTables.has("pr_hub_prs")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_prs_provider_host
      ON pr_hub_prs(provider_kind, host, repo, number)
    `;
  }
  if (existingTables.has("pr_hub_viewer_state")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_viewer_provider_host
      ON pr_hub_viewer_state(provider_kind, host, viewer_login)
    `;
  }
  if (existingTables.has("pr_hub_refresh_state")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_refresh_provider_host
      ON pr_hub_refresh_state(provider_kind, host, viewer_login)
    `;
  }
  if (existingTables.has("pr_hub_advisories")) {
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_pr_hub_advisories_provider_host
      ON pr_hub_advisories(provider_kind, host, viewer_login)
    `;
    yield* sql`
      UPDATE pr_hub_advisories
      SET key = 'github:' || key
      WHERE provider_kind = 'github' AND key NOT LIKE 'github:%'
    `;
  }
});
