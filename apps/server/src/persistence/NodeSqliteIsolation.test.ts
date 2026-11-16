import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { vi } from "vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "./NodeSqliteClient.ts";

it.layer(SqliteClient.layerMemory())("SQLite connection isolation", (it) => {
  it.effect("a transaction waits until a standalone statement releases its connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE isolated_counter(value INTEGER)`;
      yield* sql`INSERT INTO isolated_counter VALUES (0)`;
      const reservation = yield* Scope.make();
      const connection = yield* Scope.provide(sql.reserve, reservation);
      yield* Scope.close(reservation, Exit.void);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const original = connection.execute;
      // Hold one public connection operation in flight to make a scheduler yield reproducible.
      const spy = vi.spyOn(connection, "execute").mockImplementation((query, params, transform) =>
        query.includes("SELECT value FROM isolated_counter")
          ? Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* original(query, params, transform);
            })
          : original(query, params, transform),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const reader = yield* sql<{ value: number }>`SELECT value FROM isolated_counter`.pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      let wrote = false;
      const writer = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE isolated_counter SET value=1`;
            wrote = true;
          }),
        )
        .pipe(Effect.forkChild);
      for (let turn = 0; turn < 16; turn++) yield* Effect.yieldNow;
      const wroteBeforeRelease = wrote;
      yield* Deferred.succeed(release, undefined);
      const rows = yield* Fiber.join(reader);
      yield* Fiber.join(writer);
      assert.isFalse(
        wroteBeforeRelease,
        "a transaction entered while another statement owned the connection",
      );
      assert.equal(rows[0]?.value, 0);
      assert.equal(
        (yield* sql<{ value: number }>`SELECT value FROM isolated_counter`)[0]?.value,
        1,
      );
    }),
  );
});
