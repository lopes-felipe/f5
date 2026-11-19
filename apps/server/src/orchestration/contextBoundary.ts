import type { OrchestrationThread } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const readThreadAfterContextBoundary = Effect.fnUntraced(function* (
  thread: OrchestrationThread,
  sql: SqlClient.SqlClient | undefined,
) {
  if (!sql) return thread;
  const rows = yield* sql.unsafe<{ messageId: string; createdAt: string }>(
    "SELECT message_id AS messageId, created_at AS createdAt FROM thread_context_boundaries WHERE thread_id = ?",
    [thread.id],
  );
  return rows[0] ? threadAfterContextBoundary(thread, rows[0]) : thread;
});

/** Keep the timeline intact; only provider-facing snapshots cross this boundary. */
export function threadAfterContextBoundary(
  thread: OrchestrationThread,
  boundary: {
    readonly messageId: string;
    readonly createdAt: string;
  },
): OrchestrationThread {
  const index = thread.messages.findIndex((message) => message.id === boundary.messageId);
  return {
    ...thread,
    messages:
      index >= 0
        ? thread.messages.slice(index)
        : thread.messages.filter((message) => message.createdAt > boundary.createdAt),
    compaction:
      thread.compaction && thread.compaction.createdAt > boundary.createdAt
        ? thread.compaction
        : null,
  };
}
