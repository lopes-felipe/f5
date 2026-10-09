import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  AUTO_VACUUM_INCREMENTAL,
  incrementalVacuum,
  readDatabasePages,
  vacuumFreeSpaceShortfall,
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

describe("vacuumFreeSpaceShortfall", () => {
  const GB = 1024 ** 3;
  const dbPath = NodePath.join(NodeOS.tmpdir(), "state.sqlite");
  const statfsWith = (freeByPath: Record<string, number>) => async (path: string) => ({
    bavail: freeByPath[path] ?? 0,
    bsize: 1,
  });

  it("counts both copies against one volume when the temp dir shares it", async () => {
    const tempDirectory = NodeOS.tmpdir();
    const statfs = statfsWith({ [tempDirectory]: 21 * GB });
    assert.isNull(
      await vacuumFreeSpaceShortfall({ dbPath, liveBytes: 9 * GB, statfs, tempDirectory }),
    );
    assert.match(
      (await vacuumFreeSpaceShortfall({ dbPath, liveBytes: 10 * GB, statfs, tempDirectory }))!,
      /below 2\.2x/,
    );
  });

  it("checks the temp directory's own volume when it differs", async () => {
    // `/dev` is a separate file system from the temp directory on macOS and Linux.
    const tempDirectory = "/dev";
    if (NodeFS.statSync(tempDirectory).dev === NodeFS.statSync(NodeOS.tmpdir()).dev) return;
    const enough = statfsWith({ [NodeOS.tmpdir()]: 12 * GB, [tempDirectory]: 12 * GB });
    assert.isNull(
      await vacuumFreeSpaceShortfall({
        dbPath,
        liveBytes: 10 * GB,
        statfs: enough,
        tempDirectory,
      }),
    );
    const smallTemp = statfsWith({ [NodeOS.tmpdir()]: 100 * GB, [tempDirectory]: 1 * GB });
    assert.match(
      (await vacuumFreeSpaceShortfall({
        dbPath,
        liveBytes: 10 * GB,
        statfs: smallTemp,
        tempDirectory,
      }))!,
      /temp directory/,
    );
  });
});
