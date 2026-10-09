import type {
  NativeOperationInput,
  NativeOperationRecord,
  NativeOperationState,
  ThreadId,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Semaphore } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withProviderThreadAccess } from "./providerThreadAccess.ts";

const reservations = new Set<string>();
export const hasNativeOperationReservation = (threadId: string): boolean =>
  reservations.has(threadId);
const active = (state: NativeOperationState) =>
  ["requested", "dispatched", "running", "indeterminate"].includes(state);
export class NativeOperationError extends Error {
  override readonly name = "NativeOperationError";
}
export interface NativeOperationRepository {
  readonly get: (
    id: string,
  ) => Effect.Effect<NativeOperationRecord | undefined, NativeOperationError>;
  readonly list: (
    threadId?: ThreadId,
  ) => Effect.Effect<readonly NativeOperationRecord[], NativeOperationError>;
  readonly save: (record: NativeOperationRecord) => Effect.Effect<void, NativeOperationError>;
}
export function nativeOperationSqlRepository(sql: SqlClient.SqlClient): NativeOperationRepository {
  const decode = (rows: readonly { record_json: string }[]) =>
    rows.map((row) => JSON.parse(row.record_json) as NativeOperationRecord);
  const error = (cause: unknown) =>
    new NativeOperationError(`Could not persist native operation: ${String(cause)}`);
  return {
    get: (id) =>
      sql<{
        record_json: string;
      }>`SELECT record_json FROM native_operations WHERE operation_id = ${id}`.pipe(
        Effect.map((rows) => decode(rows)[0]),
        Effect.mapError(error),
      ),
    list: (threadId) =>
      (threadId
        ? sql<{
            record_json: string;
          }>`SELECT record_json FROM native_operations WHERE thread_id = ${threadId} ORDER BY created_at DESC LIMIT 100`
        : sql<{
            record_json: string;
          }>`SELECT record_json FROM native_operations WHERE state IN ('requested', 'dispatched', 'running', 'indeterminate') ORDER BY created_at`
      ).pipe(Effect.map(decode), Effect.mapError(error)),
    save: (record) =>
      sql`INSERT INTO native_operations(operation_id, thread_id, generation, state, record_json, created_at, updated_at)
      VALUES (${record.operationId}, ${record.threadId}, ${record.generation}, ${record.state}, ${JSON.stringify(record)}, ${record.createdAt}, ${record.updatedAt})
      ON CONFLICT(operation_id) DO UPDATE SET state = excluded.state, record_json = excluded.record_json, updated_at = excluded.updated_at`.pipe(
        Effect.asVoid,
        Effect.mapError(error),
      ),
  };
}

/** All mutations pass admission under the same lock used by turn dispatch.
 * The durable reservation remains while awaiting the provider, so approvals,
 * questions and Stop can still use the dispatch lock and settle the operation.
 */
export function makeNativeOperationCoordinator(repository: NativeOperationRepository) {
  const executing = new Set<string>();
  const persist = (record: NativeOperationRecord) =>
    repository.save(record).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (active(record.state)) reservations.add(record.threadId);
          else reservations.delete(record.threadId);
        }),
      ),
    );
  const execute = <E, R>(
    input: NativeOperationInput,
    callbacks: {
      readonly validate: Effect.Effect<void, E, R>;
      readonly onAdmitted?: (record: NativeOperationRecord) => Effect.Effect<void>;
      readonly prepare?: Effect.Effect<void, E, R>;
      readonly generation: Effect.Effect<number, E, R>;
      readonly dispatch: Effect.Effect<unknown, E, R>;
      readonly dispatchWithReceipt?: (
        receipt: (value: unknown) => Effect.Effect<void, NativeOperationError>,
      ) => Effect.Effect<unknown, E, R>;
      /** Apply only after rechecking generation, while the reservation is held. */
      readonly apply?: (result: unknown) => Effect.Effect<void, E, R>;
    },
  ) =>
    Effect.gen(function* () {
      const admission = yield* withProviderThreadAccess(
        input.threadId,
        Effect.gen(function* () {
          const existing = yield* repository.get(input.operationId);
          if (existing) {
            if (
              stableJson({
                threadId: existing.threadId,
                generation: existing.generation,
                command: existing.command,
              }) !==
              stableJson({
                threadId: input.threadId,
                generation: input.generation,
                command: input.command,
              })
            )
              return yield* Effect.fail(
                new NativeOperationError(
                  "This operation identifier belongs to a different request.",
                ),
              );
            return { record: existing, dispatch: false };
          }
          if (hasNativeOperationReservation(input.threadId))
            return yield* Effect.fail(
              new NativeOperationError(
                "A native operation is still pending. Reconcile it before starting another.",
              ),
            );
          yield* callbacks.validate;
          if ((yield* callbacks.generation) !== input.generation)
            return yield* Effect.fail(
              new NativeOperationError("The provider session restarted. Reload and try again."),
            );
          const now = new Date().toISOString();
          const record: NativeOperationRecord = {
            ...input,
            state: "requested",
            ...(callbacks.apply ? { applicationRequired: true } : {}),
            createdAt: now,
            updatedAt: now,
          };
          yield* persist(record);
          executing.add(record.operationId);
          return { record, dispatch: true };
        }),
      );
      if (callbacks.onAdmitted) yield* callbacks.onAdmitted(admission.record);
      if (!admission.dispatch) return admission.record;
      let record = admission.record;
      const receiptLock = yield* Semaphore.make(1);
      const bounded = (value: unknown) => {
        if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > 64 * 1024)
          throw new NativeOperationError("Native operation metadata exceeds 64 KiB.");
        return value;
      };
      const transition = (
        state: NativeOperationState,
        extra: Partial<NativeOperationRecord> = {},
      ) => {
        record = { ...record, ...extra, state, updatedAt: new Date().toISOString() };
        return persist(record);
      };
      let dispatched = false;
      const work = Effect.gen(function* () {
        if (callbacks.prepare) yield* callbacks.prepare;
        yield* transition("dispatched");
        dispatched = true;
        yield* transition("running");
        const result = yield* callbacks.dispatchWithReceipt
          ? callbacks.dispatchWithReceipt((receipt) =>
              receiptLock.withPermit(
                Effect.suspend(() =>
                  transition("running", {
                    receipt: bounded(
                      receipt && typeof receipt === "object" && !Array.isArray(receipt)
                        ? {
                            ...(record.receipt && typeof record.receipt === "object"
                              ? record.receipt
                              : {}),
                            ...receipt,
                          }
                        : receipt,
                    ),
                  }),
                ),
              ),
            )
          : callbacks.dispatch;
        yield* Effect.sync(() => bounded(result));
        yield* transition("running", { result });
        if (
          result &&
          typeof result === "object" &&
          "canRewind" in result &&
          (result.canRewind === false ||
            ("error" in result && typeof result.error === "string" && result.error.length > 0))
        ) {
          yield* transition("failed", {
            result,
            error: "Native file rewind was refused; the conversation was left untouched.",
          });
          return;
        }
        yield* withProviderThreadAccess(
          input.threadId,
          Effect.gen(function* () {
            const generation = yield* callbacks.generation;
            if (generation !== input.generation) {
              yield* transition("completed", { result, staleGeneration: true });
              return;
            }
            if (callbacks.apply) {
              yield* callbacks.apply(result);
              yield* transition("running", { applicationApplied: true });
            }
            yield* transition("completed", { result });
          }),
        );
      });
      yield* work.pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          // A lost response, timeout or shutdown never implies the provider did nothing.
          const error = Cause.squash(exit.cause);
          const notSent =
            record.result === undefined &&
            error !== null &&
            typeof error === "object" &&
            (("deliveryCertainty" in error && error.deliveryCertainty === "not_sent") ||
              ("_tag" in error &&
                [
                  "ProviderAdapterSessionNotFoundError",
                  "ProviderAdapterSessionClosedError",
                  "ProviderAdapterValidationError",
                ].includes(String(error._tag))));
          return transition(dispatched && !notSent ? "indeterminate" : "failed", {
            error: Cause.hasInterruptsOnly(exit.cause)
              ? "Server shutdown cancelled the waiter; provider outcome requires reconciliation."
              : String(Cause.squash(exit.cause)).slice(0, 400),
          });
        }),
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(Effect.sync(() => executing.delete(input.operationId))),
      );
      return record;
    });
  type Outcome = {
    state: "completed" | "failed" | "cancelled" | "indeterminate";
    result?: unknown;
    staleGeneration?: boolean;
  };
  const settleRecord = <E, R>(
    record: NativeOperationRecord,
    check: (record: NativeOperationRecord) => Effect.Effect<Outcome, E, R>,
  ) =>
    withProviderThreadAccess(
      record.threadId,
      Effect.gen(function* () {
        const current = yield* repository.get(record.operationId);
        if (!current || !active(current.state) || executing.has(current.operationId)) return;
        const outcome =
          current.state === "requested"
            ? { state: "cancelled" as const }
            : yield* check(current).pipe(
                Effect.timeout("10 seconds"),
                Effect.catchCause(() => Effect.succeed({ state: "indeterminate" as const })),
              );
        yield* persist({
          ...current,
          ...outcome,
          ...(outcome.state === "completed" &&
          current.applicationRequired &&
          !current.applicationApplied &&
          !current.staleGeneration &&
          !("staleGeneration" in outcome && outcome.staleGeneration)
            ? {
                state: "indeterminate" as const,
                error:
                  "The provider settled, but F5 application is unconfirmed. Reconcile or acknowledge the outcome; the provider mutation will not be repeated.",
              }
            : {}),
          updatedAt: new Date().toISOString(),
        });
      }),
    );
  const restoreReservations = repository.list().pipe(
    Effect.tap((records) =>
      Effect.sync(() => {
        for (const record of records) if (active(record.state)) reservations.add(record.threadId);
      }),
    ),
    Effect.asVoid,
  );
  const reconcile = <E, R>(
    check: (record: NativeOperationRecord) => Effect.Effect<Outcome, E, R>,
  ) =>
    Effect.gen(function* () {
      for (const record of yield* repository.list()) yield* settleRecord(record, check);
    });
  const reconcileThread = <E, R>(
    threadId: ThreadId,
    check: (record: NativeOperationRecord) => Effect.Effect<Outcome, E, R>,
  ) =>
    Effect.gen(function* () {
      for (const record of yield* repository.list(threadId)) yield* settleRecord(record, check);
    });
  const abandon = (threadId: ThreadId, operationId: string) =>
    withProviderThreadAccess(
      threadId,
      Effect.gen(function* () {
        const record = yield* repository.get(operationId);
        if (!record || record.threadId !== threadId)
          return yield* Effect.fail(
            new NativeOperationError("This operation does not belong to the conversation."),
          );
        if (executing.has(operationId))
          return yield* Effect.fail(
            new NativeOperationError(
              "The operation waiter is still settling. Retry after it settles.",
            ),
          );
        if (record.state !== "indeterminate")
          return yield* Effect.fail(
            new NativeOperationError("Only an indeterminate outcome can be acknowledged."),
          );
        const resolved = {
          ...record,
          state: "cancelled" as const,
          error:
            "User acknowledged the uncertain outcome after stopping the provider. Files or forks may already have changed; no mutation was retried.",
          updatedAt: new Date().toISOString(),
        };
        yield* persist(resolved);
        return resolved;
      }),
    );
  return {
    execute,
    reconcile,
    reconcileThread,
    restoreReservations,
    abandon,
    list: repository.list,
  };
}

/** Canonical JSON prevents object key order from changing operation identity. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );
}
