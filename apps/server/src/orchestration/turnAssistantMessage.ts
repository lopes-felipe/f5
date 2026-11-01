import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

interface TurnAssistantMessage {
  readonly id: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** Messages must be in creation order and already scoped to one thread. */
export function resolveTurnAssistantMessage<M extends TurnAssistantMessage>(
  messages: ReadonlyArray<M>,
  turnId: string,
): M | undefined {
  return messages.findLast(
    (message) =>
      message.turnId === turnId &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
}

export interface TurnMessageIdentity {
  readonly threadId: string;
  readonly turnId: string;
}

/** Read at most one actual text reply per turn, including turns outside the model's retained tail. */
export function readTurnAssistantMessages(
  sql: SqlClient.SqlClient,
  turns: ReadonlyArray<TurnMessageIdentity>,
) {
  return Effect.gen(function* () {
    if (!turns.length) return [];
    const rows = yield* sql<{
      thread_id: string;
      turn_id: string;
      message_id: string;
      text: string;
    }>`WITH replies AS (
      SELECT thread_id,turn_id,message_id,text,
        ROW_NUMBER() OVER (PARTITION BY thread_id,turn_id ORDER BY created_at DESC,message_id DESC) AS rank
      FROM projection_thread_messages WHERE role = 'assistant' AND is_streaming = 0
        AND length(trim(text, char(32,9,10,11,12,13))) > 0
        AND ${sql.in("thread_id", [...new Set(turns.map((turn) => turn.threadId))])}
        AND ${sql.in("turn_id", [...new Set(turns.map((turn) => turn.turnId))])}
    ) SELECT thread_id,turn_id,message_id,text FROM replies WHERE rank = 1`;
    const requested = new Set(turns.map((turn) => JSON.stringify([turn.threadId, turn.turnId])));
    return rows
      .filter((row) => requested.has(JSON.stringify([row.thread_id, row.turn_id])))
      .map((row) => ({
        threadId: row.thread_id,
        turnId: row.turn_id,
        id: row.message_id,
        role: "assistant",
        text: row.text,
        streaming: false,
      }));
  });
}
