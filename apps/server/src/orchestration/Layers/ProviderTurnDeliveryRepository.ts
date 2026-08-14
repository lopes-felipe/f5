import { OrchestrationEvent, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProviderTurnDelivery,
  ProviderTurnDeliveryRepository,
  type ProviderTurnDeliveryRepositoryShape,
} from "../Services/ProviderTurnDeliveryRepository.ts";

const DbRow = ProviderTurnDelivery.mapFields(
  Struct.assign({
    preSendTurnIds: Schema.fromJsonString(Schema.Array(TurnId)),
    event: Schema.fromJsonString(OrchestrationEvent),
  }),
);

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = (where: string) =>
    sql.unsafe<Record<string, unknown>>(`
    SELECT
      delivery_id AS "deliveryId", thread_id AS "threadId", command_id AS "commandId",
      message_id AS "messageId", state, provider_turn_id AS "providerTurnId", attempt,
      pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
      error_code AS "errorCode", error_detail AS "errorDetail", certainty,
      not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
      outcome_projected_at AS "outcomeProjectedAt"
    FROM provider_turn_deliveries ${where}
  `);
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));

  const listActionable = select(
    "WHERE state = 'pending' AND (not_before IS NULL OR julianday(not_before) <= julianday('now')) ORDER BY created_at",
  ).pipe(
    Effect.flatMap(decodeRows),
    Effect.mapError(mapError("ProviderTurnDelivery.listActionable")),
  );

  const listSending = select("WHERE state = 'sending' ORDER BY created_at").pipe(
    Effect.flatMap(decodeRows),
    Effect.mapError(mapError("ProviderTurnDelivery.listSending")),
  );

  const listUnprojectedTerminal = select(
    "WHERE state IN ('accepted', 'rejected', 'ambiguous') AND outcome_projected_at IS NULL ORDER BY updated_at",
  ).pipe(
    Effect.flatMap(decodeRows),
    Effect.mapError(mapError("ProviderTurnDelivery.listUnprojectedTerminal")),
  );

  const getByCommandId: ProviderTurnDeliveryRepositoryShape["getByCommandId"] = (commandId) =>
    sql
      .unsafe<Record<string, unknown>>(
        `
            SELECT delivery_id AS "deliveryId", thread_id AS "threadId", command_id AS "commandId",
              message_id AS "messageId", state, provider_turn_id AS "providerTurnId", attempt,
              pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
              error_code AS "errorCode", error_detail AS "errorDetail", certainty,
              not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
              outcome_projected_at AS "outcomeProjectedAt"
            FROM provider_turn_deliveries WHERE command_id = ? LIMIT 1
          `,
        [commandId],
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DbRow))),
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(mapError("ProviderTurnDelivery.getByCommandId")),
      );

  const getUnresolvedByThread: ProviderTurnDeliveryRepositoryShape["getUnresolvedByThread"] = (
    threadId,
  ) =>
    // A terminal newer delivery supersedes an older unresolved row on the
    // same thread. Otherwise workflow retry could reuse stale duplicate risk.
    sql
      .unsafe<Record<string, unknown>>(
        `SELECT delivery_id AS "deliveryId", thread_id AS "threadId",
             command_id AS "commandId", message_id AS "messageId", state,
             provider_turn_id AS "providerTurnId", attempt,
             pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
             error_code AS "errorCode", error_detail AS "errorDetail", certainty,
             not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
             outcome_projected_at AS "outcomeProjectedAt"
           FROM provider_turn_deliveries AS delivery
           WHERE delivery.thread_id = ?
             AND delivery.state IN ('pending', 'sending', 'rejected', 'ambiguous')
             AND NOT EXISTS (
               SELECT 1
               FROM provider_turn_deliveries AS newer
               WHERE newer.thread_id = delivery.thread_id
                 AND (
                   newer.created_at > delivery.created_at
                   OR (newer.created_at = delivery.created_at AND newer.rowid > delivery.rowid)
                 )
             )
           LIMIT 1`,
        [threadId],
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DbRow))),
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(mapError("ProviderTurnDelivery.getUnresolvedByThread")),
      );

  const claim: ProviderTurnDeliveryRepositoryShape["claim"] = (deliveryId, preSendTurnIds) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `
        UPDATE provider_turn_deliveries
        SET state = 'sending', attempt = attempt + 1, pre_send_turn_ids_json = ?, updated_at = ?
        WHERE delivery_id = ? AND state = 'pending'
        RETURNING delivery_id AS "deliveryId", thread_id AS "threadId", command_id AS "commandId",
          message_id AS "messageId", state, provider_turn_id AS "providerTurnId", attempt,
          pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
          error_code AS "errorCode", error_detail AS "errorDetail", certainty,
          not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
          outcome_projected_at AS "outcomeProjectedAt"
      `,
        [JSON.stringify(preSendTurnIds), now, deliveryId],
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DbRow))(rows);
      return decoded[0] ?? null;
    }).pipe(Effect.mapError(mapError("ProviderTurnDelivery.claim")));

  const markAccepted: ProviderTurnDeliveryRepositoryShape["markAccepted"] = (input) =>
    sql`
      UPDATE provider_turn_deliveries
      SET state = 'accepted', provider_turn_id = ${input.providerTurnId}, certainty = NULL,
          error_code = NULL, error_detail = NULL, not_before = NULL,
          outcome_projected_at = NULL, updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${input.deliveryId}
        AND state IN ('sending', 'rejected', 'ambiguous')
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.markAccepted")));

  const markRejected: ProviderTurnDeliveryRepositoryShape["markRejected"] = (input) =>
    sql`
      UPDATE provider_turn_deliveries
      SET state = ${input.ambiguous ? "ambiguous" : "rejected"},
          error_code = ${input.errorCode}, error_detail = ${input.errorDetail},
          certainty = ${input.certainty}, not_before = NULL,
          outcome_projected_at = NULL, updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${input.deliveryId} AND state = 'sending'
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.markRejected")));

  const requeue: ProviderTurnDeliveryRepositoryShape["requeue"] = (input) =>
    sql`
      UPDATE provider_turn_deliveries
      SET state = 'pending', not_before = ${input.notBefore}, error_code = ${input.errorCode},
          error_detail = ${input.errorDetail}, certainty = 'not_sent',
          outcome_projected_at = NULL, updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${input.deliveryId} AND state = 'sending'
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.requeue")));

  const retryTerminal: ProviderTurnDeliveryRepositoryShape["retryTerminal"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `UPDATE provider_turn_deliveries
         SET state = 'pending', attempt = 0, provider_turn_id = NULL, not_before = NULL,
             error_code = NULL, error_detail = NULL, certainty = NULL,
             outcome_projected_at = NULL, updated_at = ?
         WHERE delivery_id = ?
           AND (state = 'rejected' OR (state = 'ambiguous' AND ? = 1))
         RETURNING delivery_id AS "deliveryId", thread_id AS "threadId",
           command_id AS "commandId", message_id AS "messageId", state,
           provider_turn_id AS "providerTurnId", attempt,
           pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
           error_code AS "errorCode", error_detail AS "errorDetail", certainty,
           not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
           outcome_projected_at AS "outcomeProjectedAt"`,
        [new Date().toISOString(), input.deliveryId, input.allowPossibleDuplicate ? 1 : 0],
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DbRow))(rows);
      return decoded[0] ?? null;
    }).pipe(Effect.mapError(mapError("ProviderTurnDelivery.retryTerminal")));

  const markAbandoned: ProviderTurnDeliveryRepositoryShape["markAbandoned"] = (deliveryId) =>
    sql`
      UPDATE provider_turn_deliveries
      SET state = 'abandoned', outcome_projected_at = ${new Date().toISOString()},
          updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${deliveryId} AND state IN ('rejected', 'ambiguous')
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.markAbandoned")));

  const markOutcomeProjected: ProviderTurnDeliveryRepositoryShape["markOutcomeProjected"] = (
    deliveryId,
  ) =>
    sql`
        UPDATE provider_turn_deliveries
        SET outcome_projected_at = COALESCE(outcome_projected_at, ${new Date().toISOString()})
        WHERE delivery_id = ${deliveryId} AND state IN ('accepted', 'rejected', 'ambiguous')
      `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.markOutcomeProjected")));

  return {
    listActionable,
    listSending,
    listUnprojectedTerminal,
    getByCommandId,
    getUnresolvedByThread,
    claim,
    markAccepted,
    markRejected,
    requeue,
    retryTerminal,
    markAbandoned,
    markOutcomeProjected,
  };
});

export const ProviderTurnDeliveryRepositoryLive = Layer.effect(
  ProviderTurnDeliveryRepository,
  make,
);
