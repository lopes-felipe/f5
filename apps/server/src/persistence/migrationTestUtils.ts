import { Data, Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

class FixtureSchemaCycle extends Data.TaggedError("FixtureSchemaCycle") {}
/** Test-only teardown: drop children before parents with foreign-key checks still enabled. */
export const resetMigrationFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
  const remaining = new Map<string, Set<string>>();
  for (const { name } of tables) {
    const keys = yield* sql<{
      table: string;
    }>`SELECT "table" FROM pragma_foreign_key_list(${name})`;
    remaining.set(name, new Set(keys.map((key) => key.table).filter((parent) => parent !== name)));
  }
  while (remaining.size) {
    const children = [...remaining.keys()].filter(
      (name) => ![...remaining.values()].some((parents) => parents.has(name)),
    );
    if (!children.length) return yield* new FixtureSchemaCycle();
    for (const name of children) {
      yield* sql`DROP TABLE IF EXISTS ${sql(name)}`;
      remaining.delete(name);
    }
  }
});
