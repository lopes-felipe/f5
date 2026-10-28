import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE upstream_port_reviews (
    project_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    group_index INTEGER NOT NULL,
    port_thread_id TEXT NOT NULL,
    reviewers_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('waiting','reviewing','apply_pending','applying','completed','skipped','error')),
    error_stage TEXT CHECK (error_stage IS NULL OR error_stage IN ('review-setup','review','apply-feedback')),
    detail TEXT,
    pr_url TEXT,
    reviewed_head_sha TEXT,
    final_head_sha TEXT,
    review_workflow_id TEXT,
    review_input_json TEXT,
    apply_command_json TEXT,
    apply_turn_id TEXT,
    submit_failures INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, client_request_id, group_index)
  )`;
  yield* sql`CREATE UNIQUE INDEX upstream_port_reviews_thread ON upstream_port_reviews(port_thread_id)`;
  yield* sql`CREATE INDEX upstream_port_reviews_active ON upstream_port_reviews(status)
    WHERE status IN ('waiting','reviewing','apply_pending','applying')`;
});
