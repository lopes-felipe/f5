/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import {
  PerformanceStageProbe,
  sqlConnectionWaitDuration,
  sqlExecutionDuration,
} from "../observability/Metrics.ts";

import { startCheckpointWorker } from "./sqliteCheckpointWorker.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

const recordDuration = (
  metric: Metric.Metric<Duration.Duration, unknown>,
  startedAt: number,
): Effect.Effect<void> => Metric.update(metric, Duration.millis(performance.now() - startedAt));

const recordExecution = (
  startedAt: number,
  outcome: "success" | "failure",
  sourceSQL: string,
  probe?: ((stage: string, durationMs: number) => void) | null,
) => {
  const durationMs = performance.now() - startedAt;
  probe?.("sqlite.execution", durationMs);
  const metric = Metric.update(
    Metric.withAttributes(sqlExecutionDuration, { outcome }),
    Duration.millis(durationMs),
  );
  // SQL shape only: expandedSQL and bound parameters can contain private content.
  return durationMs > 100
    ? Effect.andThen(
        metric,
        Effect.logWarning("slow sql statement", { durationMs, sql: sourceSQL.slice(0, 160) }),
      )
    : metric;
};

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = ServiceMap.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly checkpointWorker?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 * A cached statement would hold its last payload for as long as it stays
 * cached, so executions binding more than this many string code units and
 * blob bytes, or a named parameter behind a getter, get a throwaway statement
 * instead.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !ArrayBuffer.isView(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    // A parameter that cannot be measured is left for the statement to report.
    return true;
  }
};

const makeWithDatabase = (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    yield* checkNodeSqliteCompat();
    const probe = yield* PerformanceStageProbe;

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined;

    const makeConnection = Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const db = openDatabase();
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => db.close()),
      );

      db.exec("PRAGMA busy_timeout = 5000; PRAGMA checkpoint_fullfsync = ON;");
      const checkpoint =
        options.checkpointWorker &&
        !options.readonly &&
        options.filename !== ":memory:" &&
        options.filename !== ""
          ? yield* startCheckpointWorker(options.filename, db)
          : undefined;

      const statementReaderCache = new WeakMap<StatementSync, boolean>();
      const hasRows = (statement: StatementSync): boolean => {
        const cached = statementReaderCache.get(statement);
        if (cached !== undefined) {
          return cached;
        }
        const value = statement.columns().length > 0;
        statementReaderCache.set(statement, value);
        return value;
      };

      const sqlError = (cause: unknown, message: string) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "errcode" in cause &&
          typeof cause.errcode === "number" &&
          !("errno" in cause)
        ) {
          Object.assign(cause, { errno: cause.errcode });
        }
        return new SqlError({ cause, message });
      };
      const prepare = (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) => sqlError(cause, "Failed to prepare statement"),
        });
      const prepareCache = yield* Cache.makeWith({
        capacity: options.prepareCacheSize ?? 200,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
        lookup: prepare,
      });
      const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
        hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

      const runStatement = (
        statement: StatementSync,
        params: ReadonlyArray<unknown>,
        raw: boolean,
      ) =>
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          statement.setReadBigInts(Boolean(ServiceMap.get(fiber.services, Client.SafeIntegers)));
          const startedAt = performance.now();
          const executed = (result: ReadonlyArray<any>) =>
            Effect.as(recordExecution(startedAt, "success", statement.sourceSQL, probe), result);
          try {
            if (hasRows(statement)) {
              return executed(statement.all(...(params as any)));
            }
            if (raw) {
              const result = statement.run(...(params as any));
              return executed(result as unknown as ReadonlyArray<any>);
            }
            // Some zero-column pragmas yield intermediate SQLITE_ROW steps.
            // run() stops at the first one (incremental_vacuum frees one page),
            // whereas all() drains to SQLITE_DONE. Keep the public no-row result.
            statement.all(...(params as any));
            return executed([]);
          } catch (cause) {
            // Failures are timed too: a busy-timeout stall ends in SQLITE_BUSY.
            return Effect.andThen(
              recordExecution(startedAt, "failure", statement.sourceSQL, probe),
              Effect.fail(sqlError(cause, "Failed to execute statement")),
            );
          }
        });

      const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
        Effect.flatMap(statementFor(sql, params), (s) => runStatement(s, params, raw)).pipe(
          Effect.ensuring(Effect.sync(() => checkpoint?.())),
        );

      const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
        Effect.acquireUseRelease(
          statementFor(sql, params),
          (statement) =>
            Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
              // A cached statement otherwise keeps whatever the last caller asked for.
              statement.setReadBigInts(
                Boolean(ServiceMap.get(fiber.services, Client.SafeIntegers)),
              );
              const startedAt = performance.now();
              return Effect.try({
                try: () => {
                  if (hasRows(statement)) {
                    statement.setReturnArrays(true);
                    // Safe to cast to array after we've setReturnArrays(true)
                    return statement.all(...(params as any)) as unknown as ReadonlyArray<
                      ReadonlyArray<unknown>
                    >;
                  }
                  statement.all(...(params as any));
                  return [];
                },
                catch: (cause) => sqlError(cause, "Failed to execute statement"),
              }).pipe(
                Effect.onExit((exit) =>
                  recordExecution(
                    startedAt,
                    Exit.isSuccess(exit) ? "success" : "failure",
                    sql,
                    probe,
                  ),
                ),
              );
            }),
          (statement) =>
            Effect.sync(() => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            }),
        ).pipe(Effect.ensuring(Effect.sync(() => checkpoint?.())));

      return identity<Connection>({
        execute(sql, params, rowTransform) {
          return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
        },
        executeRaw(sql, params) {
          return run(sql, params, true);
        },
        executeValues(sql, params) {
          return runValues(sql, params);
        },
        executeUnprepared(sql, params, rowTransform) {
          const effect = Effect.flatMap(prepare(sql), (statement) =>
            runStatement(statement, params ?? [], false),
          ).pipe(Effect.ensuring(Effect.sync(() => checkpoint?.())));
          return rowTransform ? Effect.map(effect, rowTransform) : effect;
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented");
        },
      });
    });

    const semaphore = yield* Semaphore.make(1);
    const connection = yield* makeConnection;

    // A standalone statement can yield while preparing or transforming a result.
    // Reserve through its scope just like transactions, so neither can enter the other.
    const acquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = ServiceMap.getUnsafe(fiber.services, Scope.Scope);
      const startedAt = performance.now();
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () =>
          Scope.addFinalizer(scope, semaphore.release(1)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const elapsed = performance.now() - startedAt;
                probe?.("sqlite.admission", elapsed);
                return Metric.update(sqlConnectionWaitDuration, Duration.millis(elapsed)).pipe(
                  Effect.andThen(Effect.annotateCurrentSpan("db.connection.wait_ms", elapsed)),
                );
              }),
            ),
          ),
        ),
        connection,
      );
    });

    return yield* Client.make({
      acquirer,
      compiler,
      transactionAcquirer: acquirer,
      beginTransaction: options.readonly ? "BEGIN" : "BEGIN IMMEDIATE",
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ["db.connection.role", options.readonly ? "reader" : "writer"],
      ],
      transformRows,
    });
  });

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectServices(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(makeMemory(config), (client) =>
      ServiceMap.make(SqliteClient, client).pipe(ServiceMap.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
