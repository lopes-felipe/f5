#!/usr/bin/env bun
/**
 * Regenerates `apps/server/src/persistence/BaselineSchema.ts` by running all
 * incremental SQLite migrations on an in-memory database and dumping the
 * resulting `sqlite_master` DDL statements and seeded singleton rows.
 *
 * Usage:
 *   bun apps/server/scripts/generate-sqlite-baseline.ts
 */
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";

import {
  BASELINE_SEED_STATEMENTS,
  EFFECT_SQL_MIGRATIONS_TABLE_SQL,
} from "../src/persistence/BaselineSchema.ts";
import { LATEST_MIGRATION_ID, runIncrementalMigrations } from "../src/persistence/Migrations.ts";
import * as SqliteClient from "../src/persistence/NodeSqliteClient.ts";

const runtime = ManagedRuntime.make(SqliteClient.layerMemory());
try {
  const { ddlStatements, migrationsTableSql } = await runtime.runPromise(
    Effect.gen(function* () {
      yield* runIncrementalMigrations;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly type: string;
        readonly name: string;
        readonly sql: string | null;
      }>`
        SELECT type, name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
        ORDER BY
          CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,
          name
      `;
      const migrationsRow = rows.find((row) => row.name === "effect_sql_migrations");
      const ddl = rows
        .filter((row) => row.name !== "effect_sql_migrations")
        .map((row) => row.sql!)
        .filter((statement) => statement.length > 0);
      return {
        ddlStatements: ddl,
        migrationsTableSql: migrationsRow?.sql ?? EFFECT_SQL_MIGRATIONS_TABLE_SQL,
      };
    }),
  );

  const outPath = Path.resolve(import.meta.dirname, "../src/persistence/BaselineSchema.ts");
  const contents = [
    "/**",
    " * BaselineSchema - Fast-path squashed schema bootstrap for fresh SQLite databases.",
    " *",
    ` * Applies the exact schema produced by migrations 1..${LATEST_MIGRATION_ID} in a single`,
    " * transaction when opening a brand-new database, while leaving existing databases",
    " * on the standard incremental migration path.",
    " *",
    " * Policy:",
    " * - Migrations `1..BASELINE_MIGRATION_ID` are frozen once released. Never edit",
    " *   them in place; append a new numbered migration instead.",
    " * - To move `BASELINE_MIGRATION_ID` forward (or regenerate after an Effect SQL",
    " *   `effect_sql_migrations` DDL change), run:",
    " *   `bun apps/server/scripts/generate-sqlite-baseline.ts`",
    " * - Parity with incremental migrations is strictly enforced by",
    " *   `Migrations.test.ts` against `sqlite_master`, `PRAGMA table_info`, indexes,",
    " *   foreign keys, triggers, and seeded singleton rows.",
    " *",
    " * @module BaselineSchema",
    " */",
    "",
    `export const BASELINE_MIGRATION_ID = ${LATEST_MIGRATION_ID} as const;`,
    "",
    `export const EFFECT_SQL_MIGRATIONS_TABLE_SQL = ${JSON.stringify(migrationsTableSql)};`,
    "",
    `export const BASELINE_DDL_STATEMENTS: ReadonlyArray<string> = ${JSON.stringify(ddlStatements, null, 2)};`,
    "",
    `export const BASELINE_SEED_STATEMENTS: ReadonlyArray<string> = ${JSON.stringify(BASELINE_SEED_STATEMENTS, null, 2)};`,
    "",
  ].join("\n");

  await FS.writeFile(outPath, contents, "utf8");
  console.log(
    `Wrote ${ddlStatements.length} DDL statements (baseline #${LATEST_MIGRATION_ID}) to ${outPath}`,
  );
} finally {
  await runtime.dispose();
}
