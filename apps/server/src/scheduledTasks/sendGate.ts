import { scheduleAuthorityCurrent } from "./authority.ts";
import type { ServerSettings } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
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
    }>`SELECT s.kind,r.owns_execution AS owner,r.capacity,r.canceled,c.epoch,c.enabled,c.ready,r.snapshot_json AS snapshot FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON r.id=s.run_id JOIN scheduled_control c ON c.id=1 WHERE s.submission_id=${commandId}`;
    const row = rows[0];
    if (!row) return "ready" as const;
    if (!row.owner || row.canceled) return "cancel" as const;
    const snapshot = JSON.parse(row.snapshot) as {
      authority: import("@t3tools/contracts").ScheduleAuthority;
      projectId: string;
    };
    if (!(yield* scheduleAuthorityCurrent(snapshot.authority, snapshot.projectId, settings, sql)))
      return "cancel" as const;
    return row.capacity === 1 &&
      (row.kind === "user_input" ||
        (row.ready === 1 &&
          settings.scheduledTasks.enabled &&
          row.enabled === 1 &&
          row.epoch === settings.scheduledTasks.epoch))
      ? ("ready" as const)
      : ("wait" as const);
  });
