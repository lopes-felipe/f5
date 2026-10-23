import { Duration, Effect, Metric, Schema, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import { snapshotReadDuration, snapshotReadOverruns } from "../observability/Metrics.ts";
import { PersistenceSqlError } from "./Errors.ts";

export class SnapshotReadClients extends ServiceMap.Service<
  SnapshotReadClients,
  {
    readonly foreground: SqlClient.SqlClient;
    readonly background: SqlClient.SqlClient;
  }
>()("t3/persistence/snapshotReadExecutor/SnapshotReadClients") {}

export const SnapshotReadDeadline = ServiceMap.Reference<number>(
  "f5/persistence/SnapshotReadDeadline",
  {
    defaultValue: () => Infinity,
  },
);

export class SnapshotReadExpired extends Error {
  readonly retryable = true;
  constructor() {
    super("Snapshot read exceeded its cooperative deadline; retry the read.");
  }
}
const checkDeadline = Effect.flatMap(SnapshotReadDeadline.asEffect(), (deadline) =>
  performance.now() >= deadline
    ? Effect.fail(
        new SqlError({
          cause: new SnapshotReadExpired(),
          message: "Snapshot read deadline exceeded",
        }),
      )
    : Effect.void,
);

/** Connections own their lease until statement/transaction scope closure. */
export const makeLeasedSqlClient = (client: SqlClient.SqlClient, cooperative = false) => {
  const guard = <A, E>(sql: string, effect: Effect.Effect<A, E>) =>
    !cooperative || /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql.trim())
      ? effect
      : checkDeadline.pipe(
          Effect.andThen(effect),
          Effect.tap(() => Effect.yieldNow),
        );
  const acquire = client.reserve.pipe(
    Effect.map(
      (connection): Connection => ({
        execute: (sql, params, transform) => guard(sql, connection.execute(sql, params, transform)),
        executeRaw: (sql, params) => guard(sql, connection.executeRaw(sql, params)),
        executeValues: (sql, params) => guard(sql, connection.executeValues(sql, params)),
        executeUnprepared: (sql, params, transform) =>
          guard(sql, connection.executeUnprepared(sql, params, transform)),
        executeStream: connection.executeStream,
      }),
    ),
  );
  return SqlClient.make({
    acquirer: acquire,
    transactionAcquirer: acquire,
    compiler: Statement.makeCompilerSqlite(),
    // Writers take the write lock up front so a transaction never fails upgrading
    // from a read lock; query-only readers share snapshots.
    beginTransaction: cooperative ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE",
    spanAttributes: [["db.system.name", "sqlite"]],
  }).pipe(Effect.provide(Reactivity.layer));
};

export const withSnapshotRead = <A, E, R>(
  client: SqlClient.SqlClient,
  lane: "foreground" | "background",
  effect: Effect.Effect<A, E, R>,
  isolateTransaction = true,
  budgetMs = 2_000,
) =>
  Effect.suspend(() => {
    const started = performance.now();
    return client.withTransaction(effect).pipe(
      Effect.provideService(SnapshotReadDeadline, started + budgetMs),
      Effect.updateServices((services: ServiceMap.ServiceMap<R>) =>
        isolateTransaction
          ? (ServiceMap.omit(SqlClient.TransactionConnection)(services) as ServiceMap.ServiceMap<R>)
          : services,
      ),
      Effect.mapError((error) =>
        Schema.is(SqlError)(error) && error.cause instanceof SnapshotReadExpired
          ? new PersistenceSqlError({
              operation: "SnapshotReadExecutor",
              detail: error.cause.message,
              retryable: true,
            })
          : error,
      ),
      Effect.onExit(() => {
        const duration = performance.now() - started;
        const record = Metric.update(
          Metric.withAttributes(snapshotReadDuration, { lane }),
          Duration.millis(duration),
        );
        return duration >= budgetMs
          ? record.pipe(
              Effect.andThen(
                Metric.update(Metric.withAttributes(snapshotReadOverruns, { lane }), 1),
              ),
              Effect.andThen(
                Effect.logWarning("snapshot read deadline exceeded", {
                  lane,
                  durationMs: duration,
                }),
              ),
            )
          : record;
      }),
    );
  });
