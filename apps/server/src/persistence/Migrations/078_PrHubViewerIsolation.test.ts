import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration051 from "./051_PrHub.ts";
import Migration053 from "./053_PrHubAdvisories.ts";
import Migration069 from "./069_PrProviderDiscriminant.ts";
import Migration072 from "./072_PrProviderQualifiedKeys.ts";
import Migration078 from "./078_PrHubViewerIsolation.ts";

it.layer(SqliteClient.layerMemory())("078_PrHubViewerIsolation", (it) => {
  it.effect("preserves preferences without assigning unverified facts to an account", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration051;
      yield* Migration053;
      yield* Migration069;
      yield* Migration072;
      yield* sql`INSERT INTO pr_hub_viewer_state (
      provider_kind, host, viewer_login, repo, number, roles_json, attention_state,
      attention_bucket, primary_reason, next_action, sort_timestamp, attention_fingerprint,
      last_seen_fingerprint, last_notified_fingerprint, snoozed_until, ignored_at, last_matched_at
    ) VALUES ('github', 'github.com', 'Octo', 'org/repo', 1, '["author"]', 'awaiting_review',
      'waiting_on_others', 'waiting', 'review', '2026-01-01', 'current', 'seen', 'notified',
      '2026-12-01', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO pr_hub_prs (
      provider_kind, host, repo, number, title, url, state, draft, check_rollup, review_decision,
      mergeable, merge_state_status, additions, deletions, changed_files, created_at, updated_at, payload_json
    ) VALUES ('github', 'github.com', 'org/repo', 1, 'PR', 'https://github.com/org/repo/pull/1',
      'open', 0, 'unknown', 'unknown', 'unknown', 'unknown', 0, 0, 0, '2026-01-01', '2026-01-01',
      '{"headRefOid":"abc","viewerHasReviewed":true,"waitingSince":"2026-01-01","roles":["author"]}')`;
      yield* Migration078;
      yield* Migration078;
      const rows = yield* sql<
        Record<string, unknown>
      >`SELECT viewer_id, viewer_login, facts_verified,
      viewer_payload_json, last_seen_fingerprint, last_notified_fingerprint, snoozed_until, ignored_at
      FROM pr_hub_viewer_state`;
      assert.deepStrictEqual(rows, [
        {
          viewer_id: "legacy:octo",
          viewer_login: "Octo",
          facts_verified: 0,
          viewer_payload_json: "{}",
          last_seen_fingerprint: "seen",
          last_notified_fingerprint: "notified",
          snoozed_until: "2026-12-01",
          ignored_at: "2026-01-01",
        },
      ]);
      const facts = yield* sql<{ payload_json: string }>`SELECT payload_json FROM pr_hub_prs`;
      assert.deepStrictEqual(JSON.parse(facts[0]!.payload_json), { headRefOid: "abc" });
      const key = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('pr_hub_viewer_state') WHERE pk > 0 ORDER BY pk`;
      assert.deepStrictEqual(
        key.map((column) => column.name),
        ["provider_kind", "host", "viewer_id", "repo", "number"],
      );
    }),
  );
});
