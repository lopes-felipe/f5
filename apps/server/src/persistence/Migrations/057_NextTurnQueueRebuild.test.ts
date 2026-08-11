import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0054 from "./054_NextTurnQueue.ts";
import Migration0057 from "./057_NextTurnQueueRebuild.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("057_NextTurnQueueRebuild", (it) => {
  it.effect("hands off legacy attachments and creates cascading durable queue tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
      yield* Migration0054;
      yield* sql`
        INSERT INTO next_turn_queue (
          item_id, thread_id, command_id, position, status, allow_after_error,
          command_json, created_at, updated_at
        ) VALUES (
          'legacy-item', 'thread-1', 'legacy-command', 0, 'queued', 0,
          ${JSON.stringify({ message: { attachments: [{ id: "attachment-1" }] } })},
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* Migration0057;
      yield* Migration0057;

      const orphaned = yield* sql<{ readonly attachmentId: string }>`
        SELECT attachment_id AS "attachmentId"
        FROM next_turn_queue_orphaned_attachments
      `;
      assert.deepStrictEqual(orphaned, [{ attachmentId: "attachment-1" }]);

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('next_turn_queue')
      `;
      assert(columns.some((column) => column.name === "submission_id"));
      assert(columns.some((column) => column.name === "lease_owner"));

      yield* sql`
        INSERT INTO next_turn_queue_state (thread_id, updated_at)
        VALUES ('thread-1', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO turn_submissions (
          submission_id, thread_id, request_hash, message_id, disposition, created_at
        ) VALUES (
          'submission-1', 'thread-1', 'hash', 'message-1', 'pending',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO next_turn_queue (
          item_id, thread_id, submission_id, command_id, message_id, position,
          command_json, created_at, updated_at
        ) VALUES (
          'item-1', 'thread-1', 'submission-1', 'command-1', 'message-1', 0,
          '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-1'`;

      const counts = yield* sql<{
        readonly queue: number;
        readonly state: number;
        readonly submissions: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM next_turn_queue) AS queue,
          (SELECT COUNT(*) FROM next_turn_queue_state) AS state,
          (SELECT COUNT(*) FROM turn_submissions) AS submissions
      `;
      assert.deepStrictEqual(counts, [{ queue: 0, state: 0, submissions: 0 }]);
    }),
  );
});
