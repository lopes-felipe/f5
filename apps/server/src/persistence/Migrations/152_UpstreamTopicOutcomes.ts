import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE upstream_port_topic_outcomes (
    project_id TEXT NOT NULL, topic_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pr','equivalent','not-applicable','blocked')),
    detail TEXT NOT NULL, explicit INTEGER NOT NULL, source_at TEXT NOT NULL,
    PRIMARY KEY(project_id,topic_id,epoch,thread_id)
  )`;
  yield* sql`CREATE INDEX upstream_topic_outcomes_thread
    ON upstream_port_topic_outcomes(project_id,thread_id)`;
  yield* sql`CREATE INDEX projection_messages_turn_reply
    ON projection_thread_messages(thread_id,turn_id,created_at DESC,message_id DESC)
    WHERE role = 'assistant' AND is_streaming = 0`;
  // Checkpoint events used to overwrite the real reply with a synthetic tool id.
  // Repair only broken ownership; replay is protected by the projectors as well.
  yield* sql`UPDATE projection_turns AS t SET assistant_message_id = (
    SELECT m.message_id FROM projection_thread_messages m
    WHERE m.thread_id = t.thread_id AND m.turn_id = t.turn_id
      AND m.role = 'assistant' AND m.is_streaming = 0
      AND length(trim(m.text, char(32,9,10,11,12,13))) > 0
    ORDER BY m.created_at DESC,m.message_id DESC LIMIT 1
  ) WHERE NOT EXISTS (
    SELECT 1 FROM projection_thread_messages m
    WHERE m.message_id = t.assistant_message_id AND m.thread_id = t.thread_id
      AND m.turn_id = t.turn_id AND m.role = 'assistant'
  ) AND EXISTS (
    SELECT 1 FROM projection_thread_messages m
    WHERE m.thread_id = t.thread_id AND m.turn_id = t.turn_id
      AND m.role = 'assistant' AND m.is_streaming = 0
      AND length(trim(m.text, char(32,9,10,11,12,13))) > 0
  )`;
});
