import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep legacy preferences unbound until the host/login is verified by /user. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "pr_hub_viewer_state",
    "pr_hub_refresh_state",
    "pr_hub_advisories",
  ] as const) {
    const columns = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${table})`;
    if (columns.length === 0 || columns.some((column) => column.name === "viewer_id")) continue;
    // Renaming the key column preserves the provider-leading PK and all preferences.
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN viewer_login TO viewer_id`);
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN viewer_login TEXT NOT NULL DEFAULT ''`);
    yield* sql.unsafe(
      `UPDATE ${table} SET viewer_login = viewer_id, viewer_id = 'legacy:' || lower(viewer_id)`,
    );
    if (table === "pr_hub_viewer_state") {
      yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN viewer_payload_json TEXT NOT NULL DEFAULT '{}'`;
      yield* sql`ALTER TABLE pr_hub_viewer_state ADD COLUMN facts_verified INTEGER NOT NULL DEFAULT 0`;
    }
  }
  const prs = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('pr_hub_prs')`;
  if (prs.length > 0) {
    // These blobs had no trustworthy account owner. Do not copy them to any viewer.
    yield* sql`UPDATE pr_hub_prs SET payload_json = json_remove(payload_json,
      '$.viewerHasReviewed', '$.viewerReviewRequested', '$.roles', '$.attentionState',
      '$.attentionBucket', '$.primaryReason', '$.nextAction', '$.attentionFingerprint',
      '$.notificationPending', '$.snoozedUntil', '$.ignoredAt', '$.waitingSince',
      '$.actionableUnresolvedThreadCount') WHERE json_valid(payload_json)`;
  }
});
