import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AUTO_VACUUM_INCREMENTAL,
  incrementalVacuum,
  readDatabasePages,
  vacuumToIncremental,
} from "./databaseSpace.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "f5-database-space-"));
const filename = NodePath.join(directory, "state.sqlite");

const fill = (sql: SqlClient.SqlClient, rows: number) => sql`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
  INSERT INTO filler SELECT printf('%.4000c', 'x') FROM n
`;

it.layer(SqliteClient.layer({ filename }))("databaseSpace", (it) => {
  it.effect("switches an existing WAL database to incremental and then shrinks it in steps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      // Created without the pragma, like databases from before it existed.
      yield* sql`CREATE TABLE filler (value TEXT)`;
      yield* fill(sql, 3_000);
      yield* sql`DELETE FROM filler`;
      const before = yield* readDatabasePages;
      assert.equal(before.autoVacuum, 0);
      assert.isAbove(before.freelistCount, 2_000);
      // Not incremental yet: nothing to do in steps.
      assert.equal(yield* incrementalVacuum({ maxDurationMs: 5_000 }), 0);

      yield* vacuumToIncremental;
      const converted = yield* readDatabasePages;
      assert.equal(converted.autoVacuum, AUTO_VACUUM_INCREMENTAL);
      assert.equal(converted.freelistCount, 0);
      assert.isBelow(converted.pageCount, before.pageCount / 2);
      assert.isBelow(NodeFS.statSync(`${filename}-wal`).size, 64 * 1024);

      yield* fill(sql, 2_000);
      yield* sql`DELETE FROM filler`;
      const freed = yield* readDatabasePages;
      assert.isAbove(freed.freelistCount, 1_000);
      const released = yield* incrementalVacuum({ maxDurationMs: 5_000 });
      assert.equal(released, freed.freelistCount);
      const after = yield* readDatabasePages;
      assert.equal(after.freelistCount, 0);
      assert.isBelow(after.pageCount, freed.pageCount);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    ),
  );
});
