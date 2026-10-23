import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { makeSqlitePersistenceLive } from "./Sqlite.ts";
import { ReadSqlClient } from "../ReadSqlClient.ts";

describe("SQLite persistence setup", () => {
  it("keeps reads in a deferred read-only snapshot while the writer commits independently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-reader-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const writer = yield* SqlClient.SqlClient;
          const reader = yield* ReadSqlClient;
          yield* writer`CREATE TABLE read_fixture(value INTEGER)`;
          yield* writer`INSERT INTO read_fixture VALUES(1)`;
          expect((yield* reader`INSERT INTO read_fixture VALUES(2)`.pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const snapshot = yield* reader
            .withTransaction(
              Effect.gen(function* () {
                expect(
                  (yield* reader<{ value: number }>`SELECT value FROM read_fixture`)[0]?.value,
                ).toBe(1);
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return (yield* reader<{ value: number }>`SELECT value FROM read_fixture`)[0]?.value;
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* writer
            .withTransaction(writer`UPDATE read_fixture SET value=3`)
            .pipe(Effect.timeout("1 second"));
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(snapshot)).toBe(1);
          expect((yield* reader<{ value: number }>`SELECT value FROM read_fixture`)[0]?.value).toBe(
            3,
          );
        }).pipe(
          Effect.provide(
            makeSqlitePersistenceLive(join(directory, "state.sqlite")).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    "applies durable bounded-WAL settings after migrations (existing=%s)",
    async (existing) => {
      const directory = mkdtempSync(join(tmpdir(), "f5-sqlite-setup-"));
      const filename = join(directory, "state.sqlite");
      if (existing) {
        const database = new DatabaseSync(filename);
        database.exec(
          "CREATE TABLE planner_fixture(value TEXT); CREATE INDEX planner_fixture_index ON planner_fixture(value); INSERT INTO planner_fixture VALUES('one'),('two');",
        );
        database.close();
      }
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            expect((yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]?.timeout).toBe(5000);
            expect(
              (yield* sql<{ checkpoint_fullfsync: number }>`PRAGMA checkpoint_fullfsync`)[0]
                ?.checkpoint_fullfsync,
            ).toBe(1);
            expect((yield* sql<{ synchronous: number }>`PRAGMA synchronous`)[0]?.synchronous).toBe(
              2,
            );
            expect(
              (yield* sql<{ journal_size_limit: number }>`PRAGMA journal_size_limit`)[0]
                ?.journal_size_limit,
            ).toBe(33554432);
            expect(
              (yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`)[0]?.foreign_keys,
            ).toBe(1);
            if (existing) {
              const stats = yield* sql<{
                tbl: string;
              }>`SELECT tbl FROM sqlite_stat1 WHERE tbl='planner_fixture'`;
              expect(stats).toHaveLength(1);
            }
          }).pipe(
            Effect.provide(
              makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
