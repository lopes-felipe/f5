import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0057 from "./057_NextTurnQueueReliability.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("057_NextTurnQueueReliability", (it) => {
  it.effect("preserves legacy rows and maps their error policy", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const queuedCommand = JSON.stringify({ type: "thread.turn.start", commandId: "command-1" });
      const pausedCommand = JSON.stringify({ type: "thread.turn.start", commandId: "command-2" });

      yield* sql`
        CREATE TABLE next_turn_queue (
          item_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          command_id TEXT NOT NULL UNIQUE,
          position INTEGER NOT NULL CHECK (position >= 0),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'paused')),
          allow_after_error INTEGER NOT NULL DEFAULT 0 CHECK (allow_after_error IN (0, 1)),
          command_json TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dispatch_started_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO next_turn_queue (
          item_id,
          thread_id,
          command_id,
          position,
          status,
          allow_after_error,
          command_json,
          last_error,
          created_at,
          updated_at,
          dispatch_started_at
        ) VALUES
          (
            'item-1',
            'thread-1',
            'command-1',
            0,
            'queued',
            0,
            ${queuedCommand},
            NULL,
            '2026-07-13T10:00:00.000Z',
            '2026-07-13T10:00:01.000Z',
            NULL
          ),
          (
            'item-2',
            'thread-1',
            'command-2',
            1,
            'paused',
            1,
            ${pausedCommand},
            'Previous turn failed.',
            '2026-07-13T10:00:02.000Z',
            '2026-07-13T10:00:03.000Z',
            '2026-07-13T10:00:04.000Z'
          )
      `;

      yield* Migration0057;

      const rows = yield* sql<{
        readonly itemId: string;
        readonly status: string;
        readonly failurePolicy: string;
        readonly revision: number;
        readonly envelopeVersion: number;
        readonly blockerCode: string | null;
        readonly blockerMessage: string | null;
        readonly blockerResumable: number | null;
        readonly dispatchStartedAt: string | null;
      }>`
        SELECT
          item_id AS "itemId",
          status,
          failure_policy AS "failurePolicy",
          revision,
          envelope_version AS "envelopeVersion",
          blocker_code AS "blockerCode",
          blocker_message AS "blockerMessage",
          blocker_resumable AS "blockerResumable",
          dispatch_started_at AS "dispatchStartedAt"
        FROM next_turn_queue
        ORDER BY position ASC
      `;
      const versions = yield* sql<{ readonly threadId: string; readonly version: number }>`
        SELECT thread_id AS "threadId", version
        FROM next_turn_queue_threads
      `;

      assert.deepEqual(rows, [
        {
          itemId: "item-1",
          status: "queued",
          failurePolicy: "stop",
          revision: 0,
          envelopeVersion: 1,
          blockerCode: null,
          blockerMessage: null,
          blockerResumable: null,
          dispatchStartedAt: null,
        },
        {
          itemId: "item-2",
          status: "paused",
          failurePolicy: "continue",
          revision: 0,
          envelopeVersion: 1,
          blockerCode: "queue_paused",
          blockerMessage: "Previous turn failed.",
          blockerResumable: 1,
          dispatchStartedAt: "2026-07-13T10:00:04.000Z",
        },
      ]);
      assert.deepEqual(versions, [{ threadId: "thread-1", version: 1 }]);
    }),
  );
});
