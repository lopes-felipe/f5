import { SnapshotReadClients, makeLeasedSqlClient } from "../snapshotReadExecutor.ts";
import { Effect, Layer, FileSystem, Path, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import { ReadSqlClient } from "../ReadSqlClient.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly disableWAL?: boolean;
  readonly checkpointWorker?: boolean;
  readonly readonly?: boolean;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

export const makeRuntimeSqliteLayer = (
  config: RuntimeSqliteLayerConfig,
): Layer.Layer<SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = defaultSqliteClientLoaders[runtime];
    const clientModule = yield* Effect.promise<Loader>(loader);
    // Bun otherwise enables WAL while opening the connection, before our busy timeout.
    const native = clientModule.layer({
      ...config,
      disableWAL: true,
      checkpointWorker: runtime === "node" && !config.readonly,
    });
    return Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        // This pragma is connection-local: Bun readers need it too, before any
        // snapshot or crash-recovery read can contend with the writer.
        yield* client`PRAGMA busy_timeout = 5000`.pipe(Effect.orDie);
        return yield* makeLeasedSqlClient(client, config.readonly === true);
      }),
    ).pipe(Layer.provide(native));
  }).pipe(Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // Takes effect only before the first table exists, so new databases start
    // incremental; an existing one switches at its next VACUUM (see
    // storage/databaseSpace.ts).
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_size_limit = 33554432;`;
    yield* runMigrations;
    yield* sql`PRAGMA optimize = 0x10012;`;
  }),
);

export const makeSqlitePersistenceLive = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    const writer = Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: dbPath }));
    const readers = Layer.effect(
      SnapshotReadClients,
      Effect.gen(function* () {
        // Building these graphs after the writer setup guarantees migrations
        // finish before either query-only connection can observe the file.
        yield* SqlClient.SqlClient;
        const openReader = Effect.gen(function* () {
          const services = yield* Layer.build(
            makeRuntimeSqliteLayer({ filename: dbPath, readonly: true }),
          );
          const client = ServiceMap.get(services, SqlClient.SqlClient);
          yield* client`PRAGMA query_only = ON`;
          return client;
        });
        return { foreground: yield* openReader, background: yield* openReader };
      }),
    );
    // Thread find scans long histories on its own connection, so it never holds the
    // snapshot readers' leases. Building it after the writer orders it after setup too.
    const searchReader = Layer.effect(
      ReadSqlClient,
      Effect.service(SqlClient.SqlClient).pipe(
        Effect.tap((sql) => sql`PRAGMA query_only = ON`.pipe(Effect.orDie, Effect.asVoid)),
      ),
    ).pipe(Layer.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })));
    return readers.pipe(Layer.provideMerge(Layer.provideMerge(searchReader, writer)));
  }).pipe(Layer.unwrap);

const memoryWriter = Layer.provideMerge(setup, makeRuntimeSqliteLayer({ filename: ":memory:" }));
export const SqlitePersistenceMemory = Layer.effect(
  SnapshotReadClients,
  Effect.map(SqlClient.SqlClient.asEffect(), (client) => ({
    foreground: client,
    background: client,
  })),
).pipe(Layer.provideMerge(memoryWriter));

export const layerConfig = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig;
  return makeSqlitePersistenceLive(dbPath);
}).pipe(Layer.unwrap);
