import { Effect, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Reuse the client's connection semaphore and nested-transaction service. */
const transaction = (sql: SqlClient.SqlClient, begin: "BEGIN" | "BEGIN IMMEDIATE") =>
  SqlClient.makeWithTransaction({
    transactionService: SqlClient.TransactionConnection,
    spanAttributes: [["db.system.name", "sqlite"]],
    acquireConnection: Effect.flatMap(Scope.make(), (scope) =>
      Effect.map(Scope.provide(sql.reserve, scope), (connection) => [scope, connection] as const),
    ),
    begin: (connection) => connection.executeUnprepared(begin, [], undefined),
    savepoint: (connection, id) =>
      connection.executeUnprepared(`SAVEPOINT effect_sql_${id}`, [], undefined),
    commit: (connection) => connection.executeUnprepared("COMMIT", [], undefined),
    rollback: (connection) => connection.executeUnprepared("ROLLBACK", [], undefined),
    rollbackSavepoint: (connection, id) =>
      connection.executeUnprepared(`ROLLBACK TO SAVEPOINT effect_sql_${id}`, [], undefined),
  });

/** Consistent multi-query reads share one snapshot without reserving the write lock. */
export const withReadTransaction = (sql: SqlClient.SqlClient) => transaction(sql, "BEGIN");
