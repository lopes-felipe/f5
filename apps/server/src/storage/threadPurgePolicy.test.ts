import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { threadPurgePolicy, threadPurgeHandlers } from "./threadPurgePolicy.ts";

it.layer(SqlitePersistenceMemory)("thread purge schema coverage", (it) => {
  it.effect("classifies every migrated table with thread_id and verifies cascades", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      const unclassified: string[] = [];
      for (const table of tables) {
        const columns = yield* sql<{
          name: string;
        }>`SELECT name FROM pragma_table_info(${table.name})`;
        if (!columns.some((column) => column.name === "thread_id")) continue;
        const policy = threadPurgePolicy[table.name];
        if (!policy) {
          unclassified.push(table.name);
          continue;
        }
        if (policy.kind === "explicit")
          assert.isTrue(
            table.name in threadPurgeHandlers,
            `${table.name} needs an explicit SQL deletion handler`,
          );
        if (policy.kind === "retain") assert.isNotEmpty(policy.reason);
        if (policy.kind === "cascade") {
          const keys = yield* sql<{
            table: string;
            from: string;
            on_delete: string;
          }>`SELECT * FROM pragma_foreign_key_list(${table.name})`;
          assert.isTrue(
            keys.some(
              (key) =>
                key.table === "projection_threads" &&
                key.from === "thread_id" &&
                key.on_delete === "CASCADE",
            ),
            `${table.name} must cascade from projection_threads`,
          );
        }
      }
      assert.deepStrictEqual(unclassified, []);
    }),
  );

  it.effect("drops a purged thread's upstream port links and bumps the links version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO upstream_ledger_publication (project_id) VALUES ('p1'), ('p2')`;
      yield* sql`INSERT INTO upstream_port_links (project_id, topic_id, epoch, thread_id, client_request_id, group_index, state)
        VALUES ('p1', 'topic-a', 1, 'purged', 'r1', 0, 'active'), ('p2', 'topic-b', 1, 'kept', 'r2', 0, 'active')`;
      const deleted = yield* threadPurgeHandlers.upstream_port_links(
        sql,
        ThreadId.makeUnsafe("purged"),
      );
      assert.equal(deleted.length, 1);
      assert.deepStrictEqual(yield* sql`SELECT thread_id FROM upstream_port_links`, [
        { thread_id: "kept" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT project_id, links_version FROM upstream_ledger_publication ORDER BY project_id`,
        [
          { project_id: "p1", links_version: 1 },
          { project_id: "p2", links_version: 0 },
        ],
      );
    }),
  );
});
