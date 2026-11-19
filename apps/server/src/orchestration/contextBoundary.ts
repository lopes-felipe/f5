import type { OrchestrationThread } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const readThreadAfterContextBoundary = Effect.fnUntraced(function* (
  thread: OrchestrationThread,
  sql: SqlClient.SqlClient | undefined,
  includePending = false,
) {
  const rows = sql
    ? yield* sql.unsafe<{ messageId: string; createdAt: string }>(
        "SELECT message_id AS messageId, created_at AS createdAt FROM thread_context_boundaries WHERE thread_id = ? AND (prepared = 1 OR ? = 1)",
        [thread.id, includePending ? 1 : 0],
      )
    : [];
  // The timeline event also carries the committed boundary: projection rebuilds and
  // a subsequent pending reset must not bring pre-clear history back into summaries.
  const marker = thread.activities.findLast(
    (activity) => activity.kind === "session.context-reset",
  );
  const payload = marker?.payload as { messageId?: string } | undefined;
  const boundary =
    rows[0] ??
    (marker
      ? {
          messageId:
            payload?.messageId ??
            thread.messages.find((message) => message.createdAt === marker.createdAt)?.id ??
            "",
          createdAt: marker.createdAt,
        }
      : undefined);
  return boundary ? threadAfterContextBoundary(thread, boundary) : thread;
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
    proposedPlans: thread.proposedPlans.filter((plan) => plan.createdAt >= boundary.createdAt),
    activities: thread.activities.filter((activity) => activity.createdAt >= boundary.createdAt),
    checkpoints: thread.checkpoints.filter(
      (checkpoint) => checkpoint.completedAt >= boundary.createdAt,
    ),
    tasks: thread.tasksUpdatedAt && thread.tasksUpdatedAt >= boundary.createdAt ? thread.tasks : [],
    tasksUpdatedAt:
      thread.tasksUpdatedAt && thread.tasksUpdatedAt >= boundary.createdAt
        ? thread.tasksUpdatedAt
        : null,
    tasksTurnId:
      thread.tasksUpdatedAt && thread.tasksUpdatedAt >= boundary.createdAt
        ? thread.tasksTurnId
        : null,
    sessionNotes:
      thread.sessionNotes && thread.sessionNotes.sourceLastInteractionAt >= boundary.createdAt
        ? thread.sessionNotes
        : null,
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
