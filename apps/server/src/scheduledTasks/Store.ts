import { scheduledRunHasSettledLeaves } from "./submissions.ts";
import { fenceScheduledRun } from "./cancellation.ts";
import { decodeScheduledRunCursor } from "./historyCursor.ts";
import { scheduledRunTransitionsTotal } from "../observability/Metrics.ts";
import {
  ScheduledTask,
  ScheduledTaskRun,
  type ScheduledRunReason,
  type ScheduledNotification,
  ClientThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Clock, Data, Effect, Layer, Metric, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const notificationMessages: Readonly<Record<string, string>> = {
  succeeded: "The scheduled run finished.",
  failed: "The scheduled run failed.",
  approval: "The run is waiting for your approval.",
  user_input: "The run needs your input.",
  interrupted: "The run was interrupted. Open its thread to review recovery.",
  usage_limit: "The provider reached its usage limit.",
  delivery_unknown: "Delivery is uncertain. Review the thread before resolving this run.",
  provider_unavailable: "The configured provider is unavailable.",
  project_missing: "The task project is unavailable.",
  authority_revoked: "Scheduling permission was revoked.",
  thread_removed: "The run's thread was removed.",
  setup_failed: "Workspace preparation failed.",
  manual_pause: "Execution is paused and needs your attention.",
};
export class ScheduledTaskError extends Data.TaggedError("ScheduledTaskError")<{
  readonly code:
    | "not_found"
    | "conflict"
    | "invalid_schedule"
    | "forbidden"
    | "storage"
    | "natural_language_unavailable"
    | "disabled";
  readonly message: string;
}> {}
export const scheduleError = (code: ScheduledTaskError["code"], message: string) =>
  new ScheduledTaskError({ code, message });
export const storageError = () =>
  scheduleError("storage", "Scheduled-task storage operation failed.");
export const unfinishedStatuses = ["pending", "running", "needs_attention"] as const;
export interface StoredRun {
  readonly run: ScheduledTaskRun;
  readonly snapshot: ScheduledTask;
  readonly command: ClientThreadTurnStartCommand | null;
  readonly submissionId: string | null;
  readonly started: boolean;
  readonly budgetConsumed: boolean;
  readonly canceled: boolean;
  readonly capacity: boolean;
  readonly owner: boolean;
  readonly turnId: string | null;
  readonly retryAt: string | null;
}
interface RunRow {
  id: string;
  task_id: string;
  thread_id: string | null;
  turn_ids_json?: string;
  state_json: string;
  snapshot_json: string;
  command_json: string | null;
  submission_id: string | null;
  submission_started: number;
  budget_consumed: number;
  canceled: number;
  capacity: number;
  owns_execution: number;
  turn_id: string | null;
  retry_at: string | null;
}
const decodeRun = (row: RunRow) =>
  Effect.gen(function* () {
    const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskRun))(
      row.state_json,
    );
    const snapshot = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTask))(
      row.snapshot_json,
    );
    const command = row.command_json
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClientThreadTurnStartCommand))(
          row.command_json,
        )
      : null;
    const turnIds = row.turn_ids_json
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
          row.turn_ids_json,
        )
      : undefined;
    return {
      run: { ...run, ...(turnIds ? { turnIds: turnIds as ScheduledTaskRun["turnIds"] } : {}) },
      snapshot,
      command,
      submissionId: row.submission_id,
      started: row.submission_started === 1,
      budgetConsumed: row.budget_consumed === 1,
      canceled: row.canceled === 1,
      capacity: row.capacity === 1,
      owner: row.owns_execution === 1,
      turnId: row.turn_id,
      retryAt: row.retry_at,
    } satisfies StoredRun;
  });
export const makeScheduledTaskStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(storageError())));
  const quarantine = (
    kind: "task" | "run",
    id: string,
    row: unknown,
    taskId: string,
    threadId: string | null,
  ) =>
    transaction(
      Effect.gen(function* () {
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        const inserted =
          yield* sql`INSERT OR IGNORE INTO scheduled_task_quarantine(entity_kind,entity_id,thread_id,payload_json,detail,quarantined_at)
        VALUES(${kind},${id},${threadId},${JSON.stringify(row)},'Invalid scheduled-task data; restore or inspect the retained evidence before retrying.',${at}) RETURNING entity_id`;
        if (!inserted.length) return;
        const runs = yield* sql<{
          id: string;
          submission_started: number;
        }>`SELECT id,submission_started FROM scheduled_task_runs WHERE task_id=${taskId} AND owns_execution=1`;
        for (const run of runs) {
          const fenced = yield* fenceScheduledRun(run.id, at).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const safe =
            fenced &&
            (!run.submission_started || (yield* scheduledRunHasSettledLeaves(sql, run.id)));
          // Unknown/in-flight work retains ownership and capacity; cancellation fences all future sends.
          yield* sql`UPDATE scheduled_task_runs SET status=${safe ? "failed" : "needs_attention"},reason='delivery_unknown',
          owns_execution=${safe ? 0 : 1},capacity=CASE WHEN ${safe ? 1 : 0}=1 THEN 0 ELSE capacity END,
          finished_at=${safe ? at : null},
          state_json=CASE WHEN json_valid(state_json) THEN json_set(state_json,'$.status',${safe ? "failed" : "needs_attention"},'$.reason','delivery_unknown','$.finishedAt',${safe ? at : null},'$.error','Scheduled execution data was quarantined. Inspect the retained evidence before retrying.') ELSE state_json END
          WHERE id=${run.id}`;
        }
        yield* sql`UPDATE scheduled_tasks SET enabled=0,next_run_at=NULL,version=version+1,updated_at=${at},
        definition_json=CASE WHEN json_valid(definition_json) THEN json_set(definition_json,'$.enabled',json('false'),'$.nextRunAt',NULL,'$.disabledReason','invalid_state','$.version',version+1,'$.updatedAt',${at}) ELSE definition_json END
        WHERE id=${taskId}`;
        yield* sql`UPDATE scheduled_control SET revision=revision+1 WHERE id=1`;
        yield* Effect.logError("scheduledTasks.quarantined", { kind, id, taskId });
      }),
    );
  const decodeTask = (row: { id: string; definition_json: string }) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTask))(row.definition_json).pipe(
      Effect.catch(() => quarantine("task", row.id, row, row.id, null).pipe(Effect.as(null))),
    );
  const decodeStoredRun = (row: RunRow) =>
    decodeRun(row).pipe(
      Effect.catch(() =>
        quarantine("run", row.id, row, row.task_id, row.thread_id).pipe(Effect.as(null)),
      ),
    );
  const tasks = (includeDeleted = false) =>
    sql<{ id: string; definition_json: string }>`SELECT id,definition_json FROM scheduled_tasks t
      WHERE (${includeDeleted ? 1 : 0}=1 OR deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM scheduled_task_quarantine q WHERE q.entity_kind='task' AND q.entity_id=t.id)
      ORDER BY updated_at DESC`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeTask)),
      Effect.map((rows) => rows.filter((row) => row !== null)),
      Effect.mapError(storageError),
    );
  const task = (id: string, includeDeleted = false) =>
    sql<{ id: string; definition_json: string; request_hash: string; requested_at: string }>`
      SELECT id,definition_json,request_hash,requested_at FROM scheduled_tasks t WHERE id=${id}
      AND (${includeDeleted ? 1 : 0}=1 OR deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM scheduled_task_quarantine q WHERE q.entity_kind='task' AND q.entity_id=t.id)`.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? decodeTask(rows[0]).pipe(
              Effect.map((task) => (task ? { task, hash: rows[0]!.request_hash } : null)),
            )
          : Effect.succeed(null),
      ),
      Effect.mapError(storageError),
    );
  const saveTask = (value: ScheduledTask, hash = "", requestedAt = value.createdAt) =>
    sql`INSERT INTO scheduled_tasks(id,project_id,definition_json,request_hash,requested_at,version,enabled,next_run_at,updated_at) VALUES(${value.id},${value.projectId},${JSON.stringify(value)},${hash},${requestedAt},${value.version},${value.enabled ? 1 : 0},${value.nextRunAt},${value.updatedAt}) ON CONFLICT(id) DO UPDATE SET definition_json=excluded.definition_json,version=excluded.version,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`.pipe(
      Effect.asVoid,
      Effect.mapError(storageError),
    );
  const run = (id: string) =>
    sql<RunRow>`SELECT r.*,(SELECT json_group_array(turn_id) FROM scheduled_run_submissions s WHERE s.run_id=r.id AND turn_id IS NOT NULL) AS turn_ids_json FROM scheduled_task_runs r WHERE id=${id}
      AND NOT EXISTS(SELECT 1 FROM scheduled_task_quarantine q WHERE q.entity_kind='run' AND q.entity_id=r.id)`.pipe(
      Effect.flatMap((rows) => (rows[0] ? decodeStoredRun(rows[0]) : Effect.succeed(null))),
      Effect.mapError(storageError),
    );
  const active = sql<RunRow>`SELECT * FROM scheduled_task_runs r WHERE owns_execution=1
    AND NOT EXISTS(SELECT 1 FROM scheduled_task_quarantine q WHERE q.entity_kind='run' AND q.entity_id=r.id) ORDER BY created_at,id`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, decodeStoredRun)),
    Effect.map((rows) => rows.filter((row) => row !== null)),
    Effect.mapError(storageError),
  );
  const history = (taskId: string, before?: string, limit = 50) =>
    Effect.gen(function* () {
      const cursor = before
        ? yield* Effect.try({
            try: () => decodeScheduledRunCursor(before),
            catch: () => scheduleError("conflict", "Invalid run-history cursor."),
          })
        : null;
      const rows =
        yield* sql<RunRow>`SELECT * FROM scheduled_task_runs WHERE task_id=${taskId} AND NOT EXISTS(SELECT 1 FROM scheduled_task_quarantine q WHERE q.entity_kind='run' AND q.entity_id=scheduled_task_runs.id) AND (${cursor?.createdAt ?? null} IS NULL OR created_at < ${cursor?.createdAt ?? ""} OR (created_at=${cursor?.createdAt ?? ""} AND id < ${cursor?.id ?? ""})) ORDER BY created_at DESC,id DESC LIMIT ${limit}`.pipe(
          Effect.mapError(storageError),
        );
      return (yield* Effect.forEach(rows, decodeStoredRun)).filter((row) => row !== null);
    });
  const insertRun = (
    value: ScheduledTaskRun,
    snapshot: ScheduledTask,
    owner: boolean,
    requestHash: string | null = null,
    requestedAt: string | null = null,
  ) =>
    sql`INSERT OR IGNORE INTO scheduled_task_runs(id,task_id,scheduled_for,trigger,status,reason,state_json,snapshot_json,owns_execution,request_hash,requested_at,created_at,finished_at) VALUES(${value.id},${value.taskId},${value.scheduledFor},${value.trigger},${value.status},${value.reason},${JSON.stringify(value)},${JSON.stringify(snapshot)},${owner ? 1 : 0},${requestHash},${requestedAt},${value.createdAt},${value.finishedAt}) RETURNING id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(storageError),
    );
  const revision = sql<{
    revision: number;
  }>`UPDATE scheduled_control SET revision=revision+1 WHERE id=1 RETURNING revision`.pipe(
    Effect.map((rows) => rows[0]!.revision),
    Effect.mapError(storageError),
  );
  const readRevision = sql<{
    revision: number;
  }>`SELECT revision FROM scheduled_control WHERE id=1`.pipe(
    Effect.map((rows) => rows[0]!.revision),
    Effect.mapError(storageError),
  );
  const transition = (
    id: string,
    status: ScheduledTaskRun["status"],
    reason: ScheduledRunReason | null,
    now: string,
    error: string | null = null,
  ) =>
    transaction(
      Effect.gen(function* () {
        const current = yield* run(id);
        if (!current || !current.owner) return;
        const terminal = !unfinishedStatuses.some((s) => s === status);
        if (
          current.run.status === status &&
          current.run.reason === reason &&
          current.run.error === error
        )
          return;
        const value: ScheduledTaskRun = {
          ...current.run,
          status,
          reason,
          error,
          finishedAt: terminal ? now : null,
        };
        yield* sql`UPDATE scheduled_task_runs SET state_json=${JSON.stringify(value)}, status=${status},reason=${reason},finished_at=${value.finishedAt},owns_execution=${terminal ? 0 : 1},capacity=CASE WHEN ${terminal ? 1 : 0}=1 THEN 0 ELSE capacity END,attention_episode=attention_episode+CASE WHEN ${status}='needs_attention' AND status!='needs_attention' THEN 1 ELSE 0 END WHERE id=${id}`;
        const notify = current.snapshot.notify;
        if (
          notify !== "none" &&
          (status === "needs_attention" ||
            status === "failed" ||
            (status === "succeeded" && notify === "all") ||
            (status === "skipped" &&
              (reason === "project_missing" ||
                reason === "provider_unavailable" ||
                reason === "authority_revoked")))
        ) {
          const episode = yield* sql<{
            attention_episode: number;
          }>`SELECT attention_episode FROM scheduled_task_runs WHERE id=${id}`;
          const notification: ScheduledNotification = {
            id: `${id}:${status}:${episode[0]!.attention_episode}`,
            taskId: value.taskId,
            runId: value.id,
            threadId: value.threadId,
            title: current.snapshot.name,
            body:
              error ??
              notificationMessages[reason ?? status] ??
              "The scheduled run needs your attention.",
          };
          yield* sql`INSERT OR IGNORE INTO scheduled_notifications(id,task_id,run_id,thread_id,payload_json,created_at) VALUES(${notification.id},${value.taskId},${id},${value.threadId},${JSON.stringify(notification)},${now})`;
        }
        yield* revision;
        yield* Metric.update(
          Metric.withAttributes(scheduledRunTransitionsTotal, { status, reason: reason ?? "none" }),
          1,
        );
        yield* Effect.logInfo("scheduledTasks.transition", {
          taskId: current.run.taskId,
          runId: id,
          status,
          reason,
        });
      }),
    );
  const prune = (now: string) =>
    transaction(
      Effect.gen(function* () {
        const ms = Date.parse(now),
          cutoff = (days: number) => new Date(ms - days * 86400000).toISOString();
        yield* sql`DELETE FROM scheduled_notifications WHERE (acknowledged_at IS NOT NULL AND acknowledged_at < ${cutoff(7)}) OR (acknowledged_at IS NULL AND created_at < ${cutoff(30)})`;
        yield* sql`DELETE FROM scheduled_task_runs WHERE owns_execution=0 AND created_at < ${cutoff(1)}
          AND NOT EXISTS(SELECT 1 FROM scheduled_run_submissions s JOIN next_turn_queue q ON q.submission_id=s.submission_id WHERE s.run_id=scheduled_task_runs.id AND q.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM scheduled_run_submissions s JOIN provider_turn_deliveries d ON d.command_id=s.submission_id WHERE s.run_id=scheduled_task_runs.id AND d.state IN ('pending','sending','ambiguous','rejected'))
          AND (finished_at < ${cutoff(90)} OR id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY created_at DESC,id DESC) AS n FROM scheduled_task_runs WHERE owns_execution=0) WHERE n>1000))`;
        yield* sql`DELETE FROM scheduled_tasks WHERE deleted_at < ${cutoff(1)} AND NOT EXISTS(SELECT 1 FROM scheduled_task_runs WHERE task_id=scheduled_tasks.id)`;
      }),
    );
  return {
    sql,
    transaction,
    tasks,
    task,
    saveTask,
    run,
    active,
    history,
    insertRun,
    revision,
    readRevision,
    transition,
    prune,
  };
});
export type ScheduledTaskStoreShape = Effect.Success<typeof makeScheduledTaskStore>;
export class ScheduledTaskStore extends ServiceMap.Service<
  ScheduledTaskStore,
  ScheduledTaskStoreShape
>()("t3/scheduledTasks/Store/ScheduledTaskStore") {}
export const ScheduledTaskStoreLive = Layer.effect(ScheduledTaskStore, makeScheduledTaskStore);
