import {
  type ChatAttachment,
  type CommandId,
  type NextTurnQueueBlocker,
  type NextTurnQueueCancelOutcome,
  type NextTurnQueueItem,
  NextTurnQueueItem as NextTurnQueueItemSchema,
  type NextTurnQueueReorderInput,
  type NextTurnQueueResumeInput,
  type NextTurnQueueUpdateInput,
  ThreadTurnStartCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export const MAX_QUEUED_TURNS_PER_THREAD = 20;
export const NEXT_TURN_QUEUE_ENVELOPE_VERSION = 1;
const MAX_QUARANTINED_TURNS_PER_THREAD = 100;

interface QueueRow {
  readonly itemId: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly position: number;
  readonly status: string;
  readonly failurePolicy: string;
  readonly revision: number;
  readonly envelopeVersion: number;
  readonly commandJson: string;
  readonly blockerCode: string | null;
  readonly blockerMessage: string | null;
  readonly blockerResumable: number | null;
  readonly dispatchStartedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NextTurnQueueErrorCode =
  | "conflict"
  | "invalid_command"
  | "invalid_state"
  | "limit"
  | "not_found"
  | "stale_version";

export class NextTurnQueueError extends Schema.TaggedErrorClass<NextTurnQueueError>()(
  "NextTurnQueueError",
  {
    code: Schema.Literals([
      "conflict",
      "invalid_command",
      "invalid_state",
      "limit",
      "not_found",
      "stale_version",
    ]),
    message: Schema.String,
  },
) {}

export type NextTurnQueueStoreError = NextTurnQueueError | SqlError;

export interface NextTurnQueueStoredSnapshot {
  readonly threadId: ThreadId;
  readonly version: number;
  readonly items: ReadonlyArray<NextTurnQueueItem>;
}

export interface NextTurnQueueCancelStoreResult {
  readonly outcome: NextTurnQueueCancelOutcome;
  readonly cancelledItem: NextTurnQueueItem | null;
  readonly snapshot: NextTurnQueueStoredSnapshot;
}

export interface NextTurnQueueStore {
  readonly list: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueItem[], NextTurnQueueStoreError>;
  readonly getSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly listThreadIds: Effect.Effect<ThreadId[], NextTurnQueueStoreError>;
  readonly enqueue: (input: {
    readonly itemId: CommandId;
    readonly command: ThreadTurnStartCommand;
  }) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly update: (
    input: NextTurnQueueUpdateInput,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly cancel: (input: {
    readonly itemId: CommandId;
    readonly threadId: ThreadId;
    readonly expectedVersion: number;
  }) => Effect.Effect<NextTurnQueueCancelStoreResult, NextTurnQueueStoreError>;
  readonly reorder: (
    input: NextTurnQueueReorderInput,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly resume: (
    input: NextTurnQueueResumeInput,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly claimHead: (
    threadId: ThreadId,
    dispatchStartedAt: string,
  ) => Effect.Effect<NextTurnQueueItem | null, NextTurnQueueStoreError>;
  readonly complete: (itemId: CommandId) => Effect.Effect<
    {
      readonly completedItem: NextTurnQueueItem | null;
      readonly snapshot: NextTurnQueueStoredSnapshot | null;
    },
    NextTurnQueueStoreError
  >;
  readonly releaseClaim: (
    itemId: CommandId,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot | null, NextTurnQueueStoreError>;
  readonly pause: (
    itemId: CommandId,
    blocker: NextTurnQueueBlocker,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot | null, NextTurnQueueStoreError>;
  readonly pauseQueue: (input: {
    readonly threadId: ThreadId;
    readonly expectedVersion: number;
  }) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly resumeQueue: (input: {
    readonly threadId: ThreadId;
    readonly expectedVersion: number;
  }) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly clear: (input: {
    readonly threadId: ThreadId;
    readonly expectedVersion: number;
  }) => Effect.Effect<
    {
      readonly removedItems: ReadonlyArray<NextTurnQueueItem>;
      readonly skippedDispatching: boolean;
      readonly snapshot: NextTurnQueueStoredSnapshot;
    },
    NextTurnQueueStoreError
  >;
  readonly pauseThread: (
    threadId: ThreadId,
    blocker: NextTurnQueueBlocker,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly touchVersion: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueStoredSnapshot, NextTurnQueueStoreError>;
  readonly purgeThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly removedItems: ReadonlyArray<NextTurnQueueItem>; readonly version: number },
    NextTurnQueueStoreError
  >;
}

function queueError(code: NextTurnQueueErrorCode, message: string): NextTurnQueueError {
  return new NextTurnQueueError({ code, message });
}

function decodeRow(row: QueueRow): NextTurnQueueItem {
  if (row.envelopeVersion !== NEXT_TURN_QUEUE_ENVELOPE_VERSION) {
    throw queueError(
      "invalid_command",
      `Queued turn '${row.itemId}' uses unsupported envelope version ${row.envelopeVersion}.`,
    );
  }

  let rawCommand: unknown;
  try {
    rawCommand = JSON.parse(row.commandJson);
  } catch {
    throw queueError(
      "invalid_command",
      `Queued turn '${row.itemId}' contains invalid command JSON.`,
    );
  }

  const blocker =
    row.blockerCode !== null && row.blockerMessage !== null && row.blockerResumable !== null
      ? {
          code: row.blockerCode,
          message: row.blockerMessage,
          resumable: row.blockerResumable === 1,
        }
      : null;

  try {
    return Schema.decodeUnknownSync(NextTurnQueueItemSchema)({
      itemId: row.itemId,
      threadId: row.threadId,
      position: row.position,
      status: row.status,
      failurePolicy: row.failurePolicy,
      revision: row.revision,
      envelopeVersion: row.envelopeVersion,
      command: rawCommand,
      blocker,
      dispatchStartedAt: row.dispatchStartedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch {
    throw queueError("invalid_command", `Queued turn '${row.itemId}' contains an invalid command.`);
  }
}

function tryDecodeRow(
  row: QueueRow,
):
  | { readonly ok: true; readonly item: NextTurnQueueItem }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, item: decodeRow(row) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const makeNextTurnQueueStore: Effect.Effect<NextTurnQueueStore, never, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // SQL template fragments cannot be interpolated as identifiers by Effect SQL,
    // so these three selects intentionally repeat the stable column projection.
    const rawRowsForThread = (threadId: ThreadId) =>
      sql<QueueRow>`
        SELECT
          item_id AS "itemId",
          thread_id AS "threadId",
          command_id AS "commandId",
          position,
          status,
          failure_policy AS "failurePolicy",
          revision,
          envelope_version AS "envelopeVersion",
          command_json AS "commandJson",
          blocker_code AS "blockerCode",
          blocker_message AS "blockerMessage",
          blocker_resumable AS "blockerResumable",
          dispatch_started_at AS "dispatchStartedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM next_turn_queue
        WHERE thread_id = ${threadId}
        ORDER BY position ASC, created_at ASC, item_id ASC
      `;

    const rawRowForItem = (itemId: CommandId) =>
      sql<QueueRow>`
        SELECT
          item_id AS "itemId",
          thread_id AS "threadId",
          command_id AS "commandId",
          position,
          status,
          failure_policy AS "failurePolicy",
          revision,
          envelope_version AS "envelopeVersion",
          command_json AS "commandJson",
          blocker_code AS "blockerCode",
          blocker_message AS "blockerMessage",
          blocker_resumable AS "blockerResumable",
          dispatch_started_at AS "dispatchStartedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM next_turn_queue
        WHERE item_id = ${itemId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    const rawRowForCommandId = (commandId: CommandId) =>
      sql<QueueRow>`
        SELECT
          item_id AS "itemId",
          thread_id AS "threadId",
          command_id AS "commandId",
          position,
          status,
          failure_policy AS "failurePolicy",
          revision,
          envelope_version AS "envelopeVersion",
          command_json AS "commandJson",
          blocker_code AS "blockerCode",
          blocker_message AS "blockerMessage",
          blocker_resumable AS "blockerResumable",
          dispatch_started_at AS "dispatchStartedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM next_turn_queue
        WHERE command_id = ${commandId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    const ensureThreadState = (threadId: ThreadId) => {
      const now = new Date().toISOString();
      return sql`
        INSERT INTO next_turn_queue_threads (thread_id, version, updated_at)
        VALUES (${threadId}, 0, ${now})
        ON CONFLICT (thread_id) DO NOTHING
      `.pipe(Effect.asVoid);
    };

    const readVersion = (threadId: ThreadId) =>
      sql<{ readonly version: number }>`
        SELECT version
        FROM next_turn_queue_threads
        WHERE thread_id = ${threadId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.version ?? 0));

    const bumpVersion = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* ensureThreadState(threadId);
        yield* sql`
          UPDATE next_turn_queue_threads
          SET version = version + 1, updated_at = ${new Date().toISOString()}
          WHERE thread_id = ${threadId}
        `;
        return yield* readVersion(threadId);
      });

    const assertVersion = (threadId: ThreadId, expectedVersion: number) =>
      readVersion(threadId).pipe(
        Effect.flatMap((actualVersion) =>
          actualVersion === expectedVersion
            ? Effect.void
            : Effect.fail(
                queueError(
                  "stale_version",
                  `The queue changed in another client (expected version ${expectedVersion}, current version ${actualVersion}). Refresh and try again.`,
                ),
              ),
        ),
      );

    const normalizePositions = (threadId: ThreadId) =>
      rawRowsForThread(threadId).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row, position) =>
              row.position === position
                ? Effect.void
                : sql`
                    UPDATE next_turn_queue
                    SET position = ${position}
                    WHERE item_id = ${row.itemId}
                  `.pipe(Effect.asVoid),
            { concurrency: 1, discard: true },
          ),
        ),
      );

    const quarantineRow = (row: QueueRow, error: string) =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO next_turn_queue_quarantine (
            item_id,
            thread_id,
            command_id,
            position,
            envelope_version,
            command_json,
            error,
            quarantined_at
          ) VALUES (
            ${row.itemId},
            ${row.threadId},
            ${row.commandId},
            ${row.position},
            ${row.envelopeVersion},
            ${row.commandJson},
            ${error},
            ${now}
          )
          ON CONFLICT (item_id) DO UPDATE SET
            error = excluded.error,
            quarantined_at = excluded.quarantined_at
        `;
        yield* sql`
          DELETE FROM next_turn_queue_quarantine
          WHERE thread_id = ${row.threadId}
            AND item_id NOT IN (
              SELECT item_id
              FROM next_turn_queue_quarantine
              WHERE thread_id = ${row.threadId}
              ORDER BY quarantined_at DESC, item_id DESC
              LIMIT ${MAX_QUARANTINED_TURNS_PER_THREAD}
            )
        `;
        yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${row.itemId}`;
      });

    const rowsForThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* rawRowsForThread(threadId);
        const valid: NextTurnQueueItem[] = [];
        let quarantined = false;
        for (const row of rows) {
          const decoded = tryDecodeRow(row);
          if (decoded.ok) {
            valid.push(decoded.item);
            continue;
          }
          quarantined = true;
          yield* quarantineRow(row, decoded.error);
        }
        if (!quarantined) return valid;

        yield* normalizePositions(threadId);
        yield* bumpVersion(threadId);
        const reconciled = yield* rawRowsForThread(threadId);
        return reconciled.map(decodeRow);
      });

    const snapshotForThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const items = yield* rowsForThread(threadId);
        const version = yield* readVersion(threadId);
        return { threadId, version, items } satisfies NextTurnQueueStoredSnapshot;
      });

    const requireItem = (itemId: CommandId) =>
      rawRowForItem(itemId).pipe(
        Effect.flatMap((row) => {
          if (!row) {
            return Effect.fail(queueError("not_found", `Queued turn '${itemId}' was not found.`));
          }
          try {
            return Effect.succeed(decodeRow(row));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return quarantineRow(row, message).pipe(
              Effect.andThen(bumpVersion(row.threadId as ThreadId)),
              Effect.andThen(
                Effect.fail(queueError("invalid_command", `${message} The row was quarantined.`)),
              ),
            );
          }
        }),
      );

    const assertItemThread = (item: NextTurnQueueItem, threadId: ThreadId) =>
      item.threadId === threadId
        ? Effect.void
        : Effect.fail(
            queueError(
              "conflict",
              `Queued turn '${item.itemId}' does not belong to thread '${threadId}'.`,
            ),
          );

    const assertMutable = (item: NextTurnQueueItem) =>
      item.status !== "dispatching"
        ? Effect.void
        : Effect.fail(
            queueError(
              "invalid_state",
              `Queued turn '${item.itemId}' is already dispatching and can no longer be changed.`,
            ),
          );

    const store: NextTurnQueueStore = {
      list: rowsForThread,
      getSnapshot: snapshotForThread,
      listThreadIds: sql<{ readonly threadId: string }>`
        SELECT DISTINCT thread_id AS "threadId"
        FROM next_turn_queue
        ORDER BY thread_id ASC
      `.pipe(Effect.map((rows) => rows.map((row) => row.threadId as ThreadId))),

      enqueue: ({ itemId, command }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (command.bootstrap) {
              return yield* queueError(
                "invalid_command",
                "Queued turns require an existing thread and cannot contain bootstrap work.",
              );
            }

            yield* ensureThreadState(command.threadId);
            const serializedCommand = JSON.stringify(command);
            const existingRow = yield* rawRowForItem(itemId);
            if (existingRow) {
              if (
                existingRow.threadId !== command.threadId ||
                existingRow.commandId !== command.commandId ||
                existingRow.commandJson !== serializedCommand
              ) {
                return yield* queueError(
                  "conflict",
                  `Queue item '${itemId}' already exists with different content.`,
                );
              }
              return yield* snapshotForThread(command.threadId);
            }

            const existingCommandRow = yield* rawRowForCommandId(command.commandId);
            if (existingCommandRow) {
              if (
                existingCommandRow.threadId !== command.threadId ||
                existingCommandRow.commandJson !== serializedCommand
              ) {
                return yield* queueError(
                  "conflict",
                  `Command '${command.commandId}' is already queued with different content.`,
                );
              }
              return yield* snapshotForThread(command.threadId);
            }

            const current = yield* rowsForThread(command.threadId);
            if (current.length >= MAX_QUEUED_TURNS_PER_THREAD) {
              return yield* queueError(
                "limit",
                `A thread can queue at most ${MAX_QUEUED_TURNS_PER_THREAD} turns.`,
              );
            }

            const now = new Date().toISOString();
            yield* sql`
              INSERT INTO next_turn_queue (
                item_id,
                thread_id,
                command_id,
                position,
                status,
                failure_policy,
                revision,
                envelope_version,
                command_json,
                blocker_code,
                blocker_message,
                blocker_resumable,
                dispatch_started_at,
                claimed_at,
                created_at,
                updated_at
              ) VALUES (
                ${itemId},
                ${command.threadId},
                ${command.commandId},
                ${current.length},
                'queued',
                'stop',
                0,
                ${NEXT_TURN_QUEUE_ENVELOPE_VERSION},
                ${serializedCommand},
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                ${now},
                ${now}
              )
            `;
            yield* bumpVersion(command.threadId);
            return yield* snapshotForThread(command.threadId);
          }),
        ),

      update: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const item = yield* requireItem(input.itemId);
            yield* assertItemThread(item, input.threadId);
            yield* assertMutable(item);
            if (item.revision !== input.expectedRevision) {
              return yield* queueError(
                "stale_version",
                `The queued turn changed in another client (expected item revision ${input.expectedRevision}, current revision ${item.revision}). Refresh and try again.`,
              );
            }

            if (input.attachments !== undefined) {
              const existingAttachments = new Map<string, ChatAttachment>(
                item.command.message.attachments.map((attachment) => [attachment.id, attachment]),
              );
              const retainedIds = new Set<string>();
              const hasInvalidAttachment = input.attachments.some((attachment) => {
                if (retainedIds.has(attachment.id)) return true;
                retainedIds.add(attachment.id);
                const existing = existingAttachments.get(attachment.id);
                return (
                  existing === undefined ||
                  existing.type !== attachment.type ||
                  existing.name !== attachment.name ||
                  existing.mimeType !== attachment.mimeType ||
                  existing.sizeBytes !== attachment.sizeBytes
                );
              });
              if (hasInvalidAttachment) {
                return yield* queueError(
                  "invalid_command",
                  "Queued attachment edits may only remove attachments already owned by the item.",
                );
              }
            }

            const {
              provider: existingProvider,
              model: existingModel,
              modelSelection: existingModelSelection,
              modelOptions: existingModelOptions,
              ...baseCommand
            } = item.command;
            const command: ThreadTurnStartCommand = {
              ...baseCommand,
              ...(input.provider === undefined
                ? existingProvider !== undefined
                  ? { provider: existingProvider }
                  : {}
                : input.provider !== null
                  ? { provider: input.provider }
                  : {}),
              ...(input.model === undefined
                ? existingModel !== undefined
                  ? { model: existingModel }
                  : {}
                : input.model !== null
                  ? { model: input.model }
                  : {}),
              ...(input.modelSelection === undefined
                ? existingModelSelection !== undefined
                  ? { modelSelection: existingModelSelection }
                  : {}
                : input.modelSelection !== null
                  ? { modelSelection: input.modelSelection }
                  : {}),
              ...(input.modelOptions === undefined
                ? existingModelOptions !== undefined
                  ? { modelOptions: existingModelOptions }
                  : {}
                : input.modelOptions !== null
                  ? { modelOptions: input.modelOptions }
                  : {}),
              ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
              message: {
                ...item.command.message,
                ...(input.text !== undefined ? { text: input.text } : {}),
                ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              },
            };
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                command_json = ${JSON.stringify(command)},
                failure_policy = ${input.failurePolicy ?? item.failurePolicy},
                revision = revision + 1,
                updated_at = ${now}
              WHERE item_id = ${input.itemId}
            `;
            yield* bumpVersion(item.threadId);
            return yield* snapshotForThread(item.threadId);
          }),
        ),

      cancel: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const item = yield* requireItem(input.itemId);
            yield* assertItemThread(item, input.threadId);
            if (item.status === "dispatching") {
              return {
                outcome: "too_late" as const,
                cancelledItem: null,
                snapshot: yield* snapshotForThread(item.threadId),
              };
            }
            yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${input.itemId}`;
            yield* normalizePositions(item.threadId);
            yield* bumpVersion(item.threadId);
            return {
              outcome: "cancelled" as const,
              cancelledItem: item,
              snapshot: yield* snapshotForThread(item.threadId),
            };
          }),
        ),

      reorder: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const current = yield* rowsForThread(input.threadId);
            if (current.some((item) => item.status === "dispatching")) {
              return yield* queueError(
                "invalid_state",
                "The queue cannot be reordered while its head item is dispatching.",
              );
            }
            const currentIds = new Set(current.map((item) => item.itemId));
            const orderedIds = new Set(input.orderedItemIds);
            if (
              current.length !== input.orderedItemIds.length ||
              orderedIds.size !== input.orderedItemIds.length ||
              input.orderedItemIds.some((itemId) => !currentIds.has(itemId))
            ) {
              return yield* queueError(
                "conflict",
                "Reorder must include every queued turn exactly once.",
              );
            }

            const unchanged = input.orderedItemIds.every(
              (itemId, position) => current[position]?.itemId === itemId,
            );
            if (unchanged) return yield* snapshotForThread(input.threadId);

            const now = new Date().toISOString();
            yield* Effect.forEach(
              input.orderedItemIds,
              (itemId, position) =>
                sql`
                  UPDATE next_turn_queue
                  SET position = ${position}, revision = revision + 1, updated_at = ${now}
                  WHERE item_id = ${itemId} AND thread_id = ${input.threadId}
                `,
              { concurrency: 1, discard: true },
            );
            yield* bumpVersion(input.threadId);
            return yield* snapshotForThread(input.threadId);
          }),
        ),

      resume: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const item = yield* requireItem(input.itemId);
            yield* assertItemThread(item, input.threadId);
            yield* assertMutable(item);
            if (
              item.status !== "paused" &&
              (input.failurePolicy === undefined || input.failurePolicy === item.failurePolicy)
            ) {
              return yield* snapshotForThread(item.threadId);
            }
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'queued',
                failure_policy = ${input.failurePolicy ?? item.failurePolicy},
                blocker_code = NULL,
                blocker_message = NULL,
                blocker_resumable = NULL,
                claimed_at = NULL,
                revision = revision + 1,
                updated_at = ${now}
              WHERE item_id = ${input.itemId}
            `;
            yield* bumpVersion(item.threadId);
            return yield* snapshotForThread(item.threadId);
          }),
        ),

      claimHead: (threadId, dispatchStartedAt) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* rowsForThread(threadId);
            const head = current[0];
            if (!head || head.status !== "queued") return null;
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'dispatching',
                dispatch_started_at = COALESCE(dispatch_started_at, ${dispatchStartedAt}),
                claimed_at = ${now},
                revision = revision + 1,
                updated_at = ${now}
              WHERE item_id = ${head.itemId}
                AND thread_id = ${threadId}
                AND position = 0
                AND status = 'queued'
            `;
            const claimedRow = yield* rawRowForItem(head.itemId);
            if (!claimedRow || claimedRow.status !== "dispatching") return null;
            yield* bumpVersion(threadId);
            const claimed = decodeRow(claimedRow);
            return {
              ...claimed,
              command: {
                ...claimed.command,
                createdAt: claimed.dispatchStartedAt ?? dispatchStartedAt,
              },
            };
          }),
        ),

      complete: (itemId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* rawRowForItem(itemId);
            if (!row) return { completedItem: null, snapshot: null };
            const item = decodeRow(row);
            yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${itemId}`;
            yield* normalizePositions(item.threadId);
            yield* bumpVersion(item.threadId);
            return {
              completedItem: item,
              snapshot: yield* snapshotForThread(item.threadId),
            };
          }),
        ),

      releaseClaim: (itemId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* rawRowForItem(itemId);
            if (!row) return null;
            const item = decodeRow(row);
            if (item.status !== "dispatching") return yield* snapshotForThread(item.threadId);
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'queued',
                blocker_code = NULL,
                blocker_message = NULL,
                blocker_resumable = NULL,
                claimed_at = NULL,
                revision = revision + 1,
                updated_at = ${now}
              WHERE item_id = ${itemId}
                AND status = 'dispatching'
            `;
            yield* bumpVersion(item.threadId);
            return yield* snapshotForThread(item.threadId);
          }),
        ),

      pause: (itemId, blocker) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* rawRowForItem(itemId);
            if (!row) return null;
            const item = decodeRow(row);
            if (
              item.status === "paused" &&
              item.blocker?.code === blocker.code &&
              item.blocker.message === blocker.message &&
              item.blocker.resumable === blocker.resumable
            ) {
              return yield* snapshotForThread(item.threadId);
            }
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'paused',
                blocker_code = ${blocker.code},
                blocker_message = ${blocker.message},
                blocker_resumable = ${blocker.resumable ? 1 : 0},
                revision = revision + 1,
                updated_at = ${now}
              WHERE item_id = ${itemId}
            `;
            yield* bumpVersion(item.threadId);
            return yield* snapshotForThread(item.threadId);
          }),
        ),

      pauseQueue: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const current = yield* rowsForThread(input.threadId);
            const mutable = current.filter((item) => item.status === "queued");
            if (mutable.length === 0) return yield* snapshotForThread(input.threadId);
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'paused',
                blocker_code = 'manual_pause',
                blocker_message = 'Queue paused manually.',
                blocker_resumable = 1,
                revision = revision + 1,
                updated_at = ${now}
              WHERE thread_id = ${input.threadId}
                AND status = 'queued'
            `;
            yield* bumpVersion(input.threadId);
            return yield* snapshotForThread(input.threadId);
          }),
        ),

      resumeQueue: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const current = yield* rowsForThread(input.threadId);
            const resumable = current.filter(
              (item) =>
                item.status === "paused" &&
                (item.blocker?.code === "manual_pause" || item.blocker?.code === "queue_paused"),
            );
            if (resumable.length === 0) return yield* snapshotForThread(input.threadId);
            const now = new Date().toISOString();
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'queued',
                blocker_code = NULL,
                blocker_message = NULL,
                blocker_resumable = NULL,
                claimed_at = NULL,
                revision = revision + 1,
                updated_at = ${now}
              WHERE thread_id = ${input.threadId}
                AND status = 'paused'
                AND blocker_code IN ('manual_pause', 'queue_paused')
            `;
            yield* bumpVersion(input.threadId);
            return yield* snapshotForThread(input.threadId);
          }),
        ),

      clear: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* assertVersion(input.threadId, input.expectedVersion);
            const current = yield* rowsForThread(input.threadId);
            const removedItems = current.filter((item) => item.status !== "dispatching");
            const skippedDispatching = current.some((item) => item.status === "dispatching");
            if (removedItems.length > 0) {
              yield* sql`
                DELETE FROM next_turn_queue
                WHERE thread_id = ${input.threadId}
                  AND status <> 'dispatching'
              `;
              yield* normalizePositions(input.threadId);
              yield* bumpVersion(input.threadId);
            }
            return {
              removedItems,
              skippedDispatching,
              snapshot: yield* snapshotForThread(input.threadId),
            };
          }),
        ),

      pauseThread: (threadId, blocker) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const now = new Date().toISOString();
            const rows = yield* sql<{ readonly itemId: string }>`
              SELECT item_id AS "itemId"
              FROM next_turn_queue
              WHERE thread_id = ${threadId}
                AND status <> 'dispatching'
                AND NOT (
                  status = 'paused'
                  AND blocker_code = ${blocker.code}
                  AND blocker_message = ${blocker.message}
                  AND blocker_resumable = ${blocker.resumable ? 1 : 0}
                )
            `;
            if (rows.length === 0) return yield* snapshotForThread(threadId);
            yield* sql`
              UPDATE next_turn_queue
              SET
                status = 'paused',
                blocker_code = ${blocker.code},
                blocker_message = ${blocker.message},
                blocker_resumable = ${blocker.resumable ? 1 : 0},
                revision = revision + 1,
                updated_at = ${now}
              WHERE thread_id = ${threadId}
                AND status <> 'dispatching'
            `;
            yield* bumpVersion(threadId);
            return yield* snapshotForThread(threadId);
          }),
        ),

      touchVersion: (threadId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* rowsForThread(threadId);
            if (current.length === 0) return yield* snapshotForThread(threadId);
            yield* bumpVersion(threadId);
            return yield* snapshotForThread(threadId);
          }),
        ),

      purgeThread: (threadId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const removedItems = yield* rowsForThread(threadId);
            yield* sql`DELETE FROM next_turn_queue WHERE thread_id = ${threadId}`;
            yield* sql`DELETE FROM next_turn_queue_quarantine WHERE thread_id = ${threadId}`;
            const version =
              removedItems.length > 0 ? yield* bumpVersion(threadId) : yield* readVersion(threadId);
            return { removedItems, version };
          }),
        ),
    };

    return store;
  });
