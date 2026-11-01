import { ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ParkedNativeSession,
  PendingProviderHandoff,
  ProviderHandoffStateRepository,
  type ParkedNativeSessions,
  type ProviderHandoffState,
  type ProviderHandoffStateRepositoryShape,
} from "../Services/ProviderHandoffState.ts";

interface Row {
  readonly threadId: string;
  readonly pendingJson: string | null;
  readonly parkedJson: string;
  readonly revision: number;
  readonly updatedAt: string;
}

const decodePending = Schema.decodeUnknownOption(PendingProviderHandoff);
const decodeParked = Schema.decodeUnknownOption(ParkedNativeSession);

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Invalid entries are dropped, never thrown: a lost marker degrades to a fresh session. */
export function decodeProviderHandoffStateRow(row: Row): ProviderHandoffState {
  const pendingRaw = parseJson(row.pendingJson);
  const parkedRaw = parseJson(row.parkedJson);
  const parked: Record<string, ParkedNativeSession> = {};
  if (parkedRaw && typeof parkedRaw === "object" && !Array.isArray(parkedRaw)) {
    for (const [instanceId, entry] of Object.entries(parkedRaw)) {
      const decoded = decodeParked(entry);
      if (Option.isSome(decoded) && decoded.value.providerInstanceId === instanceId)
        parked[instanceId] = decoded.value;
    }
  }
  return {
    threadId: ThreadId.makeUnsafe(row.threadId),
    pending: pendingRaw === null ? null : Option.getOrNull(decodePending(pendingRaw)),
    parked,
    revision: Number(row.revision),
    updatedAt: row.updatedAt,
  };
}

function mapError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: ProviderHandoffStateRepositoryShape["get"] = (threadId) =>
    sql<Row>`SELECT thread_id AS "threadId", pending_json AS "pendingJson",
        parked_json AS "parkedJson", revision, updated_at AS "updatedAt"
      FROM provider_handoff_state WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => (rows[0] ? decodeProviderHandoffStateRow(rows[0]) : null)),
      Effect.mapError(mapError("ProviderHandoffState.get")),
    );

  const compareAndSet: ProviderHandoffStateRepositoryShape["compareAndSet"] = (input) => {
    const now = new Date().toISOString();
    const pendingJson = input.pending === null ? null : JSON.stringify(input.pending);
    const parkedJson = JSON.stringify(input.parked satisfies ParkedNativeSessions);
    const write =
      input.expectedRevision === null
        ? sql<Row>`INSERT INTO provider_handoff_state (thread_id, pending_json, parked_json, revision, updated_at)
            VALUES (${input.threadId}, ${pendingJson}, ${parkedJson}, 1, ${now})
            ON CONFLICT(thread_id) DO NOTHING
            RETURNING thread_id AS "threadId", pending_json AS "pendingJson",
              parked_json AS "parkedJson", revision, updated_at AS "updatedAt"`
        : sql<Row>`UPDATE provider_handoff_state
            SET pending_json = ${pendingJson}, parked_json = ${parkedJson},
                revision = revision + 1, updated_at = ${now}
            WHERE thread_id = ${input.threadId} AND revision = ${input.expectedRevision}
            RETURNING thread_id AS "threadId", pending_json AS "pendingJson",
              parked_json AS "parkedJson", revision, updated_at AS "updatedAt"`;
    return write.pipe(
      Effect.map((rows) => (rows[0] ? decodeProviderHandoffStateRow(rows[0]) : null)),
      Effect.mapError(mapError("ProviderHandoffState.compareAndSet")),
    );
  };

  const deleteByThreadId: ProviderHandoffStateRepositoryShape["deleteByThreadId"] = (threadId) =>
    sql`DELETE FROM provider_handoff_state WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(mapError("ProviderHandoffState.deleteByThreadId")),
    );

  const listAll: ProviderHandoffStateRepositoryShape["listAll"] = sql<Row>`
    SELECT thread_id AS "threadId", pending_json AS "pendingJson",
      parked_json AS "parkedJson", revision, updated_at AS "updatedAt"
    FROM provider_handoff_state`.pipe(
    Effect.map((rows) => rows.map(decodeProviderHandoffStateRow)),
    Effect.mapError(mapError("ProviderHandoffState.listAll")),
  );

  return {
    get,
    compareAndSet,
    deleteByThreadId,
    listAll,
  } satisfies ProviderHandoffStateRepositoryShape;
});

export const ProviderHandoffStateRepositoryLive = Layer.effect(
  ProviderHandoffStateRepository,
  make,
);
