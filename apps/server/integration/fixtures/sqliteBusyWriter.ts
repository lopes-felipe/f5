import { createInterface } from "node:readline/promises";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Database path required");
const persistenceLayer = process.versions.bun
  ? (await import("../../src/persistence/Layers/Sqlite.ts")).makeSqlitePersistenceLive(dbPath)
  : (await import("../../src/persistence/NodeSqliteClient.ts")).layer({ filename: dbPath });
const runtime = ManagedRuntime.make(persistenceLayer.pipe(Layer.provide(NodeServices.layer)));
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`;
      if (rows[0]?.timeout !== 5000) throw new Error("Busy timeout missing");
      yield* sql`CREATE TABLE contention_test (value TEXT)`;
    }),
  );
  await input.question("ready\n");
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      process.stdout.write("writing\n");
      const startedAt = performance.now();
      yield* sql`INSERT INTO contention_test VALUES ('child')`;
      process.stdout.write(`written:${performance.now() - startedAt}\n`);
    }),
  );
} finally {
  input.close();
  await runtime.dispose();
}
