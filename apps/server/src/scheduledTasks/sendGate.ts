import { scheduleAuthorityCurrent } from "./authority.ts";
import type {
  ClientThreadTurnStartCommand,
  ScheduledTask,
  ServerSettings,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
/** Whether a queued command is a thread-bound scheduled run's turn. */
export const isBoundScheduledSubmission = (sql: SqlClient.SqlClient, commandId: string) =>
  sql<{
    bound: number;
  }>`SELECT json_extract(r.snapshot_json,'$.workspace.kind')='thread' AS bound FROM scheduled_run_submissions s
    JOIN scheduled_task_runs r ON r.id=s.run_id WHERE s.submission_id=${commandId}`.pipe(
    Effect.map((rows) => rows[0]?.bound === 1),
  );
export const scheduledSendGate = (
  sql: SqlClient.SqlClient,
  settings: ServerSettings,
  commandId: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      kind: string;
      owner: number;
      capacity: number;
      canceled: number;
      epoch: number;
      enabled: number;
      ready: number;
      snapshot: string;
      command: string | null;
      thread_model_selection: string | null;
      thread_runtime_mode: string | null;
      thread_interaction_mode: string | null;
    }>`SELECT s.kind,r.owns_execution AS owner,r.capacity,r.canceled,c.epoch,c.enabled,c.ready,r.snapshot_json AS snapshot,r.command_json AS command,
      t.model_selection_json AS thread_model_selection,t.runtime_mode AS thread_runtime_mode,t.interaction_mode AS thread_interaction_mode
      FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON r.id=s.run_id JOIN scheduled_control c ON c.id=1
      LEFT JOIN projection_threads t ON t.thread_id=s.thread_id WHERE s.submission_id=${commandId}`;
    const row = rows[0];
    if (!row) return "ready" as const;
    if (!row.owner || row.canceled) return "cancel" as const;
    const snapshot = JSON.parse(row.snapshot) as Pick<
      ScheduledTask,
      "authority" | "projectId" | "workspace"
    >;
    const bound = snapshot.workspace?.kind === "thread";
    if (
      !(yield* scheduleAuthorityCurrent(
        snapshot.authority,
        snapshot.projectId,
        settings,
        sql,
        bound,
      ))
    )
      return "cancel" as const;
    // A bound item must never hold up the user's queue, and it is admitted only
    // with the conversation's settings at claim time.
    if (bound && row.command) {
      const command = JSON.parse(row.command) as ClientThreadTurnStartCommand;
      const liveSelection = row.thread_model_selection
        ? (JSON.parse(row.thread_model_selection) as unknown)
        : null;
      if (
        !liveSelection ||
        canonicalJsonHash(liveSelection) !== canonicalJsonHash(command.modelSelection) ||
        row.thread_interaction_mode !== command.interactionMode ||
        (snapshot.authority.kind === "agent"
          ? row.thread_runtime_mode !== "approval-required"
          : row.thread_runtime_mode !== command.runtimeMode)
      )
        return "cancel" as const;
    }
    const ready =
      row.capacity === 1 &&
      (row.kind === "user_input" ||
        (row.ready === 1 &&
          settings.scheduledTasks.enabled &&
          row.enabled === 1 &&
          row.epoch === settings.scheduledTasks.epoch));
    if (ready) return "ready" as const;
    // Only the brief startup readiness fence may hold a bound item; anything else
    // (disabled scheduler, lost capacity, epoch change) cancels it.
    return bound && row.ready === 1 ? ("cancel" as const) : ("wait" as const);
  });
