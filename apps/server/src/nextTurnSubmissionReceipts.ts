import type { CommandId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export type NextTurnSubmissionReceiptStatus =
  | "claimed"
  | "starting"
  | "steering"
  | "started"
  | "steered"
  | "delivery_unknown";

export interface NextTurnSubmissionReceipt {
  readonly itemId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly requestHash: string;
  readonly status: NextTurnSubmissionReceiptStatus;
  readonly ownerId: string;
  readonly sequence: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ReceiptRow {
  readonly itemId: string;
  readonly commandId: string;
  readonly threadId: string;
  readonly requestHash: string;
  readonly status: NextTurnSubmissionReceiptStatus;
  readonly ownerId: string;
  readonly sequence: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NextTurnSubmissionClaim =
  | { readonly kind: "acquired" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "recover_starting" }
  | { readonly kind: "started"; readonly sequence: number }
  | { readonly kind: "steered" }
  | { readonly kind: "delivery_unknown"; readonly error: string }
  | { readonly kind: "conflict"; readonly error: string };

export interface NextTurnSubmissionReceiptStore {
  readonly ownerId: string;
  readonly claim: (input: {
    readonly itemId: CommandId;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly requestHash: string;
    readonly now: string;
  }) => Effect.Effect<NextTurnSubmissionClaim, SqlError>;
  readonly beginStarting: (itemId: CommandId, now: string) => Effect.Effect<void, SqlError>;
  readonly beginSteering: (itemId: CommandId, now: string) => Effect.Effect<void, SqlError>;
  readonly reclaimStarting: (itemId: CommandId, now: string) => Effect.Effect<void, SqlError>;
  readonly completeStarted: (
    itemId: CommandId,
    sequence: number,
    now: string,
  ) => Effect.Effect<void, SqlError>;
  readonly completeSteered: (itemId: CommandId, now: string) => Effect.Effect<void, SqlError>;
  readonly releaseToQueue: (itemId: CommandId) => Effect.Effect<void, SqlError>;
  readonly releaseBeforeDelivery: (itemId: CommandId) => Effect.Effect<void, SqlError>;
  readonly markDeliveryUnknown: (
    itemId: CommandId,
    error: string,
    now: string,
  ) => Effect.Effect<void, SqlError>;
  readonly purgeThread: (threadId: ThreadId) => Effect.Effect<void, SqlError>;
}

function decodeRow(row: ReceiptRow): NextTurnSubmissionReceipt {
  return {
    itemId: row.itemId as CommandId,
    commandId: row.commandId as CommandId,
    threadId: row.threadId as ThreadId,
    requestHash: row.requestHash,
    status: row.status,
    ownerId: row.ownerId,
    sequence: row.sequence,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeNextTurnSubmissionReceiptStore(
  ownerId = `next-turn-submission:${crypto.randomUUID()}`,
): Effect.Effect<NextTurnSubmissionReceiptStore, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const findMatching = (itemId: CommandId, commandId: CommandId) =>
      sql<ReceiptRow>`
        SELECT
          item_id AS "itemId",
          command_id AS "commandId",
          thread_id AS "threadId",
          request_hash AS "requestHash",
          status,
          owner_id AS "ownerId",
          sequence,
          error,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM next_turn_submission_receipts
        WHERE item_id = ${itemId} OR command_id = ${commandId}
        LIMIT 1
      `.pipe(Effect.map((rows) => (rows[0] ? decodeRow(rows[0]) : null)));

    const claim: NextTurnSubmissionReceiptStore["claim"] = (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* findMatching(input.itemId, input.commandId);
          if (existing) {
            if (
              existing.itemId !== input.itemId ||
              existing.commandId !== input.commandId ||
              existing.threadId !== input.threadId ||
              existing.requestHash !== input.requestHash
            ) {
              return {
                kind: "conflict",
                error: "This submission ID was already used for different content.",
              } as const;
            }

            switch (existing.status) {
              case "started":
                return { kind: "started", sequence: existing.sequence ?? 0 } as const;
              case "steered":
                return { kind: "steered" } as const;
              case "delivery_unknown":
                return {
                  kind: "delivery_unknown",
                  error: existing.error ?? "Provider delivery could not be confirmed.",
                } as const;
              case "starting":
                return existing.ownerId === ownerId
                  ? ({ kind: "in_progress" } as const)
                  : ({ kind: "recover_starting" } as const);
              case "steering": {
                if (existing.ownerId === ownerId) return { kind: "in_progress" } as const;
                const error =
                  "The server restarted while steering the active turn; delivery could not be confirmed.";
                yield* sql`
                  UPDATE next_turn_submission_receipts
                  SET status = 'delivery_unknown', error = ${error}, updated_at = ${input.now}
                  WHERE item_id = ${input.itemId} AND status = 'steering'
                `;
                return { kind: "delivery_unknown", error } as const;
              }
              case "claimed":
                if (existing.ownerId === ownerId) return { kind: "in_progress" } as const;
                yield* sql`
                  UPDATE next_turn_submission_receipts
                  SET owner_id = ${ownerId}, updated_at = ${input.now}
                  WHERE item_id = ${input.itemId} AND status = 'claimed'
                `;
                return { kind: "acquired" } as const;
            }
          }

          yield* sql`
            INSERT INTO next_turn_submission_receipts (
              item_id,
              command_id,
              thread_id,
              request_hash,
              status,
              owner_id,
              sequence,
              error,
              created_at,
              updated_at
            ) VALUES (
              ${input.itemId},
              ${input.commandId},
              ${input.threadId},
              ${input.requestHash},
              'claimed',
              ${ownerId},
              NULL,
              NULL,
              ${input.now},
              ${input.now}
            )
          `;
          return { kind: "acquired" } as const;
        }),
      );

    const transition = (itemId: CommandId, status: "starting" | "steering", now: string) =>
      sql`
        UPDATE next_turn_submission_receipts
        SET status = ${status}, error = NULL, updated_at = ${now}
        WHERE item_id = ${itemId}
          AND owner_id = ${ownerId}
          AND status IN ('claimed', 'steering')
      `.pipe(Effect.asVoid);

    const completeStarted: NextTurnSubmissionReceiptStore["completeStarted"] = (
      itemId,
      sequence,
      now,
    ) =>
      sql`
        UPDATE next_turn_submission_receipts
        SET status = 'started', sequence = ${sequence}, error = NULL, updated_at = ${now}
        WHERE item_id = ${itemId}
          AND status = 'starting'
      `.pipe(Effect.asVoid);

    const completeSteered: NextTurnSubmissionReceiptStore["completeSteered"] = (itemId, now) =>
      sql`
        UPDATE next_turn_submission_receipts
        SET status = 'steered', error = NULL, updated_at = ${now}
        WHERE item_id = ${itemId}
          AND status = 'steering'
      `.pipe(Effect.asVoid);

    const reclaimStarting: NextTurnSubmissionReceiptStore["reclaimStarting"] = (itemId, now) =>
      sql`
        UPDATE next_turn_submission_receipts
        SET status = 'claimed', owner_id = ${ownerId}, error = NULL, updated_at = ${now}
        WHERE item_id = ${itemId} AND status = 'starting'
      `.pipe(Effect.asVoid);

    const releaseToQueue: NextTurnSubmissionReceiptStore["releaseToQueue"] = (itemId) =>
      sql`
        DELETE FROM next_turn_submission_receipts
        WHERE item_id = ${itemId} AND status = 'starting'
      `.pipe(Effect.asVoid);

    const releaseBeforeDelivery: NextTurnSubmissionReceiptStore["releaseBeforeDelivery"] = (
      itemId,
    ) =>
      sql`
        DELETE FROM next_turn_submission_receipts
        WHERE item_id = ${itemId}
          AND owner_id = ${ownerId}
          AND status IN ('claimed', 'starting')
      `.pipe(Effect.asVoid);

    const markDeliveryUnknown: NextTurnSubmissionReceiptStore["markDeliveryUnknown"] = (
      itemId,
      error,
      now,
    ) =>
      sql`
        UPDATE next_turn_submission_receipts
        SET status = 'delivery_unknown', sequence = NULL, error = ${error}, updated_at = ${now}
        WHERE item_id = ${itemId}
          AND status IN ('steering', 'starting')
      `.pipe(Effect.asVoid);

    const purgeThread: NextTurnSubmissionReceiptStore["purgeThread"] = (threadId) =>
      sql`
        DELETE FROM next_turn_submission_receipts
        WHERE thread_id = ${threadId}
      `.pipe(Effect.asVoid);

    return {
      ownerId,
      claim,
      beginStarting: (itemId, now) => transition(itemId, "starting", now),
      beginSteering: (itemId, now) => transition(itemId, "steering", now),
      reclaimStarting,
      completeStarted,
      completeSteered,
      releaseToQueue,
      releaseBeforeDelivery,
      markDeliveryUnknown,
      purgeThread,
    } satisfies NextTurnSubmissionReceiptStore;
  });
}
