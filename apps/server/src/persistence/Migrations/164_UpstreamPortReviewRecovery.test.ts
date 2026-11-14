import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration137 from "./137_UpstreamPorts.ts";
import Migration143 from "./143_UpstreamPortQueue.ts";
import Migration145 from "./145_UpstreamPortReviews.ts";
import Migration152 from "./152_UpstreamTopicOutcomes.ts";
import Migration164 from "./164_UpstreamPortReviewRecovery.ts";

it.layer(SqliteClient.layerMemory())("164_UpstreamPortReviewRecovery", (it) => {
  it.effect(
    "backfills only implementation stops using the stopped turn, preserving visible status",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Migration137;
        yield* Migration143;
        yield* Migration145;
        yield* sql`CREATE TABLE projection_turns (
        row_id INTEGER PRIMARY KEY, thread_id TEXT, turn_id TEXT, requested_at TEXT, completed_at TEXT,
        assistant_message_id TEXT
      )`;
        yield* sql`CREATE TABLE projection_thread_messages (
          thread_id TEXT, turn_id TEXT, created_at TEXT, message_id TEXT,
          role TEXT, is_streaming INTEGER, text TEXT
        )`;
        yield* Migration152;
        const cases = [
          [
            "interrupted",
            "error",
            "review-setup",
            "Port turn interrupted; finish the port or Retry review after opening a PR",
            null,
            true,
          ],
          [
            "failed",
            "error",
            "review-setup",
            "Port turn error; finish the port or Retry review after opening a PR",
            null,
            true,
          ],
          ["blocked", "skipped", null, "Port ended with blocked", null, true],
          [
            "group-blocked",
            "skipped",
            null,
            "Port ended without a pull request for any topic",
            null,
            true,
          ],
          [
            "group-equivalent",
            "skipped",
            null,
            "Port ended without a pull request for any topic",
            null,
            false,
          ],
          [
            "group-not-applicable",
            "skipped",
            null,
            "Port ended without a pull request for any topic",
            null,
            false,
          ],
          [
            "group-other-turn",
            "skipped",
            null,
            "Port ended without a pull request for any topic",
            null,
            false,
          ],
          [
            "group-other-project",
            "skipped",
            null,
            "Port ended without a pull request for any topic",
            null,
            false,
          ],
          ["mixed-timestamps", "skipped", null, "Port ended with blocked", null, true],
          ["equivalent", "skipped", null, "Port ended with equivalent", null, false],
          ["archived", "skipped", null, "Port thread archived", null, false],
          ["setup", "error", "review-setup", "Pull request was not found", null, false],
          ["apply", "error", "apply-feedback", "Revision interrupted", "workflow", false],
          ["review", "error", "review", "Review workflow deleted", "workflow", false],
          ["missing-turn", "skipped", null, "Port ended with blocked", null, false],
        ] as const;
        for (const [id, status, stage, detail, workflow] of cases) {
          yield* sql`INSERT INTO upstream_port_reviews
          (project_id,client_request_id,group_index,port_thread_id,reviewers_json,status,
           error_stage,detail,review_workflow_id,updated_at)
          VALUES ('p',${id},0,${id},'{}',${status},${stage},${detail},${workflow},'2026-11-13T11:17:50.500Z')`;
          if (id === "missing-turn") continue;
          yield* sql`INSERT INTO projection_turns(thread_id,turn_id,requested_at,completed_at)
          VALUES (${id},'stopped','2026-11-13T11:15:21.534Z',${id === "mixed-timestamps" ? "2026-11-13T11:17:50Z" : "2026-11-13T11:17:50.454Z"}),
                 (${id},'continuation','2026-11-13T11:17:53.071Z','2026-11-13T11:27:07.869Z')`;
          if (id.startsWith("group-"))
            yield* sql`INSERT INTO upstream_port_topic_outcomes
              (project_id,topic_id,epoch,thread_id,turn_id,message_id,kind,detail,explicit,source_at)
              VALUES (${id === "group-other-project" ? "other-project" : "p"},'pr-1',1,${id},
                ${id === "group-other-turn" ? "older-turn" : "stopped"},'message',
                ${id === "group-equivalent" ? "equivalent" : id === "group-not-applicable" ? "not-applicable" : "blocked"},
                'evidence',1,'2026-11-13T11:15:21.534Z')`;
        }
        yield* Migration164;
        const rows = yield* sql<{
          port_thread_id: string;
          status: string;
          resume_after_turn_id: string | null;
        }>`SELECT port_thread_id,status,resume_after_turn_id FROM upstream_port_reviews`;
        for (const [id, status, , , , recoverable] of cases) {
          const row = rows.find((row) => row.port_thread_id === id)!;
          assert.strictEqual(row.status, status);
          assert.strictEqual(row.resume_after_turn_id, recoverable ? "stopped" : null);
        }
      }),
  );
});
