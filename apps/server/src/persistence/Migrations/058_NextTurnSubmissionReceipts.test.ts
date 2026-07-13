import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0058 from "./058_NextTurnSubmissionReceipts.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("058_NextTurnSubmissionReceipts", (it) => {
  it.effect("backfills historical starts before startup replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          stream_id,
          event_type,
          occurred_at,
          command_id
        ) VALUES (
          1,
          'event-historical-turn-start',
          'thread-historical',
          'thread.turn-start-requested',
          '2026-07-12T09:00:00.000Z',
          'command-historical-turn-start'
        )
      `;

      yield* Migration0058;

      const receipts = yield* sql<{
        readonly commandId: string;
        readonly eventId: string;
        readonly threadId: string;
        readonly status: string;
        readonly ownerId: string;
      }>`
        SELECT
          command_id AS "commandId",
          event_id AS "eventId",
          thread_id AS "threadId",
          status,
          owner_id AS "ownerId"
        FROM provider_turn_intent_receipts
      `;
      const submissionTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'next_turn_submission_receipts'
      `;

      assert.deepEqual(receipts, [
        {
          commandId: "command-historical-turn-start",
          eventId: "event-historical-turn-start",
          threadId: "thread-historical",
          status: "accepted",
          ownerId: "migration:058",
        },
      ]);
      assert.equal(submissionTable[0]?.name, "next_turn_submission_receipts");
    }),
  );
});
