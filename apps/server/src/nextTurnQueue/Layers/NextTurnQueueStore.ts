import { MAX_CONSECUTIVE_AUTO_RESUMES } from "../usageLimitResume.ts";
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import {
  CommandId,
  MAX_QUEUED_TURNS_PER_THREAD,
  MessageId,
  type NextTurnQueueItem,
  type NextTurnQueueSummary,
  type QueueReasonCode,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  NextTurnQueueConflictError,
  type NextTurnQueueError,
  NextTurnQueueIdempotencyConflictError,
  NextTurnQueueItemDispatchingError,
  NextTurnQueueItemAlreadyRanError,
  NextTurnQueueItemNotFoundError,
  NextTurnQueueLimitExceededError,
  NextTurnQueueReorderMismatchError,
  NextTurnQueueStorageError,
  toNextTurnQueueStorageError,
} from "../Errors.ts";
import {
  NextTurnQueueStore,
  type NextTurnQueueState,
  type NextTurnQueueStoreShape,
  type NextTurnQueueSubmissionRecord,
} from "../Services/NextTurnQueueStore.ts";
import {
  DISPATCH_LEASE_TTL_MS,
  SOFT_DELETE_RETENTION_MS,
  SUBMISSION_LEDGER_RETENTION_MS,
} from "../constants.ts";

interface QueueRow {
  readonly itemId: string;
  readonly threadId: string;
  readonly submissionId: string;
  readonly position: number;
  readonly status: string;
  readonly attemptCount: number;
  readonly notBefore: string | null;
  readonly scheduleReason: "usage_limit_reset" | null;
  readonly dispatchStartedAt: string | null;
  readonly commandJson: string;
  readonly lastErrorCode: string | null;
  readonly lastErrorDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StateRow {
  readonly threadId: string;
  readonly paused: number;
  readonly pauseReasonCode: string | null;
  readonly pauseDetail: string | null;
  readonly resumedAt: string | null;
  readonly interruptSuppressionCommandId: string | null;
  readonly worktreeBlockToken: string | null;
  readonly revision: number;
  readonly updatedAt: string;
}

interface SubmissionRow {
  readonly submissionId: string;
  readonly threadId: string;
  readonly requestHash: string;
  readonly itemId: string | null;
  readonly messageId: string;
  readonly disposition: NextTurnQueueSubmissionRecord["disposition"];
  readonly resultSequence: number | null;
  readonly reasonCode: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

const QUEUE_ERROR_TAGS = new Set([
  "NextTurnQueueItemNotFoundError",
  "NextTurnQueueThreadNotFoundError",
  "NextTurnQueueItemDispatchingError",
  "NextTurnQueueItemAlreadyRanError",
  "NextTurnQueueConflictError",
  "NextTurnQueueLimitExceededError",
  "NextTurnQueueReorderMismatchError",
  "NextTurnQueueBootstrapNotAllowedError",
  "NextTurnQueueIdempotencyConflictError",
  "NextTurnQueueStorageError",
  "NextTurnQueueClaimLostError",
]);

function normalizeError(error: unknown): NextTurnQueueError {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    QUEUE_ERROR_TAGS.has(error._tag)
  ) {
    return error as NextTurnQueueError;
  }
  return toNextTurnQueueStorageError(error);
}

function toState(row: StateRow): NextTurnQueueState {
  return {
    threadId: ThreadId.makeUnsafe(row.threadId),
    paused: row.paused === 1,
    pauseReasonCode: row.pauseReasonCode as QueueReasonCode | null,
    pauseDetail: row.pauseDetail,
    resumedAt: row.resumedAt,
    interruptSuppressionCommandId:
      row.interruptSuppressionCommandId === null
        ? null
        : CommandId.makeUnsafe(row.interruptSuppressionCommandId),
    worktreeBlockToken: row.worktreeBlockToken,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

function toSubmission(row: SubmissionRow): NextTurnQueueSubmissionRecord {
  return {
    ...row,
    submissionId: CommandId.makeUnsafe(row.submissionId),
    threadId: ThreadId.makeUnsafe(row.threadId),
    itemId: row.itemId === null ? null : CommandId.makeUnsafe(row.itemId),
  };
}

function decodeRow(row: QueueRow): NextTurnQueueItem {
  const command = Schema.decodeUnknownSync(ThreadTurnStartCommand)(JSON.parse(row.commandJson));
  return {
    itemId: CommandId.makeUnsafe(row.itemId),
    threadId: ThreadId.makeUnsafe(row.threadId),
    submissionId: CommandId.makeUnsafe(row.submissionId),
    position: row.position,
    status: row.status as NextTurnQueueItem["status"],
    command,
    attemptCount: row.attemptCount,
    notBefore: row.notBefore,
    scheduleReason: row.scheduleReason,
    dispatchStartedAt: row.dispatchStartedAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorDetail: row.lastErrorDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const makeNextTurnQueueStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;

  const now = () => new Date().toISOString();

  const queueRows = (where: string, values: ReadonlyArray<unknown> = []) =>
    sql.unsafe<QueueRow>(
      `SELECT
         item_id AS itemId,
         thread_id AS threadId,
         submission_id AS submissionId,
         position,
         status,
         attempt_count AS attemptCount,
         not_before AS notBefore,
         schedule_reason AS scheduleReason,
         dispatch_started_at AS dispatchStartedAt,
         command_json AS commandJson,
         last_error_code AS lastErrorCode,
         last_error_detail AS lastErrorDetail,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM next_turn_queue
       ${where}`,
      values,
    );

  const ensureState = (threadId: ThreadId, at = now()) =>
    sql`
      INSERT INTO next_turn_queue_state (thread_id, paused, revision, updated_at)
      VALUES (${threadId}, 0, 0, ${at})
      ON CONFLICT (thread_id) DO NOTHING
    `;

  const bumpRevision = (threadId: ThreadId, at = now()) =>
    Effect.gen(function* () {
      yield* ensureState(threadId, at);
      yield* sql`
        UPDATE next_turn_queue_state
        SET revision = revision + 1, updated_at = ${at}
        WHERE thread_id = ${threadId}
      `;
    });

  const readState = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* ensureState(threadId);
      const rows = yield* sql<StateRow>`
        SELECT
          thread_id AS "threadId",
          paused,
          pause_reason_code AS "pauseReasonCode",
          pause_detail AS "pauseDetail",
          resumed_at AS "resumedAt",
          interrupt_suppression_command_id AS "interruptSuppressionCommandId",
          worktree_block_token AS "worktreeBlockToken",
          revision,
          updated_at AS "updatedAt"
        FROM next_turn_queue_state
        WHERE thread_id = ${threadId}
      `;
      const row = rows[0];
      if (!row) {
        return yield* new NextTurnQueueStorageError({
          message: "Could not read the queued turns.",
        });
      }
      return toState(row);
    });

  const normalizePositions = (threadId: ThreadId, at = now()) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly itemId: string }>`
        SELECT item_id AS "itemId"
        FROM next_turn_queue
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
        ORDER BY position, created_at, item_id
      `;
      yield* Effect.forEach(
        rows,
        (row, position) =>
          sql`
            UPDATE next_turn_queue
            SET position = ${position}, updated_at = ${at}
            WHERE item_id = ${row.itemId}
          `,
        { concurrency: 1, discard: true },
      );
    });

  const quarantineRows = (threadId: ThreadId, rows: ReadonlyArray<QueueRow>) =>
    rows.length === 0
      ? Effect.void
      : sql.withTransaction(
          Effect.gen(function* () {
            const quarantinedAt = now();
            yield* Effect.forEach(
              rows,
              (row) =>
                Effect.gen(function* () {
                  yield* sql`
                    INSERT OR REPLACE INTO next_turn_queue_quarantine (
                      item_id, thread_id, command_json, detail, quarantined_at
                    ) VALUES (
                      ${row.itemId}, ${row.threadId}, ${row.commandJson},
                      'Queued turn contains invalid command JSON.', ${quarantinedAt}
                    )
                  `;
                  yield* sql`
                    INSERT OR IGNORE INTO next_turn_queue_orphaned_attachments (
                      attachment_id, thread_id, recorded_at
                    )
                    SELECT json_extract(value, '$.id'), ${row.threadId}, ${quarantinedAt}
                    FROM json_each(
                      CASE WHEN json_valid(${row.commandJson})
                        THEN json_extract(${row.commandJson}, '$.message.attachments')
                        ELSE '[]'
                      END
                    )
                    WHERE json_type(value, '$.id') = 'text'
                  `;
                  yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${row.itemId}`;
                }),
              { concurrency: 1, discard: true },
            );
            yield* normalizePositions(threadId, quarantinedAt);
            yield* bumpRevision(threadId, quarantinedAt);
            yield* Effect.logWarning("quarantined invalid next-turn queue rows", {
              threadId,
              itemIds: rows.map((row) => row.itemId),
            });
          }),
        );

  const decodeRows = (threadId: ThreadId, rows: ReadonlyArray<QueueRow>) =>
    Effect.gen(function* () {
      const items: NextTurnQueueItem[] = [];
      const invalid: QueueRow[] = [];
      for (const row of rows) {
        const decoded = yield* Effect.exit(Effect.sync(() => decodeRow(row)));
        if (Exit.isSuccess(decoded)) {
          items.push(decoded.value);
        } else {
          invalid.push(row);
        }
      }
      yield* quarantineRows(threadId, invalid);
      return items;
    });

  const readItems = (threadId: ThreadId, includeDeleted = false) =>
    queueRows(
      `WHERE thread_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
       ORDER BY position, created_at, item_id`,
      [threadId],
    ).pipe(Effect.flatMap((rows) => decodeRows(threadId, rows)));

  const readItem = (itemId: CommandId, includeDeleted = false) =>
    queueRows(`WHERE item_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} LIMIT 1`, [
      itemId,
    ]).pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(null);
        return decodeRows(ThreadId.makeUnsafe(row.threadId), [row]).pipe(
          Effect.map((items) => items[0] ?? null),
        );
      }),
    );

  const requireItem = (itemId: CommandId, includeDeleted = false) =>
    readItem(itemId, includeDeleted).pipe(
      Effect.flatMap((item) =>
        item
          ? Effect.succeed(item)
          : Effect.fail(
              new NextTurnQueueItemNotFoundError({
                message: "That queued turn no longer exists.",
              }),
            ),
      ),
    );

  const readSubmission = (submissionId: CommandId) =>
    sql<SubmissionRow>`
      SELECT
        submission_id AS "submissionId",
        thread_id AS "threadId",
        request_hash AS "requestHash",
        item_id AS "itemId",
        message_id AS "messageId",
        disposition,
        result_sequence AS "resultSequence",
        reason_code AS "reasonCode",
        created_at AS "createdAt",
        settled_at AS "settledAt"
      FROM turn_submissions
      WHERE submission_id = ${submissionId}
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] ? toSubmission(rows[0]) : null)));

  const removeAttachments = (items: ReadonlyArray<NextTurnQueueItem>) =>
    Effect.forEach(
      items,
      (item) =>
        Effect.forEach(
          item.command.message.attachments,
          (attachment) =>
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM attachment_owners
                WHERE attachment_id = ${attachment.id}
                  AND owner_kind = 'queue_item'
                  AND owner_id = ${item.itemId}
              `;
              const remaining = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM attachment_owners
                WHERE attachment_id = ${attachment.id}
              `;
              if ((remaining[0]?.count ?? 0) > 0) return;
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (attachmentPath) {
                yield* fileSystem
                  .remove(attachmentPath, { force: true })
                  .pipe(Effect.catch(() => Effect.void));
              }
              yield* sql`DELETE FROM attachments WHERE attachment_id = ${attachment.id}`;
            }),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    );

  const readItemByCommandId = (commandId: CommandId) =>
    queueRows("WHERE command_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1", [
      commandId,
    ]).pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(null);
        return decodeRows(ThreadId.makeUnsafe(row.threadId), [row]).pipe(
          Effect.map((items) => items[0] ?? null),
        );
      }),
    );

  const rejectAcceptedMutation = (item: NextTurnQueueItem) =>
    item.command.presentation === "continuation" && item.scheduleReason !== "usage_limit_reset"
      ? Effect.fail(
          new NextTurnQueueItemAlreadyRanError({
            message: "Restart continuations are managed by recovery.",
          }),
        )
      : item.attemptCount === 0
        ? Effect.void
        : sql<{ readonly status: string }>`
          SELECT status FROM orchestration_command_receipts
          WHERE command_id = ${item.command.commandId} LIMIT 1
        `.pipe(
            Effect.flatMap((rows) =>
              rows[0]?.status === "accepted"
                ? Effect.fail(
                    new NextTurnQueueItemAlreadyRanError({
                      message:
                        "That queued turn was already admitted and its provider delivery must be recovered instead.",
                    }),
                  )
                : Effect.void,
            ),
          );

  const listByThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const [items, state, quarantineRows] = yield* Effect.all(
        [
          readItems(threadId),
          readState(threadId),
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM next_turn_queue_quarantine
            WHERE thread_id = ${threadId}
          `,
        ],
        { concurrency: 1 },
      );
      return {
        items,
        state,
        quarantinedCount: quarantineRows[0]?.count ?? 0,
      };
    });

  const store: NextTurnQueueStoreShape = {
    listByThread: (threadId) => listByThread(threadId).pipe(Effect.mapError(normalizeError)),

    listActionableThreadIds: sql<{ readonly threadId: string }>`
      SELECT DISTINCT queue.thread_id AS "threadId"
      FROM next_turn_queue AS queue
      LEFT JOIN next_turn_queue_state AS state ON state.thread_id = queue.thread_id
      WHERE queue.deleted_at IS NULL
        AND queue.status = 'queued'
        AND (queue.not_before IS NULL OR julianday(queue.not_before) <= julianday('now'))
        AND COALESCE(state.paused, 0) = 0
      ORDER BY queue.thread_id
    `.pipe(
      Effect.map((rows) => rows.map((row) => ThreadId.makeUnsafe(row.threadId))),
      Effect.mapError(normalizeError),
    ),

    getItem: (itemId) => readItem(itemId).pipe(Effect.mapError(normalizeError)),
    getUsageResumeContext: (itemId) =>
      sql<{
        limitKey: string;
        providerInstanceId: string;
        source: "manual" | "auto";
        fingerprint: string | null;
      }>`SELECT q.schedule_limit_key AS "limitKey", q.schedule_provider_instance_id AS "providerInstanceId", q.schedule_provider_fingerprint AS fingerprint, l.source FROM next_turn_queue q JOIN usage_limit_resumes l ON l.thread_id=q.thread_id AND l.limit_key=q.schedule_limit_key WHERE q.item_id=${itemId} AND q.deleted_at IS NULL`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(normalizeError),
      ),
    getUsageResumeLedger: (threadId) =>
      sql<
        import("../Services/NextTurnQueueStore.ts").UsageResumeLedger
      >`SELECT l.limit_key AS "limitKey", l.state, l.source, l.item_id AS "itemId", l.not_before AS "notBefore", (SELECT h.not_before FROM usage_limit_resumes h WHERE h.thread_id=l.thread_id AND h.not_before IS NOT NULL ORDER BY h.updated_at DESC,h.rowid DESC LIMIT 1) AS "previousTarget", COALESCE(s.auto_count,0) AS "autoCount" FROM usage_limit_resumes l LEFT JOIN usage_limit_resume_streaks s ON s.thread_id=l.thread_id WHERE l.thread_id=${threadId} ORDER BY l.updated_at DESC, l.rowid DESC LIMIT 1`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(normalizeError),
      ),
    recordUsageResumeFailure: (threadId, limitKey, eligible) =>
      Effect.gen(function* () {
        const at = now();
        yield* sql`INSERT INTO usage_limit_resumes(thread_id,limit_key,state,source,auto_eligible_at_failure,created_at,updated_at) VALUES(${threadId},${limitKey},'revoked','auto',${eligible ? 1 : 0},${at},${at}) ON CONFLICT(thread_id,limit_key) DO NOTHING`;
      }).pipe(Effect.mapError(normalizeError)),
    scheduleUsageLimitResume: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const threadId = input.command.threadId;
            const at = now();
            const ledger = (yield* sql<{
              state: string;
              eligible: number;
            }>`SELECT state,auto_eligible_at_failure AS eligible FROM usage_limit_resumes WHERE thread_id=${threadId} AND limit_key=${input.limitKey}`)[0];
            const existing = (yield* queueRows(
              "WHERE thread_id=? AND schedule_reason='usage_limit_reset' AND deleted_at IS NULL",
              [threadId],
            ))[0];
            const previous = existing ?? (yield* queueRows("WHERE item_id=?", [input.itemId]))[0];
            const context = existing
              ? yield* store.getUsageResumeContext(CommandId.makeUnsafe(existing.itemId))
              : null;
            if (context?.limitKey === input.limitKey) return "already_scheduled" as const;
            if (
              input.source === "auto" &&
              ledger &&
              (ledger.eligible === 0 ||
                ["cancelled", "superseded", "gave_up"].includes(ledger.state))
            )
              return "suppressed" as const;
            const count =
              (yield* sql<{
                count: number;
              }>`SELECT auto_count AS count FROM usage_limit_resume_streaks WHERE thread_id=${threadId}`)[0]
                ?.count ?? 0;
            if (input.source === "auto" && count >= MAX_CONSECUTIVE_AUTO_RESUMES) {
              yield* sql`UPDATE usage_limit_resumes SET state='gave_up',updated_at=${at} WHERE thread_id=${threadId} AND limit_key=${input.limitKey}`;
              return "gave_up" as const;
            }
            if (existing?.status === "dispatching") return "busy" as const;
            const itemId = previous ? CommandId.makeUnsafe(previous.itemId) : input.itemId;
            if (previous) {
              if (previous.submissionId !== input.submissionId)
                yield* sql`UPDATE turn_submissions SET disposition='canceled',reason_code='usage_resume_superseded',settled_at=${at} WHERE submission_id=${previous.submissionId} AND disposition IN ('pending','queued')`;
              yield* sql`UPDATE next_turn_queue SET position=position+1,updated_at=${at} WHERE thread_id=${threadId} AND deleted_at IS NULL AND item_id != ${itemId}`;
              yield* sql`UPDATE usage_limit_resumes SET state='superseded',updated_at=${at} WHERE item_id=${itemId} AND state='scheduled'`;
              yield* sql`UPDATE next_turn_queue SET position=0,schedule_limit_key=${input.limitKey},schedule_provider_instance_id=${input.providerInstanceId},not_before=${input.notBefore},command_id=${input.command.commandId},message_id=${input.command.message.messageId},submission_id=${input.submissionId},command_json=${JSON.stringify(input.command)},deleted_at=NULL,status='queued',attempt_count=0,lease_owner=NULL,lease_expires_at=NULL,dispatch_started_at=NULL,last_error_code=NULL,last_error_detail=NULL,updated_at=${at} WHERE item_id=${itemId}`;
              yield* sql`INSERT INTO turn_submissions(submission_id,thread_id,request_hash,item_id,message_id,disposition,created_at) VALUES(${input.submissionId},${threadId},${input.requestHash},${itemId},${input.command.message.messageId},'pending',${at}) ON CONFLICT(submission_id) DO UPDATE SET disposition='pending',request_hash=excluded.request_hash,message_id=excluded.message_id,item_id=excluded.item_id,settled_at=NULL,reason_code=NULL`;
            } else {
              yield* store.insertSubmission({
                ...input,
                atHead: true,
                scheduleReason: "usage_limit_reset",
                scheduleLimitKey: input.limitKey,
                scheduleProviderInstanceId: input.providerInstanceId,
              });
            }
            yield* sql`UPDATE next_turn_queue SET schedule_provider_fingerprint=${input.providerFingerprint ?? null} WHERE item_id=${itemId}`;
            yield* sql`UPDATE next_turn_queue_state SET paused=0,pause_reason_code=NULL,pause_detail=NULL WHERE thread_id=${threadId} AND pause_reason_code='turn_failed'`;
            yield* sql`INSERT INTO usage_limit_resumes(thread_id,limit_key,state,source,auto_eligible_at_failure,item_id,not_before,prev_target,created_at,updated_at) VALUES(${threadId},${input.limitKey},'scheduled',${input.source},1,${itemId},${input.notBefore},${existing?.notBefore ?? null},${at},${at}) ON CONFLICT(thread_id,limit_key) DO UPDATE SET state='scheduled',source=excluded.source,item_id=excluded.item_id,prev_target=usage_limit_resumes.not_before,not_before=excluded.not_before,updated_at=excluded.updated_at`;
            if (input.source === "auto")
              yield* sql`INSERT INTO usage_limit_resume_streaks(thread_id,auto_count,updated_at) VALUES(${threadId},1,${at}) ON CONFLICT(thread_id) DO UPDATE SET auto_count=auto_count+1,updated_at=excluded.updated_at`;
            yield* normalizePositions(threadId, at);
            yield* bumpRevision(threadId, at);
            return previous ? ("rebound" as const) : ("created" as const);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),
    revokeAutoResumes: (threadIds) =>
      threadIds?.length === 0
        ? Effect.succeed([])
        : sql
            .withTransaction(
              Effect.gen(function* () {
                if (threadIds?.length === 0) return [];
                const rows = yield* sql<{ threadId: ThreadId; itemId: CommandId }>`
          SELECT q.thread_id AS "threadId",q.item_id AS "itemId"
          FROM next_turn_queue q JOIN usage_limit_resumes l ON l.item_id=q.item_id AND l.limit_key=q.schedule_limit_key
          WHERE l.source='auto' AND q.status='queued' AND q.deleted_at IS NULL
          ${threadIds ? sql`AND ${sql.in("q.thread_id", threadIds)}` : sql``}`;
                const changed = new Set<ThreadId>();
                for (const row of rows) {
                  const at = now();
                  yield* sql`UPDATE turn_submissions SET disposition='canceled',settled_at=${at} WHERE item_id=${row.itemId} AND disposition IN ('pending','queued')`;
                  yield* sql`UPDATE next_turn_queue SET deleted_at=${at},updated_at=${at} WHERE item_id=${row.itemId} AND status='queued'`;
                  yield* sql`UPDATE usage_limit_resumes SET state='revoked',auto_eligible_at_failure=0,updated_at=${at} WHERE item_id=${row.itemId} AND state='scheduled'`;
                  yield* normalizePositions(row.threadId, at);
                  yield* bumpRevision(row.threadId, at);
                  changed.add(row.threadId);
                }
                return [...changed];
              }),
            )
            .pipe(Effect.mapError(normalizeError)),
    rescheduleByInstance: (instanceId, notBefore, guard) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              threadId: ThreadId;
              itemId: CommandId;
              limitKey: string;
            }>`SELECT thread_id AS "threadId",item_id AS "itemId",schedule_limit_key AS "limitKey" FROM next_turn_queue WHERE schedule_provider_instance_id=${instanceId} AND status='queued' AND deleted_at IS NULL`;
            const changed: ThreadId[] = [];
            for (const row of rows) {
              if (guard?.limitKey && guard.limitKey !== row.limitKey) continue;
              if (
                guard?.revision !== undefined &&
                (yield* readState(row.threadId)).revision !== guard.revision
              )
                continue;
              const at = now();
              yield* sql`UPDATE next_turn_queue SET not_before=${notBefore},updated_at=${at} WHERE item_id=${row.itemId} AND status='queued'`;
              yield* sql`UPDATE usage_limit_resumes SET prev_target=not_before,not_before=${notBefore},updated_at=${at} WHERE item_id=${row.itemId} AND limit_key=${row.limitKey}`;
              yield* bumpRevision(row.threadId, at);
              changed.push(row.threadId);
            }
            return changed;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),
    resetUsageResumeStreak: (threadId) =>
      sql`DELETE FROM usage_limit_resume_streaks WHERE thread_id=${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(normalizeError),
      ),
    completeUsageResume: (threadId) =>
      sql`UPDATE usage_limit_resumes SET state='completed',updated_at=${now()} WHERE thread_id=${threadId} AND state='scheduled'`.pipe(
        Effect.asVoid,
        Effect.mapError(normalizeError),
      ),

    getByCommandId: (commandId) =>
      readItemByCommandId(commandId).pipe(Effect.mapError(normalizeError)),

    getBySubmissionId: (submissionId) =>
      readSubmission(submissionId).pipe(Effect.mapError(normalizeError)),

    insertSubmission: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* readSubmission(input.submissionId);
            if (existing) {
              if (existing.requestHash !== input.requestHash) {
                return yield* new NextTurnQueueIdempotencyConflictError({
                  message: "That send identifier was already used for different content.",
                });
              }
              return { kind: "replay" as const, submission: existing };
            }

            if (input.supersedeUsageResume) {
              const at = now();
              yield* sql`UPDATE usage_limit_resumes SET state='superseded', updated_at=${at} WHERE thread_id=${input.command.threadId} AND item_id IN (SELECT item_id FROM next_turn_queue WHERE thread_id=${input.command.threadId} AND schedule_reason='usage_limit_reset' AND status='queued' AND deleted_at IS NULL)`;
              yield* sql`UPDATE turn_submissions SET disposition='canceled',settled_at=${at} WHERE submission_id IN (SELECT submission_id FROM next_turn_queue WHERE thread_id=${input.command.threadId} AND schedule_reason='usage_limit_reset' AND status='queued' AND deleted_at IS NULL)`;
              yield* sql`UPDATE next_turn_queue SET deleted_at=${at}, updated_at=${at} WHERE thread_id=${input.command.threadId} AND schedule_reason='usage_limit_reset' AND status='queued' AND deleted_at IS NULL`;
            }
            const countRows = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM next_turn_queue
              WHERE thread_id = ${input.command.threadId} AND deleted_at IS NULL
            `;
            if (
              (countRows[0]?.count ?? 0) >=
              MAX_QUEUED_TURNS_PER_THREAD + (input.scheduleReason ? 1 : 0)
            ) {
              return yield* new NextTurnQueueLimitExceededError({
                message: `A thread can queue at most ${MAX_QUEUED_TURNS_PER_THREAD} turns.`,
              });
            }

            const at = now();
            yield* ensureState(input.command.threadId, at);
            if (input.worktreeBlockToken !== undefined) {
              yield* sql`
                UPDATE next_turn_queue_state
                SET worktree_block_token = ${input.worktreeBlockToken}, updated_at = ${at}
                WHERE thread_id = ${input.command.threadId}
              `;
            }
            if (input.atHead) {
              yield* sql`
                UPDATE next_turn_queue
                SET position = position + 1, updated_at = ${at}
                WHERE thread_id = ${input.command.threadId} AND deleted_at IS NULL
              `;
            }
            const position = input.atHead
              ? 0
              : ((yield* sql<{ readonly position: number }>`
                    SELECT COALESCE(MAX(position), -1) + 1 AS position
                    FROM next_turn_queue
                    WHERE thread_id = ${input.command.threadId} AND deleted_at IS NULL
                  `)[0]?.position ?? 0);
            yield* sql`
              INSERT INTO turn_submissions (
                submission_id, thread_id, request_hash, item_id, message_id,
                disposition, created_at
              ) VALUES (
                ${input.submissionId}, ${input.command.threadId}, ${input.requestHash},
                ${input.itemId}, ${input.command.message.messageId}, 'pending', ${at}
              )
            `;
            yield* sql`
              INSERT INTO next_turn_queue (
                item_id, thread_id, submission_id, command_id, message_id, position,
                status, attempt_count, command_json, created_at, updated_at, not_before, schedule_reason, schedule_limit_key, schedule_provider_instance_id
              ) VALUES (
                ${input.itemId}, ${input.command.threadId}, ${input.submissionId},
                ${input.command.commandId}, ${input.command.message.messageId}, ${position},
                'queued', 0, ${JSON.stringify(input.command)}, ${at}, ${at}, ${input.notBefore ?? null}, ${input.scheduleReason ?? null}, ${input.scheduleLimitKey ?? null}, ${input.scheduleProviderInstanceId ?? null}
              )
            `;
            yield* Effect.forEach(
              input.command.message.attachments,
              (attachment) =>
                Effect.gen(function* () {
                  yield* sql`
                    DELETE FROM attachment_owners
                    WHERE attachment_id = ${attachment.id}
                      AND owner_kind = 'ingress'
                      AND owner_id = ${input.command.commandId}
                  `;
                  yield* sql`
                    INSERT OR IGNORE INTO attachment_owners (
                      attachment_id, owner_kind, owner_id, created_at
                    ) VALUES (${attachment.id}, 'queue_item', ${input.itemId}, ${at})
                  `;
                }),
              { concurrency: 1, discard: true },
            );
            yield* bumpRevision(input.command.threadId, at);
            return {
              kind: "created" as const,
              item: yield* requireItem(input.itemId),
            };
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    setSteer: (itemId, expectedRevision, expectedTurnId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(itemId);
            yield* rejectAcceptedMutation(item);
            const state = yield* readState(item.threadId);
            if (state.revision !== expectedRevision || item.status !== "queued")
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed before steering.",
              });
            const at = now();
            const command = { ...item.command, expectedTurnId };
            yield* sql`UPDATE next_turn_queue SET position = position + 1 WHERE thread_id = ${item.threadId} AND deleted_at IS NULL`;
            yield* sql`UPDATE next_turn_queue SET command_json = ${JSON.stringify(command)}, position = 0, updated_at = ${at} WHERE item_id = ${itemId}`;
            yield* bumpRevision(item.threadId, at);
            return yield* requireItem(itemId);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    fallbackSteer: (commandId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItemByCommandId(commandId);
            if (!item || !item.command.expectedTurnId) return;
            const { expectedTurnId: _expected, ...command } = item.command;
            const at = now();
            yield* sql`UPDATE next_turn_queue SET position = position + 1 WHERE thread_id = ${item.threadId} AND deleted_at IS NULL`;
            yield* sql`UPDATE next_turn_queue SET command_json = ${JSON.stringify(command)}, position = 0, status = 'queued', lease_owner = NULL, lease_expires_at = NULL, dispatch_started_at = NULL, not_before = NULL, last_error_code = 'steer_queued', last_error_detail = 'Steer not accepted; queued', updated_at = ${at} WHERE item_id = ${item.itemId}`;
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    recordStartedSubmission: (input) =>
      sql`
        INSERT OR IGNORE INTO turn_submissions (
          submission_id, thread_id, request_hash, item_id, message_id,
          disposition, result_sequence, created_at, settled_at
        ) VALUES (
          ${input.submissionId}, ${input.threadId}, ${input.requestHash}, NULL,
          ${input.messageId}, 'started', ${input.sequence}, ${now()}, ${now()}
        )
      `.pipe(Effect.asVoid, Effect.mapError(normalizeError)),

    settleSubmission: ({ submissionId, result }) =>
      (result.disposition === "started" || result.disposition === "steered"
        ? sql`
            UPDATE turn_submissions
            SET disposition = 'started', result_sequence = ${result.sequence},
                reason_code = NULL, settled_at = ${now()}
            WHERE submission_id = ${submissionId}
              AND disposition IN ('pending', 'queued', 'started')
          `
        : sql`
            UPDATE turn_submissions
            SET disposition = ${result.disposition}, result_sequence = NULL,
                reason_code = ${"reasonCode" in result ? result.reasonCode : null},
                settled_at = ${now()}
            WHERE submission_id = ${submissionId} AND disposition = 'pending'
          `
      ).pipe(Effect.asVoid, Effect.mapError(normalizeError)),

    updateCommand: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            if (item.status === "dispatching") {
              return yield* new NextTurnQueueItemDispatchingError({
                message: "That turn is already being sent. Stop the turn to change it.",
              });
            }
            if (item.updatedAt !== input.expectedUpdatedAt) {
              return yield* new NextTurnQueueConflictError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            yield* rejectAcceptedMutation(item);
            const at = now();
            const commandId = CommandId.makeUnsafe(randomUUID());
            const messageId = MessageId.makeUnsafe(randomUUID());
            const command = input.update({
              ...item.command,
              commandId,
              message: { ...item.command.message, messageId },
            });
            const changed = yield* sql<{ readonly itemId: string }>`
              UPDATE next_turn_queue
              SET command_id = ${commandId}, message_id = ${messageId},
                  command_json = ${JSON.stringify(command)}, status = 'queued',
                  attempt_count = 0, not_before = NULL, lease_owner = NULL,
                  lease_expires_at = NULL, dispatch_started_at = NULL,
                  last_error_code = NULL, last_error_detail = NULL, updated_at = ${at}
              WHERE item_id = ${input.itemId} AND deleted_at IS NULL
                AND status != 'dispatching' AND updated_at = ${input.expectedUpdatedAt}
              RETURNING item_id AS "itemId"
            `;
            if (changed.length !== 1) {
              return yield* new NextTurnQueueConflictError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            yield* bumpRevision(item.threadId, at);
            return yield* requireItem(input.itemId);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    retry: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            if (item.status === "dispatching") {
              return yield* new NextTurnQueueItemDispatchingError({
                message: "That turn is already being sent. Stop the turn to change it.",
              });
            }
            if (input.expectedUpdatedAt && item.updatedAt !== input.expectedUpdatedAt) {
              return yield* new NextTurnQueueConflictError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            yield* rejectAcceptedMutation(item);
            const at = now();
            const commandId = CommandId.makeUnsafe(randomUUID());
            const messageId = MessageId.makeUnsafe(randomUUID());
            const command: ThreadTurnStartCommand = {
              ...item.command,
              commandId,
              message: { ...item.command.message, messageId },
            };
            yield* sql`
              UPDATE next_turn_queue
              SET command_id = ${commandId}, message_id = ${messageId},
                  command_json = ${JSON.stringify(command)}, status = 'queued',
                  attempt_count = 0, not_before = NULL, lease_owner = NULL,
                  lease_expires_at = NULL, dispatch_started_at = NULL,
                  last_error_code = NULL, last_error_detail = NULL, updated_at = ${at}
              WHERE item_id = ${input.itemId} AND deleted_at IS NULL AND status != 'dispatching'
            `;
            yield* bumpRevision(item.threadId, at);
            return yield* requireItem(input.itemId);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    replacePositions: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const state = yield* readState(input.threadId);
            if (state.revision !== input.expectedRevision) {
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed in another client. Refresh and try again.",
              });
            }
            const current = yield* readItems(input.threadId);
            if (current.some((item) => item.status === "dispatching")) {
              return yield* new NextTurnQueueItemDispatchingError({
                message: "A turn is already being sent. Stop the turn before reordering.",
              });
            }
            const currentIds = new Set(current.map((item) => item.itemId));
            const requestedIds = new Set(input.orderedItemIds);
            if (
              current.length !== input.orderedItemIds.length ||
              requestedIds.size !== input.orderedItemIds.length ||
              input.orderedItemIds.some((itemId) => !currentIds.has(itemId))
            ) {
              return yield* new NextTurnQueueReorderMismatchError({
                message: "Reorder must include every queued turn exactly once.",
              });
            }
            const at = now();
            yield* Effect.forEach(
              input.orderedItemIds,
              (itemId, position) =>
                sql`
                  UPDATE next_turn_queue
                  SET position = ${position}, updated_at = ${at}
                  WHERE item_id = ${itemId} AND thread_id = ${input.threadId}
                    AND deleted_at IS NULL AND status != 'dispatching'
                `,
              { concurrency: 1, discard: true },
            );
            if (input.clearScheduleItemId)
              yield* sql`UPDATE next_turn_queue SET not_before=NULL WHERE item_id=${input.clearScheduleItemId} AND thread_id=${input.threadId} AND status='queued' AND deleted_at IS NULL`;
            yield* bumpRevision(input.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    setWorktreeBlockToken: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* ensureState(input.threadId);
            const at = now();
            yield* input.expectedToken === undefined
              ? sql`
                  UPDATE next_turn_queue_state
                  SET worktree_block_token = ${input.token}, revision = revision + 1,
                      updated_at = ${at}
                  WHERE thread_id = ${input.threadId}
                `
              : sql`
                  UPDATE next_turn_queue_state
                  SET worktree_block_token = ${input.token}, revision = revision + 1,
                      updated_at = ${at}
                  WHERE thread_id = ${input.threadId}
                    AND worktree_block_token IS ${input.expectedToken}
                `;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    setPaused: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const state = yield* readState(input.threadId);
            if (input.expectedRevision !== undefined && state.revision !== input.expectedRevision) {
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed in another client. Refresh and try again.",
              });
            }
            const at = now();
            yield* sql`
              UPDATE next_turn_queue_state
              SET paused = ${input.paused ? 1 : 0},
                  pause_reason_code = ${input.paused ? (input.reasonCode ?? "manual_pause") : null},
                  pause_detail = ${input.paused ? (input.detail ?? null) : null},
                  resumed_at = ${input.paused ? state.resumedAt : at},
                  revision = revision + 1,
                  updated_at = ${at}
              WHERE thread_id = ${input.threadId}
            `;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    setInterruptSuppression: (input) =>
      Effect.gen(function* () {
        yield* ensureState(input.threadId);
        yield* sql`
          UPDATE next_turn_queue_state
          SET interrupt_suppression_command_id = ${input.commandId}, updated_at = ${now()}
          WHERE thread_id = ${input.threadId}
        `;
      }).pipe(Effect.mapError(normalizeError)),

    claim: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<QueueRow>`
              UPDATE next_turn_queue
              SET status = 'dispatching', lease_owner = ${input.leaseOwner},
                  lease_expires_at = ${input.leaseExpiresAt},
                  attempt_count = attempt_count + 1,
                  dispatch_started_at = COALESCE(dispatch_started_at, ${input.now}),
                  updated_at = ${input.now}
              WHERE item_id = ${input.itemId} AND deleted_at IS NULL AND status = 'queued'
                AND (not_before IS NULL OR not_before <= ${input.now})
                AND NOT EXISTS (
                  SELECT 1
                  FROM attachment_owners AS owner
                  JOIN attachments AS attachment
                    ON attachment.attachment_id = owner.attachment_id
                  WHERE owner.owner_kind = 'queue_item'
                    AND owner.owner_id = next_turn_queue.item_id
                    AND attachment.lifecycle != 'ready'
                )
              RETURNING
                item_id AS "itemId", thread_id AS "threadId",
                submission_id AS "submissionId", position, status,
                attempt_count AS "attemptCount", not_before AS "notBefore",
                dispatch_started_at AS "dispatchStartedAt", command_json AS "commandJson",
                last_error_code AS "lastErrorCode", last_error_detail AS "lastErrorDetail",
                created_at AS "createdAt", updated_at AS "updatedAt"
            `;
            const row = rows[0];
            if (!row) return null;
            yield* bumpRevision(ThreadId.makeUnsafe(row.threadId), input.now);
            return { item: decodeRow(row), leaseOwner: input.leaseOwner };
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    releaseLease: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            const at = now();
            const rows = yield* sql<{ readonly itemId: string }>`
              UPDATE next_turn_queue
              SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                  not_before = ${input.notBefore}, last_error_code = ${input.errorCode},
                  last_error_detail = ${input.errorDetail},
                  dispatch_started_at = CASE WHEN ${input.clearDispatchStartedAt ? 1 : 0} = 1
                    THEN NULL ELSE dispatch_started_at END,
                  attempt_count = CASE WHEN ${input.consumeAttempt ? 1 : 0} = 1
                    THEN attempt_count ELSE MAX(0, attempt_count - 1) END,
                  updated_at = ${at}
              WHERE item_id = ${input.itemId} AND status = 'dispatching'
                AND lease_owner = ${input.leaseOwner}
              RETURNING item_id AS "itemId"
            `;
            if (rows.length !== 1) return;
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    markFailed: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            const at = now();
            const ownerClause = input.leaseOwner === null ? "" : "AND lease_owner = ?";
            const values = [input.errorCode, input.errorDetail, at, input.itemId];
            if (input.leaseOwner !== null) values.push(input.leaseOwner);
            const rows = yield* sql.unsafe<{ readonly itemId: string }>(
              `UPDATE next_turn_queue
               SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                   not_before = NULL, last_error_code = ?, last_error_detail = ?, updated_at = ?
               WHERE item_id = ? AND deleted_at IS NULL ${ownerClause}
               RETURNING item_id AS itemId`,
              values,
            );
            if (rows.length !== 1) return;
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    complete: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItem(input.itemId);
            if (!item) return;
            const ownerClause = input.leaseOwner === undefined ? "" : "AND lease_owner = ?";
            const values: unknown[] = [input.itemId];
            if (input.leaseOwner !== undefined) values.push(input.leaseOwner);
            const removed = yield* sql.unsafe<{ readonly itemId: string }>(
              `DELETE FROM next_turn_queue
               WHERE item_id = ? ${ownerClause}
               RETURNING item_id AS itemId`,
              values,
            );
            if (removed.length !== 1) return;
            yield* sql`
              DELETE FROM attachment_owners
              WHERE owner_kind = 'queue_item' AND owner_id = ${input.itemId}
            `;
            const at = now();
            yield* sql`
              UPDATE turn_submissions
              SET disposition = 'started', result_sequence = ${input.sequence ?? null},
                  settled_at = ${at}
              WHERE submission_id = ${item.submissionId}
            `;
            yield* normalizePositions(item.threadId, at);
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    markAwaitingDelivery: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItem(input.itemId);
            const at = now();
            if (item) {
              const changed = yield* sql<{ readonly itemId: string }>`
                UPDATE next_turn_queue
                SET lease_owner = ${`provider-delivery:${item.command.commandId}`},
                    lease_expires_at = NULL, not_before = NULL, updated_at = ${at}
                WHERE item_id = ${input.itemId} AND status = 'dispatching'
                  AND lease_owner = ${input.leaseOwner}
                RETURNING item_id AS "itemId"
              `;
              if (changed.length === 1) yield* bumpRevision(item.threadId, at);
              yield* sql`
                UPDATE turn_submissions
                SET disposition = 'started', result_sequence = ${input.sequence},
                    reason_code = NULL, settled_at = ${at}
                WHERE submission_id = ${item.submissionId}
                  AND disposition IN ('pending', 'queued', 'started')
              `;
            }
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    completeDelivery: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItemByCommandId(input.commandId);
            if (!item) return;
            yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${item.itemId}`;
            yield* sql`
              DELETE FROM attachment_owners
              WHERE owner_kind = 'queue_item' AND owner_id = ${item.itemId}
            `;
            const at = now();
            yield* sql`
              UPDATE turn_submissions
              SET disposition = 'started', settled_at = COALESCE(settled_at, ${at})
              WHERE submission_id = ${item.submissionId}
                AND disposition IN ('pending', 'queued', 'started')
            `;
            yield* normalizePositions(item.threadId, at);
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    markDeliveryFailed: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItemByCommandId(input.commandId);
            if (!item) return;
            const at = now();
            yield* sql`
              UPDATE next_turn_queue
              SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                  not_before = NULL, last_error_code = ${input.errorCode},
                  last_error_detail = ${input.errorDetail}, updated_at = ${at}
              WHERE item_id = ${item.itemId} AND deleted_at IS NULL
            `;
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    retryDelivery: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItemByCommandId(input.commandId);
            if (!item) return;
            const at = now();
            yield* sql`
              UPDATE next_turn_queue
              SET status = 'dispatching', lease_owner = ${`provider-delivery:${input.commandId}`},
                  lease_expires_at = NULL, not_before = NULL, last_error_code = NULL,
                  last_error_detail = NULL, updated_at = ${at}
              WHERE item_id = ${item.itemId} AND status IN ('failed', 'queued')
                AND deleted_at IS NULL
            `;
            yield* bumpRevision(item.threadId, at);
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    discardDelivery: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* readItemByCommandId(input.commandId);
            if (!item) return null;
            const at = now();
            yield* sql`
              UPDATE next_turn_queue SET deleted_at = ${at}, updated_at = ${at}
              WHERE item_id = ${item.itemId} AND status = 'failed' AND deleted_at IS NULL
            `;
            yield* sql`
              UPDATE turn_submissions SET disposition = 'canceled', settled_at = ${at}
              WHERE submission_id = ${item.submissionId} AND disposition != 'started'
            `;
            yield* normalizePositions(item.threadId, at);
            yield* bumpRevision(item.threadId, at);
            return item;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    softDelete: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            if (
              input.expectedRevision !== undefined &&
              (yield* readState(item.threadId)).revision !== input.expectedRevision
            )
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed. Refresh and try again.",
              });
            if (item.status === "dispatching") {
              return yield* new NextTurnQueueItemDispatchingError({
                message: "That turn is already being sent. Stop the turn to change it.",
              });
            }
            if (input.expectedUpdatedAt && item.updatedAt !== input.expectedUpdatedAt) {
              return yield* new NextTurnQueueConflictError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            yield* rejectAcceptedMutation(item);
            const at = now();
            const removed = yield* sql<{ readonly itemId: string }>`
              UPDATE next_turn_queue
              SET deleted_at = ${at}, updated_at = ${at}
              WHERE item_id = ${input.itemId} AND deleted_at IS NULL AND status != 'dispatching'
              RETURNING item_id AS "itemId"
            `;
            if (removed.length !== 1) {
              return yield* new NextTurnQueueConflictError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            yield* sql`
              UPDATE turn_submissions SET disposition = 'canceled', settled_at = ${at}
              WHERE submission_id = ${item.submissionId}
            `;
            yield* sql`UPDATE usage_limit_resumes SET state='cancelled', updated_at=${at} WHERE item_id=${item.itemId} AND state='scheduled'`;
            yield* normalizePositions(item.threadId, at);
            yield* bumpRevision(item.threadId, at);
            return item;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    clear: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const state = yield* readState(input.threadId);
            if (state.revision !== input.expectedRevision) {
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed in another client. Refresh and try again.",
              });
            }
            const items = (yield* readItems(input.threadId)).filter(
              (item) => input.scope === "all" || item.status === "failed",
            );
            if (items.some((item) => item.status === "dispatching")) {
              return yield* new NextTurnQueueItemDispatchingError({
                message: "A turn is already being sent. Stop the turn before clearing it.",
              });
            }
            yield* Effect.forEach(items, rejectAcceptedMutation, {
              concurrency: 1,
              discard: true,
            });
            if (items.length === 0) return [];
            const at = now();
            yield* Effect.forEach(
              items,
              (item) =>
                Effect.gen(function* () {
                  yield* sql`
                    UPDATE next_turn_queue SET deleted_at = ${at}, updated_at = ${at}
                    WHERE item_id = ${item.itemId} AND status != 'dispatching'
                  `;
                  yield* sql`
                    UPDATE turn_submissions SET disposition = 'cleared', settled_at = ${at}
                    WHERE submission_id = ${item.submissionId}
                  `;
                }),
              { concurrency: 1, discard: true },
            );
            for (const item of items)
              yield* sql`UPDATE usage_limit_resumes SET state='cancelled', updated_at=${at} WHERE item_id=${item.itemId} AND state='scheduled'`;
            yield* normalizePositions(input.threadId, at);
            yield* bumpRevision(input.threadId, at);
            return items;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    restore: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const state = yield* readState(input.threadId);
            if (state.revision !== input.expectedRevision) {
              return yield* new NextTurnQueueConflictError({
                message: "The queue changed in another client. Refresh and try again.",
              });
            }
            const at = now();
            const restored: NextTurnQueueItem[] = [];
            for (const itemId of input.itemIds) {
              const item = yield* requireItem(itemId, true);
              if (item.threadId !== input.threadId) continue;
              yield* rejectAcceptedMutation(item);
              const positionRows = yield* sql<{ readonly position: number }>`
                SELECT COALESCE(MAX(position), -1) + 1 AS position
                FROM next_turn_queue
                WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
              `;
              const rows = yield* sql<{ readonly itemId: string }>`
                UPDATE next_turn_queue
                SET deleted_at = NULL, position = ${positionRows[0]?.position ?? 0},
                    status = 'queued', not_before = NULL, last_error_code = NULL,
                    last_error_detail = NULL, updated_at = ${at}
                WHERE item_id = ${itemId} AND deleted_at IS NOT NULL
                RETURNING item_id AS "itemId"
              `;
              if (rows.length === 1) {
                yield* sql`
                  UPDATE turn_submissions SET disposition = 'queued', settled_at = ${at}
                  WHERE submission_id = ${item.submissionId}
                `;
                restored.push({ ...item, status: "queued", updatedAt: at });
              }
            }
            if (restored.length > 0) yield* bumpRevision(input.threadId, at);
            return restored;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    duplicate: (input) =>
      Effect.gen(function* () {
        const item = yield* requireItem(input.itemId);
        if (item.status === "dispatching") {
          return yield* new NextTurnQueueItemDispatchingError({
            message: "That turn is already being sent. Stop the turn to duplicate it.",
          });
        }
        if (input.expectedUpdatedAt && item.updatedAt !== input.expectedUpdatedAt) {
          return yield* new NextTurnQueueConflictError({
            message: "The queued turn changed in another client. Refresh and try again.",
          });
        }
        yield* rejectAcceptedMutation(item);
        const copiedAttachments: Array<{ readonly id: string; readonly path: string }> = [];
        const cleanupCopies = () =>
          Effect.forEach(
            copiedAttachments,
            (copied) =>
              Effect.all(
                [
                  fileSystem
                    .remove(copied.path, { force: true })
                    .pipe(Effect.catch(() => Effect.void)),
                  sql`DELETE FROM attachments WHERE attachment_id = ${copied.id}`.pipe(
                    Effect.ignore,
                  ),
                ],
                { discard: true },
              ),
            { concurrency: 1, discard: true },
          );
        const commandId = CommandId.makeUnsafe(randomUUID());
        const messageId = MessageId.makeUnsafe(randomUUID());
        const submissionId = CommandId.makeUnsafe(randomUUID());
        const duplicateId = CommandId.makeUnsafe(randomUUID());
        const attachments = yield* Effect.forEach(
          item.command.message.attachments,
          (attachment) =>
            Effect.gen(function* () {
              const attachmentId = createAttachmentId(item.threadId);
              if (!attachmentId) {
                return yield* new NextTurnQueueStorageError({
                  message: "Could not duplicate the queued turn attachment.",
                });
              }
              const nextAttachment = { ...attachment, id: attachmentId };
              const source = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              const destination = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: nextAttachment,
              });
              if (!source || !destination) {
                return yield* new NextTurnQueueStorageError({
                  message: "Could not duplicate the queued turn attachment.",
                });
              }
              yield* fileSystem.copyFile(source, destination).pipe(
                Effect.mapError(
                  (cause) =>
                    new NextTurnQueueStorageError({
                      message: "Could not duplicate the queued turn attachment.",
                      cause,
                    }),
                ),
              );
              copiedAttachments.push({ id: attachmentId, path: destination });
              const at = now();
              yield* sql`
                INSERT OR REPLACE INTO attachments (
                  attachment_id, thread_id, type, name, mime_type, size_bytes, content_hash,
                  staging_path, final_path, lifecycle, created_at, updated_at
                ) VALUES (
                  ${attachmentId}, ${item.threadId}, ${nextAttachment.type},
                  ${nextAttachment.name}, ${nextAttachment.mimeType}, ${nextAttachment.sizeBytes},
                  ${`copy:${attachment.id}`}, NULL, ${destination}, 'ready', ${at}, ${at}
                )
              `;
              yield* sql`
                INSERT OR IGNORE INTO attachment_owners (
                  attachment_id, owner_kind, owner_id, created_at
                ) VALUES (${attachmentId}, 'ingress', ${commandId}, ${at})
              `;
              return nextAttachment;
            }),
          { concurrency: 1 },
        ).pipe(Effect.tapError(cleanupCopies));
        const command: ThreadTurnStartCommand = {
          ...item.command,
          commandId,
          message: { ...item.command.message, messageId, attachments },
        };
        return yield* store
          .insertSubmission({
            submissionId,
            requestHash: `duplicate:${item.submissionId}:${submissionId}`,
            itemId: duplicateId,
            command,
            atHead: false,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.kind === "created"
                ? Effect.succeed(result.item)
                : Effect.fail(
                    new NextTurnQueueConflictError({
                      message: "Could not duplicate the queued turn.",
                    }),
                  ),
            ),
            Effect.tapError(cleanupCopies),
          );
      }).pipe(Effect.mapError(normalizeError)),

    reclaimStaleLeases: (liveItemIds) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const cutoff = new Date(Date.now() - DISPATCH_LEASE_TTL_MS).toISOString();
            const candidates = yield* queueRows(
              `WHERE status = 'dispatching' AND deleted_at IS NULL
               AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR updated_at <= ?)`,
              [now(), cutoff],
            );
            const threadIds = new Set<ThreadId>();
            for (const row of candidates) {
              const itemId = CommandId.makeUnsafe(row.itemId);
              if (liveItemIds.has(itemId)) continue;
              yield* sql`
                UPDATE next_turn_queue
                SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                    not_before = NULL, updated_at = ${now()}
                WHERE item_id = ${itemId} AND status = 'dispatching'
              `;
              threadIds.add(ThreadId.makeUnsafe(row.threadId));
            }
            yield* Effect.forEach(threadIds, (threadId) => bumpRevision(threadId), {
              concurrency: 1,
              discard: true,
            });
            return [...threadIds];
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    hardDeleteExpired: Effect.gen(function* () {
      const cutoff = new Date(Date.now() - SOFT_DELETE_RETENTION_MS).toISOString();
      const rows = yield* queueRows("WHERE deleted_at IS NOT NULL AND deleted_at <= ?", [cutoff]);
      const itemsByThread = new Map<ThreadId, NextTurnQueueItem[]>();
      for (const row of rows) {
        const decoded = yield* Effect.exit(Effect.sync(() => decodeRow(row)));
        if (Exit.isSuccess(decoded)) {
          const item = decoded.value;
          const items = itemsByThread.get(item.threadId) ?? [];
          items.push(item);
          itemsByThread.set(item.threadId, items);
        } else {
          // A corrupt tombstone can still be removed safely.
        }
        yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${row.itemId}`;
      }
      yield* Effect.forEach(itemsByThread.values(), (items) => removeAttachments(items), {
        concurrency: 1,
        discard: true,
      });
      return [...itemsByThread.keys()];
    }).pipe(Effect.mapError(normalizeError)),

    deleteForThread: (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const items = yield* readItems(threadId, true);
            yield* sql`DELETE FROM next_turn_queue WHERE thread_id = ${threadId}`;
            yield* removeAttachments(items);
            return items;
          }),
        )
        .pipe(Effect.mapError(normalizeError)),

    deleteOrphans: Effect.gen(function* () {
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT DISTINCT queue.thread_id AS "threadId"
        FROM next_turn_queue AS queue
        LEFT JOIN projection_threads AS thread ON thread.thread_id = queue.thread_id
        WHERE thread.thread_id IS NULL OR thread.deleted_at IS NOT NULL
      `;
      const threadIds = rows.map((row) => ThreadId.makeUnsafe(row.threadId));
      yield* Effect.forEach(threadIds, (threadId) => store.deleteForThread(threadId), {
        concurrency: 1,
        discard: true,
      });
      return threadIds;
    }).pipe(Effect.mapError(normalizeError)),

    drainOrphanedAttachments: Effect.gen(function* () {
      const attachmentsRoot = nodePath.resolve(config.attachmentsDir);
      const isOwnedAttachmentPath = (candidate: string) => {
        const resolved = nodePath.resolve(candidate);
        return (
          resolved !== attachmentsRoot && resolved.startsWith(`${attachmentsRoot}${nodePath.sep}`)
        );
      };
      const staged = yield* sql<{
        readonly attachmentId: string;
        readonly stagingPath: string;
        readonly finalPath: string;
      }>`
        SELECT attachment_id AS "attachmentId", staging_path AS "stagingPath",
          final_path AS "finalPath"
        FROM attachments
        WHERE lifecycle = 'staged' AND staging_path IS NOT NULL
      `;
      for (const attachment of staged) {
        if (
          !isOwnedAttachmentPath(attachment.stagingPath) ||
          !isOwnedAttachmentPath(attachment.finalPath)
        ) {
          yield* Effect.logWarning("discarding attachment metadata with unsafe staging paths", {
            attachmentId: attachment.attachmentId,
          });
          yield* sql`DELETE FROM attachments WHERE attachment_id = ${attachment.attachmentId}`;
          continue;
        }
        const stagingInfo = yield* fileSystem
          .stat(attachment.stagingPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const finalInfo = yield* fileSystem
          .stat(attachment.finalPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (stagingInfo?.type === "File") {
          yield* fileSystem.rename(attachment.stagingPath, attachment.finalPath);
        } else if (finalInfo?.type !== "File") {
          yield* sql`DELETE FROM attachments WHERE attachment_id = ${attachment.attachmentId}`;
          continue;
        }
        yield* sql`
          UPDATE attachments SET lifecycle = 'ready', staging_path = NULL, updated_at = ${now()}
          WHERE attachment_id = ${attachment.attachmentId}
        `;
      }

      const abandonedIngress = yield* sql<{
        readonly attachmentId: string;
        readonly stagingPath: string | null;
        readonly finalPath: string;
      }>`
        SELECT attachment.attachment_id AS "attachmentId",
          attachment.staging_path AS "stagingPath", attachment.final_path AS "finalPath"
        FROM attachments AS attachment
        JOIN attachment_owners AS ingress
          ON ingress.attachment_id = attachment.attachment_id
          AND ingress.owner_kind = 'ingress'
        WHERE NOT EXISTS (
          SELECT 1 FROM next_turn_queue AS queue
          WHERE queue.command_id = ingress.owner_id AND queue.deleted_at IS NULL
        )
          AND NOT EXISTS (
            SELECT 1 FROM attachment_owners AS live_owner
            WHERE live_owner.attachment_id = attachment.attachment_id
              AND live_owner.owner_kind != 'ingress'
          )
      `;
      for (const attachment of abandonedIngress) {
        for (const candidate of [attachment.stagingPath, attachment.finalPath]) {
          if (candidate !== null && isOwnedAttachmentPath(candidate)) {
            yield* fileSystem
              .remove(candidate, { force: true })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
        yield* sql`DELETE FROM attachments WHERE attachment_id = ${attachment.attachmentId}`;
      }
      const remainingStaged = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM attachments WHERE lifecycle = 'staged'
      `;
      if ((remainingStaged[0]?.count ?? 0) === 0) {
        yield* fileSystem
          .remove(nodePath.join(config.attachmentsDir, ".staging"), {
            recursive: true,
            force: true,
          })
          .pipe(Effect.catch(() => Effect.void));
      }

      const rows = yield* sql<{ readonly attachmentId: string }>`
        SELECT attachment_id AS "attachmentId"
        FROM next_turn_queue_orphaned_attachments
      `;
      for (const row of rows) {
        const matches = yield* fileSystem
          .readDirectory(config.attachmentsDir)
          .pipe(Effect.catch(() => Effect.succeed([])));
        yield* Effect.forEach(
          matches.filter((entry) => entry.startsWith(`${row.attachmentId}.`)),
          (entry) =>
            fileSystem
              .remove(`${config.attachmentsDir}/${entry}`, { force: true })
              .pipe(Effect.catch(() => Effect.void)),
          { discard: true },
        );
        yield* sql`
          DELETE FROM attachments WHERE attachment_id = ${row.attachmentId}
        `;
        yield* sql`
          DELETE FROM next_turn_queue_orphaned_attachments
          WHERE attachment_id = ${row.attachmentId}
        `;
      }
    }).pipe(Effect.mapError(normalizeError)),

    purgeSettledSubmissions: sql`
      DELETE FROM turn_submissions
      WHERE settled_at IS NOT NULL
        AND settled_at <= ${new Date(Date.now() - SUBMISSION_LEDGER_RETENTION_MS).toISOString()}
    `.pipe(Effect.asVoid, Effect.mapError(normalizeError)),

    summary: sql<{
      readonly threadId: string;
      readonly queuedCount: number;
      readonly dispatchingCount: number;
      readonly failedCount: number;
      readonly paused: number;
      readonly scheduledResumeAt: string | null;
    }>`
      SELECT
        queue.thread_id AS "threadId",
        SUM(CASE WHEN queue.status = 'queued' THEN 1 ELSE 0 END) AS "queuedCount",
        SUM(CASE WHEN queue.status = 'dispatching' THEN 1 ELSE 0 END) AS "dispatchingCount",
        SUM(CASE WHEN queue.status = 'failed' THEN 1 ELSE 0 END) AS "failedCount",
        COALESCE(state.paused, 0) AS paused,
        MIN(CASE WHEN queue.status='queued' AND queue.schedule_reason='usage_limit_reset' THEN queue.not_before END) AS "scheduledResumeAt"
      FROM next_turn_queue AS queue
      LEFT JOIN next_turn_queue_state AS state ON state.thread_id = queue.thread_id
      WHERE queue.deleted_at IS NULL
      GROUP BY queue.thread_id, state.paused
      ORDER BY queue.thread_id
    `.pipe(
      Effect.map(
        (rows): NextTurnQueueSummary => ({
          threads: rows.map((row) => ({
            threadId: ThreadId.makeUnsafe(row.threadId),
            queuedCount: row.queuedCount,
            dispatchingCount: row.dispatchingCount,
            failedCount: row.failedCount,
            paused: row.paused === 1,
            scheduledResumeAt: row.paused === 1 ? null : row.scheduledResumeAt,
          })),
        }),
      ),
      Effect.mapError(normalizeError),
    ),
  };

  return store;
});

export const NextTurnQueueStoreLive = Layer.effect(NextTurnQueueStore, makeNextTurnQueueStore);
