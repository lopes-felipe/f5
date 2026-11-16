import { readPersistedActiveTurnId } from "../provider/orphanedTurnRecovery.ts";
import type { ProjectId, ProviderSession, ServerSettings, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { backgroundWorkSessionIdentity } from "../provider/backgroundWorkIdentity.ts";
import { readPersistedSessionGeneration } from "../provider/sessionCapabilities.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

/** Capture before stopping providers; terminal events will clear live-work projection rows. */
export const captureRestartTurnMarkers = (input: {
  readonly sessions: ReadonlyArray<
    Pick<ProviderSession, "provider" | "threadId" | "status" | "activeTurnId">
  >;
  readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
  readonly settings: Pick<
    ServerSettings,
    "resumeActiveTurnsAfterRestart" | "projectSettingsOverrides"
  >;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const bindings = new Map(input.bindings.map((binding) => [binding.threadId, binding]));
    for (const session of input.sessions) {
      if (session.status !== "ready" && session.status !== "running") continue;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const thread = (yield* sql<{
            projectId: ProjectId;
          }>`SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${session.threadId} AND archived_at IS NULL AND deleted_at IS NULL`)[0];
          if (
            !thread ||
            !(
              input.settings.projectSettingsOverrides[thread.projectId]
                ?.resumeActiveTurnsAfterRestart ?? input.settings.resumeActiveTurnsAfterRestart
            )
          )
            return;
          const binding = bindings.get(session.threadId);
          const work =
            binding &&
            binding.provider === session.provider &&
            readPersistedSessionGeneration(binding.runtimePayload) > 0
              ? yield* sql`SELECT provider_work_item_id FROM projection_thread_background_work WHERE thread_id = ${session.threadId} AND provider_name = ${session.provider} AND provider_instance_id IS ${binding.providerInstanceId ?? null} AND provider_session_identity = ${backgroundWorkSessionIdentity(binding)} AND active = 1 AND classification IN ('working', 'monitoring') AND ownership = 'direct-subagent' LIMIT 201`
              : [];
          if (!session.activeTurnId && !work.length) return;
          const latest = (yield* sql<{
            turnId: string;
          }>`SELECT turn_id AS "turnId" FROM projection_turns WHERE thread_id = ${session.threadId} AND turn_id IS NOT NULL ORDER BY requested_at DESC, row_id DESC LIMIT 1`)[0];
          const turnId = session.activeTurnId ?? latest?.turnId;
          if (!turnId || (latest && latest.turnId !== turnId)) return;
          const continuation =
            yield* sql`SELECT c.continuation_id FROM restart_continuations c LEFT JOIN provider_turn_deliveries d ON d.delivery_id = c.continuation_id WHERE c.thread_id = ${session.threadId} AND (c.provider_turn_id = ${turnId} OR d.provider_turn_id = ${turnId} OR d.state = 'sending' OR EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id = c.thread_id AND t.turn_id = ${turnId} AND t.pending_message_id = c.continuation_id)) LIMIT 1`;
          const recovery =
            yield* sql`SELECT pending_message_id FROM projection_turns WHERE thread_id = ${session.threadId} AND turn_id = ${turnId} AND pending_message_id LIKE 'usage-resume:%'`;
          if (continuation.length || recovery.length) return;
          const continuationId = `resume:${session.threadId}:${turnId}`;
          yield* sql`INSERT INTO restart_turn_markers (thread_id, turn_id, marked_at, continuation_id, interrupted_background_work) VALUES (${session.threadId}, ${turnId}, ${new Date().toISOString()}, ${continuationId}, ${work.length}) ON CONFLICT(thread_id) DO UPDATE SET turn_id = excluded.turn_id, marked_at = excluded.marked_at, continuation_id = excluded.continuation_id, interrupted_background_work = excluded.interrupted_background_work`;
        }),
      );
    }
  });

/** Startup runs before accepting new sessions: no native work survives an absent provider runtime. */
export const recoverRestartBackgroundWork = (input: {
  readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
  readonly liveThreadIds: ReadonlySet<ThreadId>;
  readonly settings: Pick<
    ServerSettings,
    "resumeActiveTurnsAfterRestart" | "projectSettingsOverrides"
  >;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const binding of input.bindings) {
      if (input.liveThreadIds.has(binding.threadId)) continue;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (binding.status === "running" && !readPersistedActiveTurnId(binding.runtimePayload)) {
            yield* captureRestartTurnMarkers({
              sessions: [
                { provider: binding.provider, threadId: binding.threadId, status: "ready" },
              ],
              bindings: [binding],
              settings: input.settings,
            });
          }
          const at = new Date().toISOString();
          yield* sql`UPDATE projection_thread_background_work SET active = 0, status = 'interrupted', updated_at = ${at}, completed_at = ${at} WHERE thread_id = ${binding.threadId} AND provider_name = ${binding.provider} AND provider_instance_id IS ${binding.providerInstanceId ?? null} AND active = 1`;
        }),
      );
    }
  });
