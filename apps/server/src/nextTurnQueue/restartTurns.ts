import { ServerSettingsService } from "../serverSettings.ts";
import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import { holdsAutomaticResume } from "@t3tools/shared/pendingUserInputs";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NextTurnQueueStore } from "./Services/NextTurnQueueStore.ts";
import { canonicalRequestHash } from "./canonicalRequestHash.ts";

export const recoverRestartTurnMarkers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const store = yield* NextTurnQueueStore;
  const settingsOption = yield* Effect.serviceOption(ServerSettingsService);
  const resumed: ThreadId[] = [];
  yield* sql`DELETE FROM restart_turn_markers WHERE marked_at < ${new Date(Date.now() - 30 * 60_000).toISOString()}`;
  const markers = yield* sql<{
    readonly threadId: string;
    readonly continuationId: string;
    readonly turnId: string;
  }>`SELECT thread_id AS "threadId", continuation_id AS "continuationId", turn_id AS "turnId" FROM restart_turn_markers`;
  const hasBlockedWork = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const queue = yield* store.listByThread(threadId);
      if (
        queue.items.some(
          (item) =>
            item.status === "queued" ||
            item.status === "dispatching" ||
            item.lastErrorCode === "delivery_ambiguous",
        )
      )
        return true;
      const blocked =
        yield* sql`SELECT request_id FROM projection_pending_approvals WHERE thread_id = ${threadId} AND status = 'pending' UNION ALL SELECT operation_id FROM rewind_requests WHERE thread_id = ${threadId} UNION ALL SELECT delivery_id FROM provider_turn_deliveries WHERE thread_id = ${threadId} AND state IN ('pending', 'sending', 'ambiguous')`;
      return blocked.length > 0;
    });
  const model = yield* engine.getReadModel();
  for (const marker of markers) {
    const thread = model.threads.find((thread) => thread.id === marker.threadId);
    const settings = Option.isSome(settingsOption)
      ? yield* settingsOption.value.getSettings
      : undefined;
    const enabled =
      thread &&
      settings &&
      (settings.projectSettingsOverrides[thread.projectId]?.resumeActiveTurnsAfterRestart ??
        settings.resumeActiveTurnsAfterRestart);
    if (!thread || !enabled || thread.latestTurn?.turnId !== marker.turnId) {
      yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${marker.continuationId}`;
      continue;
    }
    if (
      !thread ||
      thread.archivedAt ||
      thread.session?.activeTurnId ||
      thread.pendingUserInputs?.some(holdsAutomaticResume)
    )
      continue;
    if (yield* hasBlockedWork(thread.id)) continue;
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
    const inserted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const present =
            yield* sql`SELECT thread_id FROM restart_turn_markers WHERE continuation_id = ${marker.continuationId} AND turn_id = ${marker.turnId}`;
          if (!present.length) return false;
          const existing =
            yield* sql`SELECT submission_id FROM turn_submissions WHERE submission_id = ${id}`;
          if (existing.length) {
            yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${id}`;
            return false;
          }
          const current = (yield* engine.getReadModel()).threads.find(
            (entry) => entry.id === thread.id,
          );
          const effective = Option.isSome(settingsOption)
            ? yield* settingsOption.value.getSettings
            : undefined;
          const optedIn =
            effective &&
            (effective.projectSettingsOverrides[thread.projectId]?.resumeActiveTurnsAfterRestart ??
              effective.resumeActiveTurnsAfterRestart);
          const latest = (yield* sql<{
            turnId: string;
          }>`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${thread.id} AND turn_id IS NOT NULL ORDER BY requested_at DESC LIMIT 1`)[0];
          if (
            !optedIn ||
            !current ||
            current.latestTurn?.turnId !== marker.turnId ||
            latest?.turnId !== marker.turnId
          ) {
            yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${id}`;
            return false;
          }
          if (
            current.archivedAt ||
            current.session?.activeTurnId ||
            current.pendingUserInputs?.some(holdsAutomaticResume) ||
            (yield* hasBlockedWork(thread.id))
          )
            return false;
          yield* store.insertSubmission({
            submissionId: id,
            itemId: id,
            requestHash: canonicalRequestHash(command),
            command,
            atHead: false,
          });
          yield* sql`INSERT OR IGNORE INTO restart_continuations(continuation_id, thread_id) VALUES (${id}, ${thread.id})`;
          yield* sql`DELETE FROM restart_turn_markers WHERE continuation_id = ${id}`;
          return true;
        }),
      )
      .pipe(Effect.mapError((error) => new Error(String(error))));
    if (inserted) resumed.push(thread.id);
  }
  return resumed;
});
