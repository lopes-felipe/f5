import { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderTerminalEventReceipt,
  ProviderTerminalEventRepository,
  type ProviderTerminalEventRepositoryShape,
} from "../Services/ProviderTerminalEvents.ts";

const DbRow = ProviderTerminalEventReceipt.mapFields(
  Struct.assign({
    event: Schema.fromJsonString(ProviderRuntimeEvent),
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

  const record: ProviderTerminalEventRepositoryShape["record"] = (event) =>
    Effect.gen(function* () {
      const eventJson = yield* Schema.encodeEffect(Schema.fromJsonString(ProviderRuntimeEvent))(
        event,
      );
      yield* sql`
        INSERT OR IGNORE INTO provider_terminal_events (
          event_id,
          thread_id,
          turn_id,
          event_type,
          event_json,
          received_at,
          applied_at,
          attempt,
          last_error
        ) VALUES (
          ${event.eventId},
          ${event.threadId},
          ${event.turnId ?? null},
          ${event.type},
          ${eventJson},
          ${new Date().toISOString()},
          NULL,
          0,
          NULL
        )
      `;
    }).pipe(Effect.mapError(mapError("ProviderTerminalEventRepository.record")));

  const listPending: ProviderTerminalEventRepositoryShape["listPending"] = sql<
    Record<string, unknown>
  >`
    SELECT
      event_id AS "eventId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      event_type AS "eventType",
      event_json AS "event",
      received_at AS "receivedAt",
      applied_at AS "appliedAt",
      attempt,
      last_error AS "lastError"
    FROM provider_terminal_events
    WHERE applied_at IS NULL
    ORDER BY received_at ASC, event_id ASC
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(DbRow))),
    Effect.mapError(mapError("ProviderTerminalEventRepository.listPending")),
  );

  const markApplied: ProviderTerminalEventRepositoryShape["markApplied"] = (eventId) =>
    sql`
      UPDATE provider_terminal_events
      SET applied_at = COALESCE(applied_at, ${new Date().toISOString()}),
          last_error = NULL
      WHERE event_id = ${eventId}
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTerminalEventRepository.markApplied")));

  const markFailed: ProviderTerminalEventRepositoryShape["markFailed"] = (input) =>
    sql`
      UPDATE provider_terminal_events
      SET attempt = attempt + 1,
          last_error = ${input.error}
      WHERE event_id = ${input.eventId}
        AND applied_at IS NULL
    `.pipe(Effect.asVoid, Effect.mapError(mapError("ProviderTerminalEventRepository.markFailed")));

  return {
    record,
    listPending,
    markApplied,
    markFailed,
  } satisfies ProviderTerminalEventRepositoryShape;
});

export const ProviderTerminalEventRepositoryLive = Layer.effect(
  ProviderTerminalEventRepository,
  make,
);
