import { WorkspaceTransitionSnapshot, WorktreesSwitchWorkspaceInput } from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  WorkspaceMoveData,
  WorkspaceTransitions,
  WorkspaceTransitionError,
  transitionIsActive,
  type WorkspaceTransitionRecord,
} from "../Services/WorkspaceTransitions.ts";

export const makeWorkspaceTransitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (message: string) => Effect.fail(new WorkspaceTransitionError(message));
  const error = (cause: unknown) =>
    cause instanceof WorkspaceTransitionError ? cause : new WorkspaceTransitionError(String(cause));
  const recordSchema = Schema.Struct({
    ...WorkspaceTransitionSnapshot.fields,
    moveData: Schema.optional(WorkspaceMoveData),
    request: WorktreesSwitchWorkspaceInput,
    requestHash: Schema.String,
    baseRef: Schema.optional(Schema.String),
    fingerprint: Schema.NullOr(Schema.String),
    mutationAttempted: Schema.Boolean,
    commandId: Schema.String,
    setupOwnerToken: Schema.NullOr(Schema.String),
    setupOwnerOperationId: Schema.optional(Schema.String),
  });
  const decode = (rows: ReadonlyArray<{ record: string; phase: string; version: number }>) =>
    Effect.try({
      try: () => {
        if (!rows[0]) return null;
        const decoded = Schema.decodeUnknownSync(recordSchema)(JSON.parse(rows[0].record));
        if (decoded.phase !== rows[0].phase || decoded.version !== rows[0].version)
          throw new Error("Transition index and record disagree.");
        return decoded;
      },
      catch: (cause) =>
        new WorkspaceTransitionError(`Cannot read workspace transition: ${String(cause)}`),
    });
  const get = (id: string) =>
    sql<{
      record: string;
      phase: string;
      version: number;
    }>`SELECT record_json AS record,phase,version FROM workspace_transitions WHERE operation_id = ${id}`.pipe(
      Effect.flatMap(decode),
      Effect.mapError(error),
    );
  const forThread: import("../Services/WorkspaceTransitions.ts").WorkspaceTransitionsShape["forThread"] =
    (threadId, activeOnly = false) =>
      sql<{
        record: string;
        phase: string;
        version: number;
      }>`SELECT record_json AS record,phase,version FROM workspace_transitions WHERE thread_id = ${threadId}
    AND (${activeOnly ? 1 : 0} = 0 OR phase IN ('reserved','stopping','applying','applied','needs_recovery')) ORDER BY CASE WHEN phase IN ('reserved','stopping','applying','applied','needs_recovery') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1`.pipe(
        Effect.flatMap(decode),
        Effect.mapError(error),
      );
  const update: import("../Services/WorkspaceTransitions.ts").WorkspaceTransitionsShape["update"] =
    (record, patch) =>
      Effect.gen(function* () {
        const next = {
          ...record,
          ...patch,
          version: record.version + 1,
          updatedAt: new Date().toISOString(),
        };
        const changed =
          yield* sql`UPDATE workspace_transitions SET phase = ${next.phase}, version = ${next.version}, record_json = ${JSON.stringify(next)}, updated_at = ${next.updatedAt}
      WHERE operation_id = ${record.operationId} AND version = ${record.version} RETURNING operation_id`;
        if (changed.length !== 1)
          return yield* fail("The workspace transition changed. Refresh before trying again.");
        return next;
      }).pipe(Effect.mapError(error));
  const validateReservation = (record: WorkspaceTransitionRecord, retry = false) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        branch: string | null;
        path: string | null;
        sessionVersion: string | null;
        status: string | null;
        activeTurn: string | null;
        archived: string | null;
      }>`
      SELECT t.branch, t.worktree_path AS path, s.updated_at AS sessionVersion, s.status, s.active_turn_id AS activeTurn, t.archived_at AS archived
      FROM projection_threads t LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      WHERE t.thread_id = ${record.threadId} AND t.deleted_at IS NULL`;
      const thread = rows[0];
      const expected = record.request.expected;
      if (
        !thread ||
        thread.archived !== null ||
        thread.branch !== expected.branch ||
        thread.path !== expected.worktreePath ||
        (!retry && thread.sessionVersion !== expected.sessionUpdatedAt)
      )
        return yield* fail("The conversation workspace or session changed. Refresh and try again.");
      if (
        thread.activeTurn ||
        thread.status === "starting" ||
        thread.status === "running" ||
        (yield* sql`SELECT 1 FROM projection_turns WHERE thread_id = ${record.threadId} AND state IN ('pending','running') LIMIT 1`)
          .length
      )
        return yield* fail("Wait for the active or pending turn to finish.");
      if (
        (yield* sql`SELECT 1 FROM native_operations WHERE thread_id = ${record.threadId} AND state IN ('requested','dispatched','running','indeterminate') LIMIT 1`)
          .length
      )
        return yield* fail("A native operation is still in progress.");
      const setup = yield* sql<{
        token: string | null;
        reason: string | null;
        paused: number;
      }>`SELECT worktree_block_token AS token, pause_reason_code AS reason, paused FROM next_turn_queue_state WHERE thread_id = ${record.threadId}`;
      if (setup[0]?.token && setup[0].token !== record.setupOwnerToken)
        return yield* fail("Workspace setup owns this conversation.");
      // Recovery remains available for the paused message that exposed a missing checkout.
      if (
        (yield* sql`SELECT 1 FROM next_turn_queue WHERE thread_id=${record.threadId} AND status='dispatching' AND deleted_at IS NULL LIMIT 1`)
          .length
      )
        return yield* fail("Wait for the dispatching queue item to settle.");
      // Restoring the recorded branch of a drifted checkout is a recovery too.
      const restoringRecordedBranch =
        record.intent === "checkout_branch" && record.target.branch === expected.branch;
      const recoveringPausedQueue =
        (["recreate", "recreate_from_base", "use_project_checkout"].includes(record.intent) ||
          restoringRecordedBranch) &&
        setup[0]?.paused === 1 &&
        setup[0]?.reason === "worktree_missing";
      if (
        (yield* sql`SELECT 1 FROM next_turn_queue WHERE thread_id = ${record.threadId} AND deleted_at IS NULL AND (${recoveringPausedQueue ? 1 : 0} = 0 OR status = 'dispatching') LIMIT 1`)
          .length &&
        !record.setupOwnerOperationId
      )
        return yield* fail("Send or remove queued work before changing workspace.");
    });
  const reserve: import("../Services/WorkspaceTransitions.ts").WorkspaceTransitionsShape["reserve"] =
    (record) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* get(record.operationId);
            if (existing) {
              if (
                existing.requestHash !== record.requestHash ||
                existing.threadId !== record.threadId
              )
                return yield* fail("This operation ID belongs to a different workspace request.");
              return existing;
            }
            if (yield* forThread(record.threadId, true))
              return yield* fail(
                "A workspace transition already owns this conversation. Resolve it first.",
              );
            yield* validateReservation(record);
            yield* sql`INSERT INTO workspace_transitions(operation_id,request_hash,thread_id,version,phase,record_json,created_at,updated_at)
      VALUES (${record.operationId},${record.requestHash},${record.threadId},0,'reserved',${JSON.stringify(record)},${record.createdAt},${record.updatedAt})`;
            return record;
          }),
        )
        .pipe(Effect.mapError(error));
  const reactivate = (record: WorkspaceTransitionRecord) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* get(record.operationId);
          if (
            !current ||
            current.version !== record.version ||
            !["failed", "needs_recovery"].includes(current.phase) ||
            current.mutationAttempted
          )
            return yield* fail("The transition changed or its Git outcome is ambiguous.");
          yield* validateReservation(current, true);
          return yield* update(current, { phase: "reserved", error: null });
        }),
      )
      .pipe(Effect.mapError(error));
  const reconcile = sql
    .withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          record: string;
          phase: string;
          version: number;
        }>`SELECT record_json AS record,phase,version FROM workspace_transitions WHERE phase IN ('reserved','stopping','applying','applied','needs_recovery')`;
        for (const row of rows) {
          const record = yield* decode([row]);
          if (!record) continue;
          const proof =
            yield* sql`SELECT 1 FROM orchestration_command_receipts r JOIN projection_threads t ON t.thread_id = r.aggregate_id
        WHERE r.command_id = ${record.commandId} AND r.status = 'accepted' AND t.thread_id = ${record.threadId}
        AND t.branch IS ${record.result?.branch ?? record.observed?.branch ?? record.target.branch}
        AND t.worktree_path IS ${record.result ? record.result.worktreePath : record.target.path}`;
          yield* update(
            record,
            proof.length
              ? { phase: "completed", error: null }
              : {
                  phase: "needs_recovery",
                  error:
                    record.error ??
                    "Workspace switching was interrupted. Inspect the checkout before continuing.",
                },
          );
        }
      }),
    )
    .pipe(Effect.mapError(error));
  const cancel: import("../Services/WorkspaceTransitions.ts").WorkspaceTransitionsShape["cancel"] =
    (threadId) =>
      Effect.gen(function* () {
        const record = yield* forThread(threadId, true).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              // Cancellation only releases execution ownership; unreadable records never authorize Git.
              // Retain the original record for diagnosis while archive/delete remain available.
              yield* sql`UPDATE workspace_transitions SET phase='cancelled',version=version+1,updated_at=${new Date().toISOString()} WHERE thread_id=${threadId} AND phase IN ('reserved','stopping','applying','applied','needs_recovery')`.pipe(
                Effect.mapError(error),
              );
              return null;
            }),
          ),
        );
        if (record && transitionIsActive(record))
          yield* update(record, {
            phase: "cancelled",
            error: "Conversation archived or deleted; checkout retained.",
          });
      });
  return WorkspaceTransitions.of({
    get,
    forThread,
    reserve,
    reactivate,
    update,
    unfinishedMoves: sql<{
      record: string;
      phase: string;
      version: number;
    }>`SELECT record_json AS record,phase,version FROM workspace_transitions WHERE json_extract(record_json,'$.intent')='move_to_new_worktree' AND (phase IN ('reserved','stopping','applying','applied','needs_recovery') OR json_extract(record_json,'$.moveData.snapshotRef') IS NOT NULL)`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode([row]))),
      Effect.map((records) => records.filter((record) => record !== null)),
      Effect.mapError(error),
    ),
    reconcile,
    cancel,
  });
});
export const WorkspaceTransitionsLive = Layer.effect(
  WorkspaceTransitions,
  makeWorkspaceTransitions,
);
