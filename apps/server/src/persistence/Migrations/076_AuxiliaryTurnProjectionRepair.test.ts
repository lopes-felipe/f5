import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0076 from "./076_AuxiliaryTurnProjectionRepair.ts";

it.layer(SqliteClient.layerMemory())("076_AuxiliaryTurnProjectionRepair", (it) => {
  it.effect("removes auxiliary rows and settles only confirmed parent turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_events (
          sequence INTEGER PRIMARY KEY,
          stream_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_messages (
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          is_streaming INTEGER NOT NULL,
          text TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE projection_turns (
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          processing_quiesced_at TEXT
        )
      `;
      yield* sql`
        CREATE TABLE provider_terminal_events (
          event_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          event_type TEXT NOT NULL,
          event_json TEXT NOT NULL,
          received_at TEXT NOT NULL,
          applied_at TEXT
        )
      `;

      const threadId = "thread-parent";
      const parentTurnId = "turn-parent";
      const auxiliaryTurnId = "turn-auxiliary";
      const liveTurnId = "turn-live";
      const unconfirmedTurnId = "turn-unconfirmed";
      const startedAt = "2026-08-19T20:00:00.000Z";
      const completedAt = "2026-08-19T20:10:00.000Z";
      const quiescedAt = "2026-08-19T20:10:01.000Z";

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at,
          completed_at, processing_quiesced_at
        ) VALUES
          (${threadId}, ${parentTurnId}, 'running', ${startedAt}, ${startedAt}, NULL, NULL),
          (${threadId}, ${auxiliaryTurnId}, 'completed', ${startedAt}, ${startedAt}, ${completedAt}, NULL),
          (${threadId}, ${liveTurnId}, 'running', ${startedAt}, ${startedAt}, NULL, NULL),
          (${threadId}, ${unconfirmedTurnId}, 'running', ${startedAt}, ${startedAt}, NULL, NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          thread_id, turn_id, role, is_streaming, text
        ) VALUES
          (${threadId}, ${parentTurnId}, 'assistant', 0, 'parent final'),
          (${threadId}, ${auxiliaryTurnId}, 'assistant', 0, 'auxiliary final'),
          (${threadId}, ${unconfirmedTurnId}, 'assistant', 0, 'unconfirmed final')
      `;
      yield* sql`
        INSERT INTO orchestration_events (sequence, stream_id, event_type, payload_json)
        VALUES
          (1, ${threadId}, 'thread.session-set', ${JSON.stringify({
            session: { activeTurnId: parentTurnId },
          })}),
          (2, ${threadId}, 'thread.turn-processing-quiesced', ${JSON.stringify({
            turnId: parentTurnId,
            processingQuiescedAt: quiescedAt,
          })})
      `;
      yield* sql`
        INSERT INTO provider_terminal_events (
          event_id, thread_id, turn_id, event_type, event_json, received_at, applied_at
        ) VALUES
          ('receipt-parent', ${threadId}, ${parentTurnId}, 'turn.completed', ${JSON.stringify({
            createdAt: completedAt,
            payload: { state: "completed" },
          })}, ${completedAt}, ${completedAt}),
          ('receipt-auxiliary', ${threadId}, ${auxiliaryTurnId}, 'turn.completed', ${JSON.stringify(
            {
              createdAt: completedAt,
              payload: { state: "completed" },
            },
          )}, ${completedAt}, ${completedAt})
      `;

      yield* Migration0076;
      yield* Migration0076;

      const rows = yield* sql<{
        readonly turnId: string;
        readonly state: string;
        readonly completedAt: string | null;
        readonly processingQuiescedAt: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          state,
          completed_at AS "completedAt",
          processing_quiesced_at AS "processingQuiescedAt"
        FROM projection_turns
        ORDER BY turn_id
      `;
      assert.deepStrictEqual(rows, [
        {
          turnId: liveTurnId,
          state: "running",
          completedAt: null,
          processingQuiescedAt: null,
        },
        {
          turnId: parentTurnId,
          state: "completed",
          completedAt,
          processingQuiescedAt: quiescedAt,
        },
        {
          turnId: unconfirmedTurnId,
          state: "running",
          completedAt: null,
          processingQuiescedAt: null,
        },
      ]);
    }),
  );
});
