import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration051 from "./051_PrHub.ts";
import Migration053 from "./053_PrHubAdvisories.ts";
import Migration069 from "./069_PrProviderDiscriminant.ts";
import Migration072 from "./072_PrProviderQualifiedKeys.ts";
import Migration078 from "./078_PrHubViewerIsolation.ts";
import Migration167 from "./167_PrHubSeenBaseline.ts";

it.layer(SqliteClient.layerMemory())("167_PrHubSeenBaseline", (it) => {
  it.effect("seeds a baseline for pull requests already seen, and runs twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const migration of [
        Migration051,
        Migration053,
        Migration069,
        Migration072,
        Migration078,
      ])
        yield* migration;
      const pr = (number: number, payload: string) => sql`INSERT INTO pr_hub_prs (
          provider_kind, host, repo, number, title, url, state, draft, check_rollup,
          review_decision, mergeable, merge_state_status, additions, deletions, changed_files,
          created_at, updated_at, payload_json
        ) VALUES ('github', 'github.com', 'org/repo', ${number}, 'PR', 'https://example.test',
          'open', 0, 'failure', 'approved', 'mergeable', 'CLEAN', 0, 0, 0, '2026-01-01',
          '2026-01-01', ${payload})`;
      const viewer = (number: number, seen: string | null, payload: string) =>
        sql`INSERT INTO pr_hub_viewer_state (
          provider_kind, host, viewer_id, viewer_login, viewer_payload_json, facts_verified,
          repo, number, roles_json, attention_state, attention_bucket, primary_reason,
          next_action, sort_timestamp, attention_fingerprint, last_seen_fingerprint,
          last_matched_at
        ) VALUES ('github', 'github.com', '42', 'me', ${payload}, 1, 'org/repo', ${number},
          '["author"]', 'ci_failed', 'needs_you', 'reason', 'action', '2026-01-01', 'current',
          ${seen}, '2026-01-01')`;
      yield* pr(1, '{"headRefOid":"abc","commentsCount":4}');
      yield* viewer(1, "current", '{"lastVerifiedAt":"2026-01-01T00:00:00.000Z"}');
      yield* pr(2, '{"headRefOid":"def","commentsCount":1}');
      yield* viewer(2, null, '{"lastVerifiedAt":"2026-01-01T00:00:00.000Z"}');
      // Found by search and not read in full yet: its facts are placeholders.
      yield* pr(3, '{"headRefOid":null,"commentsCount":0}');
      yield* viewer(3, "current", "{}");

      yield* Migration167;
      const read = sql<{ number: number; seen_baseline_json: string | null }>`
        SELECT number, seen_baseline_json FROM pr_hub_viewer_state ORDER BY number`;
      const rows = yield* read;
      const first = JSON.parse(rows[0]!.seen_baseline_json!) as Record<string, unknown>;
      assert.match(String(first.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepStrictEqual(
        { ...first, at: "now" },
        {
          at: "now",
          state: "open",
          checkRollup: "failure",
          reviewDecision: "approved",
          mergeable: "mergeable",
          attentionState: "ci_failed",
          headRefOid: "abc",
          commentsCount: 4,
        },
      );
      assert.equal(rows[1]!.seen_baseline_json, null);
      assert.deepStrictEqual(
        Object.keys(JSON.parse(rows[2]!.seen_baseline_json!) as object).toSorted(),
        ["at", "state"],
      );

      yield* sql`UPDATE pr_hub_viewer_state SET seen_baseline_json = 'kept' WHERE number = 1`;
      yield* Migration167;
      assert.equal((yield* read)[0]!.seen_baseline_json, "kept");
    }),
  );
});

it.layer(SqliteClient.layerMemory())("167_PrHubSeenBaseline without PR Hub tables", (it) => {
  it.effect("does nothing on a database that has no viewer state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration167;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pr_hub_viewer_state'`,
        [],
      );
    }),
  );
});
