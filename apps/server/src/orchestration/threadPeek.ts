import {
  OrchestrationCheckpointFile,
  type OrchestrationThreadPeek,
  THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS,
  THREAD_PEEK_USER_TEXT_MAX_CHARS,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ASSISTANT_TEXT_WHITESPACE,
  truncateMessagePreview,
} from "@t3tools/shared/turnAssistantMessage";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { readTurnAssistantMessages } from "./turnAssistantMessage.ts";

const decodeCheckpointFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
);

/**
 * The sidebar hover card's server-side fields for one thread: the last prompt, the latest
 * completed turn's final reply (never a streaming one), and the latest checkpoint's diff totals.
 */
export function readThreadPeek(sql: SqlClient.SqlClient, threadId: ThreadId) {
  return Effect.gen(function* () {
    const [userRow] = yield* sql<{ text: string }>`
      SELECT text FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND length(trim(text, ${ASSISTANT_TEXT_WHITESPACE})) > 0
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1`;
    const [turnRow] = yield* sql<{ turn_id: string }>`
      SELECT turn_id FROM projection_turns
      WHERE thread_id = ${threadId} AND turn_id IS NOT NULL AND state = 'completed'
      ORDER BY requested_at DESC, turn_id DESC
      LIMIT 1`;
    const [reply] = turnRow
      ? yield* readTurnAssistantMessages(sql, [{ threadId, turnId: turnRow.turn_id }])
      : [];
    const [checkpointRow] = yield* sql<{ files: string }>`
      SELECT checkpoint_files_json AS files FROM projection_turns
      WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count DESC
      LIMIT 1`;
    const files = checkpointRow
      ? Option.getOrElse(decodeCheckpointFiles(checkpointRow.files), () => [])
      : [];
    return {
      threadId,
      lastUserText: userRow
        ? truncateMessagePreview(userRow.text, THREAD_PEEK_USER_TEXT_MAX_CHARS)
        : null,
      lastAssistantText: reply
        ? truncateMessagePreview(reply.text, THREAD_PEEK_ASSISTANT_TEXT_MAX_CHARS)
        : null,
      latestTurnDiff:
        files.length === 0
          ? null
          : {
              files: files.length,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            },
    } satisfies OrchestrationThreadPeek;
  });
}
