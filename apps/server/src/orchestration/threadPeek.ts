import {
  OrchestrationCheckpointFile,
  type OrchestrationThreadPeek,
  THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS,
  THREAD_PEEK_USER_TEXT_MAX_CHARS,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ASSISTANT_TEXT_WHITESPACE,
  isTurnInProgress,
  truncateMessagePreview,
} from "@t3tools/shared/turnAssistantMessage";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeCheckpointFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
);

/**
 * The sidebar hover card's server-side fields for one thread: the last prompt, the newest
 * settled reply outside a turn still in progress (the client's `localThreadPeek` rule), and
 * the latest checkpoint's diff totals.
 */
export function readThreadPeek(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return Effect.gen(function* () {
    const [userRow] = yield* sql<{ text: string }>`
      SELECT text FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND length(trim(text, ${ASSISTANT_TEXT_WHITESPACE})) > 0
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`;
    const [latestTurn] = yield* sql<{ turn_id: string; state: string }>`
      SELECT turn_id, state FROM projection_turns
      WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
      ORDER BY requested_at DESC, turn_id DESC
      LIMIT 1`;
    const inProgressTurnId =
      latestTurn && isTurnInProgress(latestTurn.state) ? latestTurn.turn_id : null;
    const [reply] = yield* sql<{ text: string }>`
      SELECT text FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'assistant' AND is_streaming = 0
        AND length(trim(text, ${ASSISTANT_TEXT_WHITESPACE})) > 0
        ${inProgressTurnId === null ? sql`` : sql`AND (turn_id IS NULL OR turn_id <> ${inProgressTurnId})`}
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`;
    const [checkpointRow] = yield* sql<{ files: string }>`
      SELECT checkpoint_files_json AS files FROM projection_turns
      WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count DESC
      LIMIT 1`;
    return toThreadPeek(threadId, {
      userText: userRow?.text ?? null,
      replyText: reply?.text ?? null,
      checkpointFiles: checkpointRow?.files ?? null,
    });
  });
}

function toThreadPeek(
  threadId: ThreadId,
  row: {
    readonly userText: string | null;
    readonly replyText: string | null;
    readonly checkpointFiles: string | null;
  },
): OrchestrationThreadPeek {
  const files =
    row.checkpointFiles === null
      ? []
      : Option.getOrElse(decodeCheckpointFiles(row.checkpointFiles), () => []);
  return {
    threadId,
    lastUserText:
      row.userText === null
        ? null
        : truncateMessagePreview(row.userText, THREAD_PEEK_USER_TEXT_MAX_CHARS),
    lastAssistantText:
      row.replyText === null
        ? null
        : truncateMessagePreview(row.replyText, THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS),
    latestTurnDiff:
      files.length === 0
        ? null
        : {
            files: files.length,
            additions: files.reduce((sum, file) => sum + file.additions, 0),
            deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          },
  };
}

/**
 * Peeks for several threads in one request (Home's queue rows), in the order asked and once
 * per thread. Ids of threads that do not exist, or were deleted, are left out; `readThreadPeek`
 * does not look the thread up and answers such an id with an empty peek.
 *
 * Two statements cover every thread, so a full request does not hold the synchronous SQLite
 * connection for four statements per thread. Each field is still read with a `LIMIT 1` walk
 * of its index, as `readThreadPeek` does, not by ranking every row of the thread.
 */
export function readThreadPeeks(sql: SqlClient.SqlClient, threadIds: ReadonlyArray<ThreadId>) {
  return Effect.gen(function* () {
    const unique = [...new Set(threadIds)];
    if (unique.length === 0) return [] as OrchestrationThreadPeek[];
    const rows = yield* sql<{
      threadId: ThreadId;
      userText: string | null;
      latestTurnId: string | null;
      latestTurnState: string | null;
      checkpointFiles: string | null;
    }>`
      SELECT t.thread_id AS "threadId",
        (SELECT m.text FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.role = 'user'
            AND length(trim(m.text, ${ASSISTANT_TEXT_WHITESPACE})) > 0
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT 1) AS "userText",
        (SELECT p.turn_id FROM projection_turns p
          WHERE p.thread_id = t.thread_id AND p.turn_id IS NOT NULL
          ORDER BY p.requested_at DESC, p.turn_id DESC
          LIMIT 1) AS "latestTurnId",
        (SELECT p.state FROM projection_turns p
          WHERE p.thread_id = t.thread_id AND p.turn_id IS NOT NULL
          ORDER BY p.requested_at DESC, p.turn_id DESC
          LIMIT 1) AS "latestTurnState",
        (SELECT p.checkpoint_files_json FROM projection_turns p
          WHERE p.thread_id = t.thread_id AND p.checkpoint_turn_count IS NOT NULL
          ORDER BY p.checkpoint_turn_count DESC
          LIMIT 1) AS "checkpointFiles"
      FROM projection_threads t
      WHERE ${sql.in("thread_id", unique)} AND t.deleted_at IS NULL`;
    if (rows.length === 0) return [] as OrchestrationThreadPeek[];
    // Each thread's reply skips its own turn in progress, so the pairs go in as one JSON value.
    const replyScopes = JSON.stringify(
      rows.map((row) => [
        row.threadId,
        isTurnInProgress(row.latestTurnState) ? row.latestTurnId : null,
      ]),
    );
    const replies = yield* sql<{ threadId: string; text: string | null }>`
      SELECT json_extract(scope.value, '$[0]') AS "threadId",
        (SELECT m.text FROM projection_thread_messages m
          WHERE m.thread_id = json_extract(scope.value, '$[0]')
            AND m.role = 'assistant' AND m.is_streaming = 0
            AND length(trim(m.text, ${ASSISTANT_TEXT_WHITESPACE})) > 0
            AND (json_extract(scope.value, '$[1]') IS NULL OR m.turn_id IS NULL
              OR m.turn_id <> json_extract(scope.value, '$[1]'))
          ORDER BY m.created_at DESC, m.message_id DESC
          LIMIT 1) AS "text"
      FROM json_each(${replyScopes}) scope`;
    const replyByThread = new Map(replies.map((reply) => [reply.threadId, reply.text]));
    const peekByThread = new Map(
      rows.map((row) => [
        row.threadId,
        toThreadPeek(row.threadId, {
          userText: row.userText,
          replyText: replyByThread.get(row.threadId) ?? null,
          checkpointFiles: row.checkpointFiles,
        }),
      ]),
    );
    return unique.flatMap((threadId) => peekByThread.get(threadId) ?? []);
  });
}
