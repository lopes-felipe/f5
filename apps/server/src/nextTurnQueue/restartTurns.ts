import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { canonicalRequestHash } from "./canonicalRequestHash.ts";

export const recoverRestartTurnMarkers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const store = yield* NextTurnQueueStore;
  const resumed: ThreadId[] = [];
  yield* sql`DELETE FROM restart_turn_markers WHERE marked_at < ${new Date(Date.now() - 30 * 60_000).toISOString()}`;
  const markers = yield* sql<{
    readonly threadId: string;
    readonly continuationId: string;
  }>`SELECT thread_id AS "threadId", continuation_id AS "continuationId" FROM restart_turn_markers`;
  const model = yield* engine.getReadModel();
  for (const marker of markers) {
    const thread = model.threads.find((thread) => thread.id === marker.threadId);
    if (
      !thread ||
      thread.archivedAt ||
      thread.session?.activeTurnId ||
      thread.pendingUserInputs?.length
    )
      continue;
    const queue = yield* store.listByThread(thread.id);
    if (
      queue.items.some(
        (item) => item.status === "dispatching" || item.lastErrorCode === "delivery_ambiguous",
      )
    )
      continue;
    const blocked =
      yield* sql`SELECT request_id FROM projection_pending_approvals WHERE thread_id = ${thread.id} AND status = 'pending' UNION ALL SELECT operation_id FROM rewind_requests WHERE thread_id = ${thread.id} UNION ALL SELECT delivery_id FROM provider_turn_deliveries WHERE thread_id = ${thread.id} AND state IN ('pending', 'sending', 'ambiguous')`;
    if (blocked.length) continue;
    const id = CommandId.makeUnsafe(marker.continuationId);
    const command = {
      type: "thread.turn.start" as const,
      commandId: id,
      threadId: thread.id,
      message: {
        messageId: MessageId.makeUnsafe(marker.continuationId),
        role: "user" as const,
        text: "Continue the interrupted turn from where you left off. Check the current state before taking further actions.",
        attachments: [],
      },
      model: thread.model,
      ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      presentation: "continuation" as const,
      createdAt: new Date().toISOString(),
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const present =
            yield* sql`SELECT thread_id FROM restart_turn_markers WHERE continuation_id = ${marker.continuationId}`;
          if (!present.length) return;
          const existing =
            yield* sql`SELECT submission_id FROM turn_submissions WHERE submission_id = ${id}`;
          if (existing.length) {
            yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${id}`;
            return;
          }
          yield* store.insertSubmission({
            submissionId: id,
            itemId: id,
            requestHash: canonicalRequestHash(command),
            command,
            atHead: false,
          });
          yield* sql`INSERT OR IGNORE INTO restart_continuations(continuation_id, thread_id) VALUES (${id}, ${thread.id})`;
          yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${id}`;
        }),
      )
      .pipe(Effect.mapError((error) => new Error(String(error))));
    resumed.push(thread.id);
  }
  return resumed;
});
