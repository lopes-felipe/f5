import type { OrchestrationEvent } from "@t3tools/contracts";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "./Errors.ts";

type MessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

/** Only for metadata-free deltas whose message identity was verified in this transaction. */
export const makeStreamingProjectionUpdates = (sql: SqlClient.SqlClient) => {
  const increment = (event: MessageEvent) =>
    roughTokenEstimateFromCharacters(
      event.payload.text.length + (event.payload.reasoningText?.length ?? 0),
    );
  return {
    thread: (event: MessageEvent) =>
      sql`
      UPDATE projection_threads
      SET estimated_context_tokens = CASE WHEN EXISTS (
        SELECT 1 FROM projection_thread_sessions
        WHERE thread_id = ${event.payload.threadId} AND token_usage_source = 'provider'
      ) THEN estimated_context_tokens ELSE estimated_context_tokens + ${increment(event)} END,
      last_interaction_at = ${event.occurredAt}, updated_at = ${event.occurredAt}
      WHERE thread_id = ${event.payload.threadId} AND (
        estimated_context_tokens IS NOT NULL OR EXISTS (
          SELECT 1 FROM projection_thread_sessions
          WHERE thread_id = ${event.payload.threadId} AND token_usage_source = 'provider'
        )
      ) RETURNING thread_id
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("streamingProjection.thread")),
      ),
    session: (event: MessageEvent) =>
      sql`
      UPDATE projection_thread_sessions
      SET estimated_context_tokens = CASE WHEN token_usage_source = 'provider' THEN estimated_context_tokens
        ELSE COALESCE(estimated_context_tokens, (
          SELECT estimated_context_tokens FROM projection_threads WHERE thread_id = ${event.payload.threadId}
        )) + ${increment(event)} END,
      token_usage_source = CASE WHEN token_usage_source = 'provider' THEN token_usage_source ELSE 'estimated' END,
      updated_at = ${event.occurredAt}
      WHERE thread_id = ${event.payload.threadId} AND (
        token_usage_source = 'provider' OR COALESCE(estimated_context_tokens, (
          SELECT estimated_context_tokens FROM projection_threads WHERE thread_id = ${event.payload.threadId}
        )) IS NOT NULL
      ) RETURNING thread_id
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("streamingProjection.session")),
      ),
    turn: (event: MessageEvent) =>
      sql`
      UPDATE projection_turns
      SET assistant_message_id = ${event.payload.messageId},
        started_at = COALESCE(started_at, ${event.payload.createdAt}),
        requested_at = COALESCE(requested_at, ${event.payload.createdAt})
      WHERE thread_id = ${event.payload.threadId} AND turn_id = ${event.payload.turnId}
      RETURNING turn_id
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("streamingProjection.turn")),
      ),
  };
};
