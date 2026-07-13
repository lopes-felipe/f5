import {
  type CommandId,
  type NextTurnQueueItem,
  type NextTurnQueueUpdateInput,
  ThreadTurnStartCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

const MAX_QUEUED_TURNS_PER_THREAD = 20;

interface QueueRow {
  readonly itemId: string;
  readonly threadId: string;
  readonly position: number;
  readonly status: string;
  readonly allowAfterError: number;
  readonly commandJson: string;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class NextTurnQueueError extends Schema.TaggedErrorClass<NextTurnQueueError>()(
  "NextTurnQueueError",
  { message: Schema.String },
) {}

export type NextTurnQueueStoreError = NextTurnQueueError | SqlError;

export interface NextTurnQueueStore {
  readonly list: (
    threadId: ThreadId,
  ) => Effect.Effect<NextTurnQueueItem[], NextTurnQueueStoreError>;
  readonly listThreadIds: Effect.Effect<ThreadId[], NextTurnQueueStoreError>;
  readonly enqueue: (input: {
    readonly itemId: CommandId;
    readonly command: ThreadTurnStartCommand;
  }) => Effect.Effect<NextTurnQueueItem[], NextTurnQueueStoreError>;
  readonly update: (
    input: NextTurnQueueUpdateInput,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly items: NextTurnQueueItem[] },
    NextTurnQueueStoreError
  >;
  readonly cancel: (
    itemId: CommandId,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly items: NextTurnQueueItem[] },
    NextTurnQueueStoreError
  >;
  readonly reorder: (input: {
    readonly threadId: ThreadId;
    readonly orderedItemIds: ReadonlyArray<CommandId>;
  }) => Effect.Effect<NextTurnQueueItem[], NextTurnQueueStoreError>;
  readonly resume: (
    itemId: CommandId,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly items: NextTurnQueueItem[] },
    NextTurnQueueStoreError
  >;
  readonly prepareForDispatch: (
    itemId: CommandId,
    dispatchStartedAt: string,
  ) => Effect.Effect<ThreadTurnStartCommand, NextTurnQueueStoreError>;
  readonly complete: (itemId: CommandId) => Effect.Effect<void, NextTurnQueueStoreError>;
  readonly pause: (
    itemId: CommandId,
    error: string,
  ) => Effect.Effect<void, NextTurnQueueStoreError>;
  readonly pauseThread: (
    threadId: ThreadId,
    error: string,
  ) => Effect.Effect<void, NextTurnQueueStoreError>;
}

function decodeRow(row: QueueRow): NextTurnQueueItem {
  let rawCommand: unknown;
  try {
    rawCommand = JSON.parse(row.commandJson);
  } catch {
    throw new NextTurnQueueError({
      message: `Queued turn '${row.itemId}' contains invalid command JSON.`,
    });
  }

  try {
    return {
      itemId: row.itemId as CommandId,
      threadId: row.threadId as ThreadId,
      position: row.position,
      status: row.status as NextTurnQueueItem["status"],
      allowAfterError: row.allowAfterError === 1,
      command: Schema.decodeUnknownSync(ThreadTurnStartCommand)(rawCommand),
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    throw new NextTurnQueueError({
      message: `Queued turn '${row.itemId}' contains an invalid command.`,
    });
  }
}

export const makeNextTurnQueueStore: Effect.Effect<NextTurnQueueStore, never, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rowsForThread = (threadId: ThreadId) =>
      sql<QueueRow>`
      SELECT
        item_id AS "itemId",
        thread_id AS "threadId",
        position,
        status,
        allow_after_error AS "allowAfterError",
        command_json AS "commandJson",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM next_turn_queue
      WHERE thread_id = ${threadId}
      ORDER BY position ASC, created_at ASC, item_id ASC
    `.pipe(Effect.map((rows) => rows.map(decodeRow)));

    const rowForItem = (itemId: CommandId) =>
      sql<QueueRow>`
      SELECT
        item_id AS "itemId",
        thread_id AS "threadId",
        position,
        status,
        allow_after_error AS "allowAfterError",
        command_json AS "commandJson",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM next_turn_queue
      WHERE item_id = ${itemId}
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] ? decodeRow(rows[0]) : null)));

    const rowForCommandId = (commandId: CommandId) =>
      sql<QueueRow>`
      SELECT
        item_id AS "itemId",
        thread_id AS "threadId",
        position,
        status,
        allow_after_error AS "allowAfterError",
        command_json AS "commandJson",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM next_turn_queue
      WHERE command_id = ${commandId}
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] ? decodeRow(rows[0]) : null)));

    const requireItem = (itemId: CommandId) =>
      rowForItem(itemId).pipe(
        Effect.flatMap((item) =>
          item
            ? Effect.succeed(item)
            : Effect.fail(
                new NextTurnQueueError({ message: `Queued turn '${itemId}' was not found.` }),
              ),
        ),
      );

    const normalizePositions = (threadId: ThreadId) =>
      rowsForThread(threadId).pipe(
        Effect.flatMap((items) =>
          Effect.forEach(
            items,
            (item, position) => sql`
            UPDATE next_turn_queue
            SET position = ${position}
            WHERE item_id = ${item.itemId}
          `,
            { concurrency: 1, discard: true },
          ),
        ),
      );

    const store: NextTurnQueueStore = {
      list: rowsForThread,
      listThreadIds: sql<{ readonly threadId: string }>`
      SELECT DISTINCT thread_id AS "threadId"
      FROM next_turn_queue
      ORDER BY thread_id ASC
    `.pipe(Effect.map((rows) => rows.map((row) => row.threadId as ThreadId))),
      enqueue: ({ itemId, command }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (command.bootstrap) {
              return yield* new NextTurnQueueError({
                message:
                  "Queued turns require an existing thread and cannot contain bootstrap work.",
              });
            }
            const existing = yield* rowForItem(itemId);
            if (existing) {
              if (
                existing.threadId !== command.threadId ||
                existing.command.commandId !== command.commandId
              ) {
                return yield* new NextTurnQueueError({
                  message: `Queue item '${itemId}' already exists with different content.`,
                });
              }
              return yield* rowsForThread(existing.threadId);
            }
            const existingCommand = yield* rowForCommandId(command.commandId);
            if (existingCommand) {
              if (existingCommand.threadId !== command.threadId) {
                return yield* new NextTurnQueueError({
                  message: `Command '${command.commandId}' is already queued for another thread.`,
                });
              }
              return yield* rowsForThread(existingCommand.threadId);
            }
            const current = yield* rowsForThread(command.threadId);
            if (current.length >= MAX_QUEUED_TURNS_PER_THREAD) {
              return yield* new NextTurnQueueError({
                message: `A thread can queue at most ${MAX_QUEUED_TURNS_PER_THREAD} turns.`,
              });
            }
            const now = new Date().toISOString();
            const position = current.length;
            yield* sql`
            INSERT INTO next_turn_queue (
              item_id,
              thread_id,
              command_id,
              position,
              status,
              allow_after_error,
              command_json,
              last_error,
              created_at,
              updated_at
            ) VALUES (
              ${itemId},
              ${command.threadId},
              ${command.commandId},
              ${position},
              'queued',
              0,
              ${JSON.stringify(command)},
              NULL,
              ${now},
              ${now}
            )
          `;
            return yield* rowsForThread(command.threadId);
          }),
        ),
      update: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(input.itemId);
            if (input.expectedUpdatedAt && input.expectedUpdatedAt !== item.updatedAt) {
              return yield* new NextTurnQueueError({
                message: "The queued turn changed in another client. Refresh and try again.",
              });
            }
            const command: ThreadTurnStartCommand = {
              ...item.command,
              ...(input.provider !== undefined ? { provider: input.provider } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
              ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
              message: {
                ...item.command.message,
                ...(input.text !== undefined ? { text: input.text } : {}),
              },
            };
            const now = new Date().toISOString();
            yield* sql`
            UPDATE next_turn_queue
            SET
              command_json = ${JSON.stringify(command)},
              status = 'queued',
              allow_after_error = 1,
              last_error = NULL,
              updated_at = ${now}
            WHERE item_id = ${input.itemId}
          `;
            return { threadId: item.threadId, items: yield* rowsForThread(item.threadId) };
          }),
        ),
      cancel: (itemId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(itemId);
            yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${itemId}`;
            yield* normalizePositions(item.threadId);
            return { threadId: item.threadId, items: yield* rowsForThread(item.threadId) };
          }),
        ),
      reorder: ({ threadId, orderedItemIds }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* rowsForThread(threadId);
            const currentIds = new Set(current.map((item) => item.itemId));
            const orderedIds = new Set(orderedItemIds);
            if (
              current.length !== orderedItemIds.length ||
              orderedIds.size !== orderedItemIds.length ||
              orderedItemIds.some((itemId) => !currentIds.has(itemId))
            ) {
              return yield* new NextTurnQueueError({
                message: "Reorder must include every queued turn exactly once.",
              });
            }
            yield* Effect.forEach(
              orderedItemIds,
              (itemId, position) => sql`
              UPDATE next_turn_queue
              SET position = ${position}, updated_at = ${new Date().toISOString()}
              WHERE item_id = ${itemId} AND thread_id = ${threadId}
            `,
              { concurrency: 1, discard: true },
            );
            return yield* rowsForThread(threadId);
          }),
        ),
      resume: (itemId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(itemId);
            yield* sql`
            UPDATE next_turn_queue
            SET
              status = 'queued',
              allow_after_error = 1,
              last_error = NULL,
              updated_at = ${new Date().toISOString()}
            WHERE item_id = ${itemId}
          `;
            return { threadId: item.threadId, items: yield* rowsForThread(item.threadId) };
          }),
        ),
      prepareForDispatch: (itemId, dispatchStartedAt) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const item = yield* requireItem(itemId);
            yield* sql`
              UPDATE next_turn_queue
              SET dispatch_started_at = COALESCE(dispatch_started_at, ${dispatchStartedAt})
              WHERE item_id = ${itemId}
            `;
            const timestamps = yield* sql<{ readonly dispatchStartedAt: string | null }>`
              SELECT dispatch_started_at AS "dispatchStartedAt"
              FROM next_turn_queue
              WHERE item_id = ${itemId}
              LIMIT 1
            `;
            const persistedDispatchStartedAt = timestamps[0]?.dispatchStartedAt;
            if (!persistedDispatchStartedAt) {
              return yield* new NextTurnQueueError({
                message: `Queued turn '${itemId}' could not be prepared for dispatch.`,
              });
            }
            return {
              ...item.command,
              createdAt: persistedDispatchStartedAt,
            };
          }),
        ),
      complete: (itemId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const item = yield* rowForItem(itemId);
            if (!item) return;
            yield* sql`DELETE FROM next_turn_queue WHERE item_id = ${itemId}`;
            yield* normalizePositions(item.threadId);
          }),
        ),
      pause: (itemId, error) =>
        sql`
      UPDATE next_turn_queue
      SET
        status = 'paused',
        allow_after_error = 0,
        last_error = ${error},
        updated_at = ${new Date().toISOString()}
      WHERE item_id = ${itemId}
    `.pipe(Effect.asVoid),
      pauseThread: (threadId, error) =>
        sql`
      UPDATE next_turn_queue
      SET
        status = 'paused',
        allow_after_error = 0,
        last_error = ${error},
        updated_at = ${new Date().toISOString()}
      WHERE thread_id = ${threadId}
    `.pipe(Effect.asVoid),
    };

    return store;
  });
