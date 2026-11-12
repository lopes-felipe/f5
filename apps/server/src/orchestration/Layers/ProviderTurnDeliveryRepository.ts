import { randomUUID } from "node:crypto";
import {
  type CommandId,
  OrchestrationEvent,
  OrchestrationUsageLimit,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  DELIVERY_HANDOFF_BODY_RETENTION,
  DeliveryHandoff,
  DeliveryHistoryEvidence,
  DeliveryAcceptanceReceipt,
  ProviderTurnDelivery,
  ProviderTurnDeliveryRepository,
  type ProviderTurnDeliveryRepositoryShape,
} from "../Services/ProviderTurnDeliveryRepository.ts";

const DbRow = ProviderTurnDelivery.mapFields(
  Struct.assign({
    preSendTurnIds: Schema.fromJsonString(Schema.Array(TurnId)),
    event: Schema.fromJsonString(OrchestrationEvent),
    historyEvidence: Schema.NullOr(Schema.fromJsonString(DeliveryHistoryEvidence)),
    handoff: Schema.NullOr(Schema.fromJsonString(DeliveryHandoff)),
    acceptanceReceipt: Schema.NullOr(Schema.fromJsonString(DeliveryAcceptanceReceipt)),
    usageLimit: Schema.NullOr(Schema.fromJsonString(OrchestrationUsageLimit)),
  }),
);

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const deliveryOwnershipAvailable = `(json_extract(candidate.event_json, '$.type') = 'thread.turn-steer-requested' OR NOT EXISTS (
          SELECT 1 FROM provider_turn_deliveries AS owner
          WHERE owner.thread_id = candidate.thread_id AND owner.delivery_id != candidate.delivery_id
            AND json_extract(owner.event_json, '$.type') != 'thread.turn-steer-requested'
            AND (owner.state IN ('sending', 'ambiguous') OR
              (owner.state = 'accepted' AND owner.reservation_released_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM projection_turns AS t WHERE t.thread_id = owner.thread_id AND t.turn_id = owner.provider_turn_id AND t.completed_at IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM projection_thread_sessions AS s WHERE s.thread_id = owner.thread_id AND s.status = 'stopped')))
        ))`;

const deliveryFifoAvailable = `(json_extract(candidate.event_json, '$.type') = 'thread.turn-steer-requested' OR NOT EXISTS (
          SELECT 1 FROM provider_turn_deliveries AS earlier
          WHERE earlier.thread_id = candidate.thread_id
            AND earlier.state = 'pending'
            AND (earlier.created_at < candidate.created_at OR
              (earlier.created_at = candidate.created_at AND earlier.rowid < candidate.rowid))
        ))`;

/**
 * One page of the delivery sweep. Most rows are terminal and the sweep must
 * not visit them, so it reads the pending-only partial index (migration 157).
 * The planner rates that index no better than the whole-table thread indexes,
 * hence INDEXED BY; `state = 'pending'` must stay a literal for it to apply.
 */
export const LIST_CANDIDATE_IDS_SQL = `
      SELECT delivery_id AS "deliveryId", thread_id AS "threadId"
      FROM provider_turn_deliveries AS candidate
        INDEXED BY idx_provider_turn_deliveries_pending_thread
      WHERE state = 'pending' AND thread_id > ?
        AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND ${deliveryOwnershipAvailable}
        AND ${deliveryFifoAvailable}
        AND NOT EXISTS (
          SELECT 1 FROM provider_turn_deliveries AS steer
          WHERE steer.thread_id = candidate.thread_id AND steer.state = 'pending'
            AND json_extract(steer.event_json, '$.type') = 'thread.turn-steer-requested'
            AND (json_extract(candidate.event_json, '$.type') != 'thread.turn-steer-requested'
              OR steer.created_at < candidate.created_at
              OR (steer.created_at = candidate.created_at AND steer.rowid < candidate.rowid))
        )
      ORDER BY thread_id LIMIT ?`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = (where: string) =>
    sql.unsafe<Record<string, unknown>>(`
    SELECT
      delivery_id AS "deliveryId", thread_id AS "threadId", command_id AS "commandId",
      message_id AS "messageId", state, provider_turn_id AS "providerTurnId", attempt,
      acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
      error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
      not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
      outcome_projected_at AS "outcomeProjectedAt"
    FROM provider_turn_deliveries ${where}
  `);
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(DbRow));

  const listCandidateIds: ProviderTurnDeliveryRepositoryShape["listCandidateIds"] = ({
    afterThreadId,
    limit,
  }) =>
    sql
      .unsafe<{
        deliveryId: string;
        threadId: string;
      }>(LIST_CANDIDATE_IDS_SQL, [afterThreadId, Math.min(64, Math.max(1, limit))])
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                deliveryId: ProviderTurnDelivery.fields.deliveryId,
                threadId: ProviderTurnDelivery.fields.threadId,
              }),
            ),
          ),
        ),
        Effect.mapError(mapError("ProviderTurnDelivery.listCandidateIds")),
      );

  const listActionable = select(
    "WHERE state = 'pending' AND (not_before IS NULL OR julianday(not_before) <= julianday('now')) ORDER BY created_at LIMIT 64",
  ).pipe(
    Effect.flatMap(decodeRows),
    Effect.mapError(mapError("ProviderTurnDelivery.listActionable")),
  );

  const listSending = select("WHERE state = 'sending' ORDER BY created_at LIMIT 64").pipe(
    Effect.flatMap(decodeRows),
    Effect.mapError(mapError("ProviderTurnDelivery.listSending")),
  );

  const listUnprojectedTerminal = select(
    "WHERE state IN ('accepted', 'rejected', 'ambiguous') AND outcome_projected_at IS NULL ORDER BY updated_at LIMIT 64",
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
              acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
              error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
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
             acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
             error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
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

  const getLatestByThread: ProviderTurnDeliveryRepositoryShape["getLatestByThread"] = (threadId) =>
    sql
      .unsafe<Record<string, unknown>>(
        `SELECT delivery_id AS "deliveryId", thread_id AS "threadId",
             command_id AS "commandId", message_id AS "messageId", state,
             provider_turn_id AS "providerTurnId", attempt,
             acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
             error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
             not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
             outcome_projected_at AS "outcomeProjectedAt"
           FROM provider_turn_deliveries
           WHERE thread_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        [threadId],
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DbRow))),
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError(mapError("ProviderTurnDelivery.getLatestByThread")),
      );

  const listAcceptedTurnIdsByThread: ProviderTurnDeliveryRepositoryShape["listAcceptedTurnIdsByThread"] =
    (threadId) =>
      sql
        .unsafe<{ readonly turnId: string }>(
          `SELECT provider_turn_id AS "turnId" FROM provider_turn_deliveries
           WHERE thread_id = ? AND state = 'accepted' AND provider_turn_id IS NOT NULL`,
          [threadId],
        )
        .pipe(
          Effect.map((rows) => rows.map((row) => TurnId.makeUnsafe(row.turnId))),
          Effect.mapError(mapError("ProviderTurnDelivery.listAcceptedTurnIdsByThread")),
        );

  const getSupersedingPreSendTurnIds: ProviderTurnDeliveryRepositoryShape["getSupersedingPreSendTurnIds"] =
    (deliveryId) =>
      sql
        .unsafe<{ readonly preSendTurnIds: string }>(
          `SELECT newer.pre_send_turn_ids_json AS "preSendTurnIds"
           FROM provider_turn_deliveries AS target
           JOIN provider_turn_deliveries AS newer
             ON newer.thread_id = target.thread_id
            AND (
              newer.created_at > target.created_at
              OR (newer.created_at = target.created_at AND newer.rowid > target.rowid)
            )
           WHERE target.delivery_id = ?
             AND (newer.state != 'pending' OR newer.attempt > 0)
           ORDER BY newer.created_at, newer.rowid
           LIMIT 1`,
          [deliveryId],
        )
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.succeed(null)
              : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(TurnId)))(
                  rows[0].preSendTurnIds,
                ),
          ),
          Effect.mapError(mapError("ProviderTurnDelivery.getSupersedingPreSendTurnIds")),
        );

  const recordDispatchIntent: ProviderTurnDeliveryRepositoryShape["recordDispatchIntent"] = (
    input,
  ) =>
    sql`UPDATE provider_turn_deliveries
      SET pre_send_turn_ids_json = ${JSON.stringify(input.preSendTurnIds)},
          history_evidence_json = ${input.historyEvidence ? JSON.stringify(input.historyEvidence) : null}
      WHERE delivery_id = ${input.deliveryId} AND attempt_id = ${input.attemptId} AND state = 'sending'
      RETURNING delivery_id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapError("ProviderTurnDelivery.recordDispatchIntent")),
    );

  const recordHandoff: ProviderTurnDeliveryRepositoryShape["recordHandoff"] = (input) =>
    Effect.gen(function* () {
      yield* sql`UPDATE provider_turn_deliveries SET handoff_json = ${JSON.stringify(input.handoff)}
        WHERE delivery_id = ${input.deliveryId} AND attempt_id = ${input.attemptId}
          AND state = 'sending' AND (handoff_json IS NULL OR ${input.replace === true ? 1 : 0} = 1)`;
      const rows = yield* sql<{ readonly handoff: string | null }>`
        SELECT handoff_json AS "handoff" FROM provider_turn_deliveries
        WHERE delivery_id = ${input.deliveryId} AND attempt_id = ${input.attemptId} AND state = 'sending'`;
      const stored = rows[0]?.handoff;
      return stored
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeliveryHandoff))(stored)
        : null;
    }).pipe(Effect.mapError(mapError("ProviderTurnDelivery.recordHandoff")));

  const claim: ProviderTurnDeliveryRepositoryShape["claim"] = (
    deliveryId,
    preSendTurnIds,
    historyEvidence,
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `
        UPDATE provider_turn_deliveries AS candidate
        SET state = 'sending', attempt = attempt + 1, pre_send_turn_ids_json = ?, history_evidence_json = ?, attempt_id = ?, acceptance_receipt_json = NULL, reservation_released_at = NULL, updated_at = ?
        WHERE delivery_id = ? AND state = 'pending'
          AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          AND ${deliveryOwnershipAvailable}
          AND ${deliveryFifoAvailable}
        RETURNING delivery_id AS "deliveryId", thread_id AS "threadId", command_id AS "commandId",
          message_id AS "messageId", state, provider_turn_id AS "providerTurnId", attempt,
          acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
          error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
          not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
          outcome_projected_at AS "outcomeProjectedAt"
      `,
        [
          JSON.stringify(preSendTurnIds),
          historyEvidence ? JSON.stringify(historyEvidence) : null,
          randomUUID(),
          now,
          deliveryId,
        ],
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DbRow))(rows);
      return decoded[0] ?? null;
    }).pipe(Effect.mapError(mapError("ProviderTurnDelivery.claim")));

  const markAccepted: ProviderTurnDeliveryRepositoryShape["markAccepted"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly deliveryId: string }>`
      UPDATE provider_turn_deliveries
      SET state = 'accepted', provider_turn_id = ${input.providerTurnId}, certainty = NULL,
          acceptance_receipt_json = COALESCE(${input.receipt ? JSON.stringify(input.receipt) : null}, acceptance_receipt_json),
          error_code = NULL, error_detail = NULL, usage_limit_json = NULL, not_before = NULL,
          outcome_projected_at = NULL, updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${input.deliveryId}
        AND state IN ('sending', 'rejected', 'ambiguous')
        AND (${input.attemptId ?? null} IS NULL OR attempt_id = ${input.attemptId ?? null})
      RETURNING delivery_id AS "deliveryId"
    `;
          if (rows.length === 0) return false;
          // ACP completion can be projected before sendTurn returns its receipt.
          yield* sql`UPDATE provider_turn_deliveries SET reservation_released_at = ${new Date().toISOString()}
            WHERE delivery_id = ${input.deliveryId} AND reservation_released_at IS NULL
              AND EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id = provider_turn_deliveries.thread_id
                AND t.turn_id = ${input.providerTurnId} AND t.completed_at IS NOT NULL)`;
          yield* sql`UPDATE restart_continuations SET provider_turn_id = ${input.providerTurnId} WHERE continuation_id = ${input.deliveryId}`;
          // A consumed handoff clears its pending marker in the same transaction as
          // the receipt, so neither a crash nor a retry can lose or replay it.
          yield* sql`UPDATE provider_handoff_state
            SET pending_json = NULL, revision = revision + 1, updated_at = ${new Date().toISOString()}
            WHERE pending_json IS NOT NULL
              AND EXISTS (SELECT 1 FROM provider_turn_deliveries AS d
                WHERE d.delivery_id = ${input.deliveryId}
                  AND d.thread_id = provider_handoff_state.thread_id
                  AND d.handoff_json IS NOT NULL
                  AND json_extract(d.handoff_json, '$.disposition') = 'consumed'
                  AND json_extract(d.handoff_json, '$.id') = json_extract(provider_handoff_state.pending_json, '$.id'))`;
          yield* trimHandoffBodies(input.deliveryId);
          return true;
        }),
      )
      .pipe(Effect.mapError(mapError("ProviderTurnDelivery.markAccepted")));

  /**
   * Settled handoff bodies beyond the newest few on the thread keep only their
   * manifest. A retried rejected or ambiguous delivery rebuilds a trimmed body.
   */
  const trimHandoffBodies = (deliveryId: CommandId) =>
    sql`UPDATE provider_turn_deliveries
      SET handoff_json = json_set(handoff_json, '$.block', json('null'))
      WHERE rowid IN (
        SELECT d.rowid FROM provider_turn_deliveries AS d
        WHERE d.thread_id = (SELECT thread_id FROM provider_turn_deliveries WHERE delivery_id = ${deliveryId})
          AND d.state IN ('accepted', 'abandoned', 'rejected', 'ambiguous')
          AND d.handoff_json IS NOT NULL
          AND json_extract(d.handoff_json, '$.block') IS NOT NULL
        ORDER BY d.updated_at DESC, d.rowid DESC
        LIMIT -1 OFFSET ${DELIVERY_HANDOFF_BODY_RETENTION})`;

  const markRejected: ProviderTurnDeliveryRepositoryShape["markRejected"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
      UPDATE provider_turn_deliveries
      SET state = ${input.ambiguous ? "ambiguous" : "rejected"},
          error_code = ${input.errorCode}, error_detail = ${input.errorDetail},
          certainty = ${input.certainty}, not_before = NULL,
          usage_limit_json = ${input.usageLimit ? JSON.stringify(input.usageLimit) : null},
          outcome_projected_at = NULL, updated_at = ${input.occurredAt ?? new Date().toISOString()}
      WHERE delivery_id = ${input.deliveryId} AND state = 'sending'
        AND (${input.attemptId ?? null} IS NULL OR attempt_id = ${input.attemptId ?? null})
      RETURNING delivery_id
    `;
          if (rows.length === 0) return false;
          yield* trimHandoffBodies(input.deliveryId);
          return true;
        }),
      )
      .pipe(Effect.mapError(mapError("ProviderTurnDelivery.markRejected")));

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
             error_code = NULL, error_detail = NULL, usage_limit_json = NULL, certainty = NULL,
             outcome_projected_at = NULL, updated_at = ?
         WHERE delivery_id = ?
           AND (state = 'rejected' OR (state = 'ambiguous' AND ? = 1))
         RETURNING delivery_id AS "deliveryId", thread_id AS "threadId",
           command_id AS "commandId", message_id AS "messageId", state,
           provider_turn_id AS "providerTurnId", attempt,
           acceptance_receipt_json AS "acceptanceReceipt", attempt_id AS "attemptId", history_evidence_json AS "historyEvidence", handoff_json AS "handoff", pre_send_turn_ids_json AS "preSendTurnIds", event_json AS "event",
           error_code AS "errorCode", error_detail AS "errorDetail", usage_limit_json AS "usageLimit", certainty,
           not_before AS "notBefore", created_at AS "createdAt", updated_at AS "updatedAt",
           outcome_projected_at AS "outcomeProjectedAt"`,
        [new Date().toISOString(), input.deliveryId, input.allowPossibleDuplicate ? 1 : 0],
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DbRow))(rows);
      return decoded[0] ?? null;
    }).pipe(Effect.mapError(mapError("ProviderTurnDelivery.retryTerminal")));

  const markAbandoned: ProviderTurnDeliveryRepositoryShape["markAbandoned"] = (deliveryId) =>
    sql<{ readonly deliveryId: string }>`
      UPDATE provider_turn_deliveries
      SET state = 'abandoned', outcome_projected_at = ${new Date().toISOString()},
          updated_at = ${new Date().toISOString()}
      WHERE delivery_id = ${deliveryId} AND state IN ('rejected', 'ambiguous')
      RETURNING delivery_id AS "deliveryId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapError("ProviderTurnDelivery.markAbandoned")),
    );

  const markOutcomeProjected: ProviderTurnDeliveryRepositoryShape["markOutcomeProjected"] = (
    deliveryId,
  ) =>
    sql`
        UPDATE provider_turn_deliveries
        SET outcome_projected_at = COALESCE(outcome_projected_at, ${new Date().toISOString()})
        WHERE delivery_id = ${deliveryId} AND state IN ('accepted', 'rejected', 'ambiguous')
      `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTurnDelivery.markOutcomeProjected")));

  return {
    recordDispatchIntent,
    recordHandoff,
    listCandidateIds,
    listActionable,
    listSending,
    listUnprojectedTerminal,
    getByCommandId,
    getLatestByThread,
    getUnresolvedByThread,
    listAcceptedTurnIdsByThread,
    getSupersedingPreSendTurnIds,
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
