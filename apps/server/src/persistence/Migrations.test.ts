import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { LATEST_MIGRATION_ID, MIGRATIONS, runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";

describe("MIGRATIONS", () => {
  // The migrator only runs IDs above the highest one a database has applied,
  // so a gap is permanent: a migration that later fills it never runs on any
  // database that already has the higher one.
  it("numbers migrations 1..latest without gaps or duplicates", () => {
    const ids = Object.keys(MIGRATIONS)
      .map((key) => Number.parseInt(key, 10))
      .toSorted((left, right) => left - right);
    expect(ids).toEqual(Array.from({ length: LATEST_MIGRATION_ID }, (_, index) => index + 1));
  });
});

effectIt.layer(SqliteClient.layerMemory())("migration upgrades", (it) => {
  it.effect("adds session capabilities after database compaction has already run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const previousMigrations = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([key]) => Number.parseInt(key, 10) <= 107),
      );
      yield* Migrator.make({})({ loader: Migrator.fromRecord(previousMigrations) });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(before.some((column) => column.name === "capabilities_json")).toBe(false);
      const compaction = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 107
      `;
      expect(compaction).toEqual([{ name: "DatabaseCompaction" }]);

      yield* runMigrations;
      yield* runMigrations;

      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_thread_sessions')
      `;
      expect(after.filter((column) => column.name === "capabilities_json")).toHaveLength(1);
      const capabilities = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 108
      `;
      expect(capabilities).toEqual([{ name: "ProjectionThreadSessionCapabilities" }]);
    }),
  );
});
