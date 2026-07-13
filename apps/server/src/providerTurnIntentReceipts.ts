import type { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export type ProviderTurnIntentReceiptStatus =
  | "dispatching"
  | "accepted"
  | "failed"
  | "delivery_unknown";

export interface ProviderTurnIntentReceipt {
  readonly commandId: CommandId;
  readonly eventId: EventId;
  readonly threadId: ThreadId;
  readonly status: ProviderTurnIntentReceiptStatus;
  readonly ownerId: string;
  readonly error: string | null;
  readonly attemptedAt: string;
  readonly acceptedAt: string | null;
  readonly updatedAt: string;
}

interface ReceiptRow {
  readonly commandId: string;
  readonly eventId: string;
  readonly threadId: string;
  readonly status: ProviderTurnIntentReceiptStatus;
  readonly ownerId: string;
  readonly error: string | null;
  readonly attemptedAt: string;
  readonly acceptedAt: string | null;
  readonly updatedAt: string;
}

export type ProviderTurnIntentClaim =
  | { readonly kind: "acquired" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "accepted" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "delivery_unknown"; readonly error: string };

export interface ProviderTurnIntentReceiptStore {
  readonly ownerId: string;
  readonly get: (commandId: CommandId) => Effect.Effect<ProviderTurnIntentReceipt | null, SqlError>;
  readonly claim: (input: {
    readonly commandId: CommandId;
    readonly eventId: EventId;
    readonly threadId: ThreadId;
    readonly attemptedAt: string;
  }) => Effect.Effect<ProviderTurnIntentClaim, SqlError>;
  readonly accept: (commandId: CommandId, acceptedAt: string) => Effect.Effect<void, SqlError>;
  readonly fail: (commandId: CommandId, error: string) => Effect.Effect<void, SqlError>;
  readonly resetForExplicitRetry: (commandId: CommandId) => Effect.Effect<boolean, SqlError>;
}

function decodeRow(row: ReceiptRow): ProviderTurnIntentReceipt {
  return {
    commandId: row.commandId as CommandId,
    eventId: row.eventId as EventId,
    threadId: row.threadId as ThreadId,
    status: row.status,
    ownerId: row.ownerId,
    error: row.error,
    attemptedAt: row.attemptedAt,
    acceptedAt: row.acceptedAt,
    updatedAt: row.updatedAt,
  };
}

export function makeProviderTurnIntentReceiptStore(
  ownerId = `provider-reactor:${crypto.randomUUID()}`,
): Effect.Effect<ProviderTurnIntentReceiptStore, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const get = (commandId: CommandId) =>
      sql<ReceiptRow>`
        SELECT
          command_id AS "commandId",
          event_id AS "eventId",
          thread_id AS "threadId",
          status,
          owner_id AS "ownerId",
          error,
          attempted_at AS "attemptedAt",
          accepted_at AS "acceptedAt",
          updated_at AS "updatedAt"
        FROM provider_turn_intent_receipts
        WHERE command_id = ${commandId}
        LIMIT 1
      `.pipe(Effect.map((rows) => (rows[0] ? decodeRow(rows[0]) : null)));

    const claim: ProviderTurnIntentReceiptStore["claim"] = (input) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* get(input.commandId);
          if (existing) {
            switch (existing.status) {
              case "accepted":
                return { kind: "accepted" } as const;
              case "failed":
                return {
                  kind: "failed",
                  error: existing.error ?? "Provider rejected the turn.",
                } as const;
              case "delivery_unknown":
                return {
                  kind: "delivery_unknown",
                  error:
                    existing.error ??
                    "The server restarted while the provider handoff was in progress.",
                } as const;
              case "dispatching": {
                if (existing.ownerId === ownerId) {
                  return { kind: "in_progress" } as const;
                }
                const now = new Date().toISOString();
                const error =
                  "The server restarted while the provider handoff was in progress; delivery could not be confirmed.";
                yield* sql`
                  UPDATE provider_turn_intent_receipts
                  SET status = 'delivery_unknown', error = ${error}, updated_at = ${now}
                  WHERE command_id = ${input.commandId} AND status = 'dispatching'
                `;
                return { kind: "delivery_unknown", error } as const;
              }
            }
          }

          yield* sql`
            INSERT INTO provider_turn_intent_receipts (
              command_id,
              event_id,
              thread_id,
              status,
              owner_id,
              error,
              attempted_at,
              accepted_at,
              updated_at
            ) VALUES (
              ${input.commandId},
              ${input.eventId},
              ${input.threadId},
              'dispatching',
              ${ownerId},
              NULL,
              ${input.attemptedAt},
              NULL,
              ${input.attemptedAt}
            )
          `;
          return { kind: "acquired" } as const;
        }),
      );

    const accept: ProviderTurnIntentReceiptStore["accept"] = (commandId, acceptedAt) =>
      sql`
        UPDATE provider_turn_intent_receipts
        SET
          status = 'accepted',
          error = NULL,
          accepted_at = ${acceptedAt},
          updated_at = ${acceptedAt}
        WHERE command_id = ${commandId}
          AND status = 'dispatching'
          AND owner_id = ${ownerId}
      `.pipe(Effect.asVoid);

    const fail: ProviderTurnIntentReceiptStore["fail"] = (commandId, error) =>
      sql`
        UPDATE provider_turn_intent_receipts
        SET status = 'failed', error = ${error}, updated_at = ${new Date().toISOString()}
        WHERE command_id = ${commandId}
          AND status = 'dispatching'
          AND owner_id = ${ownerId}
      `.pipe(Effect.asVoid);

    const resetForExplicitRetry: ProviderTurnIntentReceiptStore["resetForExplicitRetry"] = (
      commandId,
    ) =>
      sql<{ readonly commandId: string }>`
        DELETE FROM provider_turn_intent_receipts
        WHERE command_id = ${commandId}
          AND status IN ('failed', 'delivery_unknown')
        RETURNING command_id AS "commandId"
      `.pipe(Effect.map((rows) => rows.length > 0));

    return {
      ownerId,
      get,
      claim,
      accept,
      fail,
      resetForExplicitRetry,
    } satisfies ProviderTurnIntentReceiptStore;
  });
}
