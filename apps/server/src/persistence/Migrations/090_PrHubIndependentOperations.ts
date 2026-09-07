import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE pr_hub_operations_next (
      provider_kind TEXT NOT NULL, host TEXT NOT NULL, viewer_id TEXT NOT NULL,
      repo TEXT NOT NULL, number INTEGER NOT NULL, operation_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL, draft_version INTEGER, correlation_nonce TEXT NOT NULL,
      remote_id TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(provider_kind, host, viewer_id, operation_id)
    )`;
      // Named columns, not SELECT *: the source layout lives in migration 084 and a
      // positional copy would silently misalign if that definition ever changes.
      yield* sql`INSERT INTO pr_hub_operations_next (
      provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
      payload_hash, payload_json, draft_version, correlation_nonce, remote_id,
      error_message, created_at, updated_at
    ) SELECT
      provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
      payload_hash, payload_json, draft_version, correlation_nonce, remote_id,
      error_message, created_at, updated_at
    FROM pr_hub_operations`;
      yield* sql`DROP TABLE pr_hub_operations`;
      yield* sql`ALTER TABLE pr_hub_operations_next RENAME TO pr_hub_operations`;
      // The active-comment index is new here, so rows written by an earlier build of
      // this branch may violate it. Retire all but the newest active comment operation
      // per PR first; otherwise CREATE UNIQUE INDEX aborts and the app cannot start.
      // Expressed as "a strictly newer sibling exists" so the survivor is unambiguous
      // without relying on SQLite's bare-column-with-MAX behaviour.
      // Both sides are aliased so the correlation reads unambiguously rather than
      // relying on how an unaliased target name resolves inside the subquery.
      yield* sql`UPDATE pr_hub_operations AS stale SET status = 'abandoned',
      error_message = 'Superseded by a newer comment operation on the same pull request.'
      WHERE stale.kind = 'comment' AND stale.status IN ('prepared', 'creating', 'outcome_unknown')
        AND EXISTS (
          SELECT 1 FROM pr_hub_operations AS newer
          WHERE newer.kind = 'comment' AND newer.status IN ('prepared', 'creating', 'outcome_unknown')
            AND newer.provider_kind = stale.provider_kind
            AND newer.host = stale.host
            AND newer.viewer_id = stale.viewer_id
            AND newer.repo = stale.repo
            AND newer.number = stale.number
            AND (newer.created_at > stale.created_at
              OR (newer.created_at = stale.created_at
                AND newer.operation_id > stale.operation_id))
        )`;
      yield* sql`CREATE UNIQUE INDEX pr_hub_operations_active_submission
      ON pr_hub_operations(provider_kind, host, viewer_id, repo, number)
      WHERE kind = 'review' AND status NOT IN ('succeeded', 'failed_before_send', 'rejected', 'abandoned')`;
      yield* sql`CREATE UNIQUE INDEX pr_hub_operations_active_reply
      ON pr_hub_operations(provider_kind, host, viewer_id, repo, number, json_extract(payload_json, '$.threadId'))
      WHERE kind = 'reply' AND status IN ('prepared', 'creating', 'outcome_unknown')`;
      yield* sql`CREATE UNIQUE INDEX pr_hub_operations_active_comment
      ON pr_hub_operations(provider_kind, host, viewer_id, repo, number)
      WHERE kind = 'comment' AND status IN ('prepared', 'creating', 'outcome_unknown')`;
    }),
  );
});
