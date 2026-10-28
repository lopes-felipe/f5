import type {
  ModelSelection,
  RuntimeMode,
  UpstreamEnqueuePortResult,
  UpstreamPortQueueStatus,
  UpstreamPortReviewRequest,
} from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export interface QueueRecord {
  readonly projectId: string;
  readonly entryId: string;
  readonly position: number;
  readonly topicIds: ReadonlyArray<string>;
  readonly topicEpochs: Readonly<Record<string, number>>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly review?: UpstreamPortReviewRequest | null;
  readonly requestId: string;
  readonly fileKeys: ReadonlyArray<string>;
  readonly ignoreConflicts: boolean;
  readonly status: UpstreamPortQueueStatus;
  readonly threadId: string | null;
  readonly result: string | null;
  readonly topicResults: Readonly<Record<string, string>>;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}
export interface QueueState {
  readonly paused: boolean;
  readonly pausedReason: string | null;
  readonly holdKind: "usage" | "provider" | "isolation" | "writer" | null;
  readonly holdMessage: string | null;
  readonly holdUntil: string | null;
  readonly errorStreak: number;
}
export interface OutcomeCheck {
  readonly projectId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly result: "preexisting" | "recorded" | "no-outcome" | "not-eligible" | "failed";
  readonly detail: string | null;
  readonly checkedAt: string;
  readonly attempts: number;
  readonly retryAt: string | null;
}
export const OUTCOME_CHECK_MAX_ATTEMPTS = 5;
export function outcomeCheckPending(
  check: OutcomeCheck | undefined,
  turnId: string,
  now: number,
): boolean {
  if (check?.result === "preexisting") return false;
  if (check?.turnId !== turnId) return true;
  return (
    check.result === "failed" &&
    check.attempts < OUTCOME_CHECK_MAX_ATTEMPTS &&
    (check.retryAt === null || Date.parse(check.retryAt) <= now)
  );
}
export const EMPTY_QUEUE_STATE: QueueState = {
  paused: false,
  pausedReason: null,
  holdKind: null,
  holdMessage: null,
  holdUntil: null,
  errorStreak: 0,
};
interface QueueRow {
  project_id: string;
  entry_id: string;
  position: number;
  topic_ids_json: string;
  topic_epochs_json: string;
  model_selection_json: string;
  runtime_mode: RuntimeMode;
  review_json: string | null;
  request_id: string;
  file_keys_json: string;
  ignore_conflicts: number;
  status: UpstreamPortQueueStatus;
  thread_id: string | null;
  result: string | null;
  topic_results_json: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
const fromRow = (row: QueueRow): QueueRecord => ({
  projectId: row.project_id,
  entryId: row.entry_id,
  position: Number(row.position),
  topicIds: JSON.parse(row.topic_ids_json),
  topicEpochs: JSON.parse(row.topic_epochs_json),
  modelSelection: JSON.parse(row.model_selection_json),
  runtimeMode: row.runtime_mode,
  review: row.review_json ? JSON.parse(row.review_json) : null,
  requestId: row.request_id,
  fileKeys: JSON.parse(row.file_keys_json),
  ignoreConflicts: !!row.ignore_conflicts,
  status: row.status,
  threadId: row.thread_id,
  result: row.result,
  topicResults: JSON.parse(row.topic_results_json ?? "{}"),
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
});

export function makeQueueStore(sql: SqlClient.SqlClient) {
  const bump = (
    projectId: string,
  ) => sql`INSERT INTO upstream_port_queue_state(project_id,queue_version)
    VALUES (${projectId},1) ON CONFLICT(project_id) DO UPDATE SET queue_version = queue_version + 1`;
  const listQueue = (projectId: string, statuses: ReadonlyArray<UpstreamPortQueueStatus> = []) =>
    sql<QueueRow>`SELECT * FROM upstream_port_queue
    WHERE project_id = ${projectId} ${statuses.length ? sql`AND ${sql.in("status", statuses)}` : sql``}
    ORDER BY position,entry_id`.pipe(Effect.map((rows) => rows.map(fromRow)));
  const setQueueEntry = (entry: QueueRecord) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO upstream_port_queue
      (project_id,entry_id,position,topic_ids_json,topic_epochs_json,model_selection_json,runtime_mode,review_json,request_id,
       file_keys_json,ignore_conflicts,status,thread_id,result,topic_results_json,reason,created_at,updated_at,finished_at)
      VALUES (${entry.projectId},${entry.entryId},${entry.position},${JSON.stringify(entry.topicIds)},
       ${JSON.stringify(entry.topicEpochs)},${JSON.stringify(entry.modelSelection)},${entry.runtimeMode},${entry.review ? JSON.stringify(entry.review) : null},${entry.requestId},
       ${JSON.stringify(entry.fileKeys)},${entry.ignoreConflicts ? 1 : 0},${entry.status},${entry.threadId},${entry.result},
       ${JSON.stringify(entry.topicResults)},${entry.reason},${entry.createdAt},${entry.updatedAt},${entry.finishedAt})
      ON CONFLICT(project_id,entry_id) DO UPDATE SET topic_ids_json = excluded.topic_ids_json,
       status = excluded.status,thread_id = excluded.thread_id,result = excluded.result,
       topic_results_json = excluded.topic_results_json,reason = excluded.reason,updated_at = excluded.updated_at,
       finished_at = excluded.finished_at,ignore_conflicts = excluded.ignore_conflicts,
       file_keys_json = excluded.file_keys_json`;
        yield* bump(entry.projectId);
      }),
    );
  const getQueueState = (projectId: string) =>
    sql<{
      paused: number;
      paused_reason: string | null;
      hold_kind: QueueState["holdKind"];
      hold_message: string | null;
      hold_until: string | null;
      error_streak: number;
    }>`SELECT * FROM upstream_port_queue_state WHERE project_id = ${projectId}`.pipe(
      Effect.map(
        ([row]): QueueState =>
          row
            ? {
                paused: !!row.paused,
                pausedReason: row.paused_reason,
                holdKind: row.hold_kind,
                holdMessage: row.hold_message,
                holdUntil: row.hold_until,
                errorStreak: Number(row.error_streak),
              }
            : EMPTY_QUEUE_STATE,
      ),
    );
  const setQueueState = (projectId: string, state: QueueState) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO upstream_port_queue_state
      (project_id,paused,paused_reason,hold_kind,hold_message,hold_until,error_streak,queue_version)
      VALUES (${projectId},${state.paused ? 1 : 0},${state.pausedReason},${state.holdKind},${state.holdMessage},${state.holdUntil},${state.errorStreak},1)
      ON CONFLICT(project_id) DO UPDATE SET paused = excluded.paused,paused_reason = excluded.paused_reason,
      hold_kind = excluded.hold_kind,hold_message = excluded.hold_message,hold_until = excluded.hold_until,
      error_streak = excluded.error_streak,queue_version = queue_version + 1`;
      }),
    );
  const removeTopicsFromQueued = (projectId: string, topicIds: ReadonlyArray<string>, at: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const remove = new Set(topicIds);
        for (const entry of yield* listQueue(projectId)) {
          if (entry.status !== "queued" || !entry.topicIds.some((id) => remove.has(id))) continue;
          const remaining = entry.topicIds.filter((id) => !remove.has(id));
          const topicResults = { ...entry.topicResults };
          for (const id of entry.topicIds) if (remove.has(id)) topicResults[id] = "canceled";
          yield* setQueueEntry({
            ...entry,
            topicIds: remaining,
            topicResults,
            updatedAt: at,
            ...(remaining.length
              ? {}
              : { status: "dropped", result: "canceled", reason: "canceled", finishedAt: at }),
          });
        }
      }),
    );
  return {
    hasQueueHistory: (projectId: string) =>
      sql`SELECT 1 FROM upstream_port_queue WHERE project_id = ${projectId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    listQueue,
    setQueueEntry,
    getQueueState,
    setQueueState,
    removeTopicsFromQueued,
    listQueuedTopicIds: (projectId: string) =>
      listQueue(projectId).pipe(
        Effect.map(
          (entries) =>
            new Set(
              entries
                .filter((entry) => entry.status === "queued")
                .flatMap((entry) => entry.topicIds),
            ),
        ),
      ),
    clearQueued: (projectId: string, at: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const changed =
            yield* sql`UPDATE upstream_port_queue SET status = 'dropped',result = 'canceled',reason = 'canceled',
        updated_at = ${at},finished_at = ${at} WHERE project_id = ${projectId} AND status = 'queued' RETURNING entry_id`;
          if (changed.length) yield* bump(projectId);
        }),
      ),
    getEnqueueRequest: (projectId: string, requestId: string) =>
      sql<{ args_hash: string; result_json: string }>`
      SELECT args_hash,result_json FROM upstream_port_queue_requests WHERE project_id = ${projectId}
      AND client_request_id = ${requestId}`.pipe(
        Effect.map(([row]) =>
          row
            ? {
                argsHash: row.args_hash,
                result: JSON.parse(row.result_json) as UpstreamEnqueuePortResult,
              }
            : null,
        ),
      ),
    putEnqueueRequest: (
      projectId: string,
      requestId: string,
      hash: string,
      result: UpstreamEnqueuePortResult,
      at: string,
    ) =>
      sql`INSERT INTO upstream_port_queue_requests(project_id,client_request_id,args_hash,result_json,created_at)
      VALUES (${projectId},${requestId},${hash},${JSON.stringify(result)},${at})`,
    getOutcomeChecks: (projectId: string) =>
      sql<{
        project_id: string;
        thread_id: string;
        turn_id: string | null;
        result: OutcomeCheck["result"];
        detail: string | null;
        checked_at: string;
        attempts: number;
        retry_at: string | null;
      }>`SELECT * FROM upstream_port_outcome_checks WHERE project_id = ${projectId}`.pipe(
        Effect.map(
          (rows) =>
            new Map(
              rows.map((row) => [
                row.thread_id,
                {
                  projectId: row.project_id,
                  threadId: row.thread_id,
                  turnId: row.turn_id,
                  result: row.result,
                  detail: row.detail,
                  checkedAt: row.checked_at,
                  attempts: Number(row.attempts),
                  retryAt: row.retry_at,
                } satisfies OutcomeCheck,
              ]),
            ),
        ),
      ),
    upsertOutcomeCheck: (row: OutcomeCheck) => sql`INSERT INTO upstream_port_outcome_checks
      (project_id,thread_id,turn_id,result,detail,checked_at,attempts,retry_at)
      VALUES (${row.projectId},${row.threadId},${row.turnId},${row.result},${row.detail},${row.checkedAt},${row.attempts},${row.retryAt})
      ON CONFLICT(project_id,thread_id) DO UPDATE SET turn_id = excluded.turn_id,result = excluded.result,
      detail = excluded.detail,checked_at = excluded.checked_at,attempts = excluded.attempts,retry_at = excluded.retry_at`,
    listProjectsWithPortWork: sql<{
      project_id: string;
    }>`SELECT project_id FROM upstream_port_queue WHERE status IN ('queued','started')
      UNION SELECT project_id FROM upstream_port_groups WHERE status = 'pending'
      UNION SELECT l.project_id FROM upstream_port_links l
      LEFT JOIN upstream_port_outcome_checks c ON c.project_id = l.project_id AND c.thread_id = l.thread_id
      LEFT JOIN projection_threads t ON t.thread_id = l.thread_id
      LEFT JOIN projection_turns u ON u.thread_id = t.thread_id AND u.turn_id = t.latest_turn_id
      WHERE l.state = 'active' AND u.state = 'completed' AND u.processing_quiesced_at IS NOT NULL
      AND u.assistant_message_id IS NOT NULL AND (c.thread_id IS NULL OR
        (c.result != 'preexisting' AND t.latest_turn_id IS NOT NULL AND c.turn_id IS NOT t.latest_turn_id) OR
        (c.result = 'failed' AND c.attempts < ${OUTCOME_CHECK_MAX_ATTEMPTS}))`.pipe(
      Effect.map((rows) => rows.map((row) => row.project_id)),
    ),
  };
}
