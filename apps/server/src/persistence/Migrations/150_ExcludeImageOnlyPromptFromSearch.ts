import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerSendText";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// SQLite's trim() strips only spaces unless told which characters to strip.
const PLACEHOLDER_CONDITION = (text: string) =>
  `trim(${text}, char(32, 9, 10, 11, 12, 13)) <> '${IMAGE_ONLY_BOOTSTRAP_PROMPT.replaceAll("'", "''")}'`;

/**
 * Image-only messages carry a prompt the timeline hides, so global search must
 * not match it either. Recreates 055's message triggers without it and drops
 * the placeholders already indexed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const index =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_documents'`;
  if (index.length === 0) return;
  const messageBody = `
    DELETE FROM search_documents WHERE document_key = 'message:' || new.message_id;
    INSERT INTO search_documents (
      document_key, kind, entity_id, project_id, thread_id, message_id, turn_id,
      title, content, role, created_at
    )
    SELECT
      'message:' || new.message_id, 'message', new.message_id, thread.project_id,
      new.thread_id, new.message_id, new.turn_id, thread.title, new.text, new.role, new.created_at
    FROM projection_threads AS thread
    WHERE thread.thread_id = new.thread_id
      AND thread.deleted_at IS NULL
      AND new.role IN ('user', 'assistant')
      AND length(trim(new.text)) > 0
      AND (new.role <> 'user' OR ${PLACEHOLDER_CONDITION("new.text")});
  `;
  for (const operation of ["INSERT", "UPDATE"] as const) {
    const name = `search_projection_thread_messages_${operation.toLowerCase()}`;
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${name}`);
    yield* sql.unsafe(
      `CREATE TRIGGER ${name} AFTER ${operation} ON projection_thread_messages BEGIN ${messageBody} END`,
    );
  }
  yield* sql.unsafe(`
    DELETE FROM search_documents
    WHERE kind = 'message' AND role = 'user' AND NOT (${PLACEHOLDER_CONDITION("content")})
  `);
});
