import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import type { Worker as NodeWorker } from "node:worker_threads";
import { Cause, Effect, Metric } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import {
  checkpointWorkerSource,
  sqliteCheckpointBlocked,
  sqliteWalBytes,
} from "./sqliteCheckpointWorker.ts";

const workers = vi.hoisted(() => [] as NodeWorker[]);
const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(
          ...((failure.enabled
            ? ["throw new Error('checkpoint startup fixture');", { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
        );
        workers.push(this);
      }
    },
  };
});

const supportsNoop = (() => {
  const db = new DatabaseSync(":memory:");
  try {
    const version = db.prepare("SELECT sqlite_version() AS version").get()!.version as string;
    const [major, minor] = version.split(".").map(Number);
    return major! > 3 || (major === 3 && minor! >= 51);
  } finally {
    db.close();
  }
})();

const withClient = async <E>(
  run: (sql: SqlClient.SqlClient, filename: string) => Effect.Effect<void, E>,
) => {
  const directory = mkdtempSync(join(tmpdir(), "f5-checkpoint-"));
  const filename = join(directory, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode=WAL`;
        yield* sql`PRAGMA journal_size_limit=33554432`;
        yield* sql`CREATE TABLE payload(value BLOB)`;
        yield* run(sql, filename);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, checkpointWorker: true }))),
    );
  } finally {
    // Windows can refuse the delete while a just-terminated worker still holds the database open.
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
};

const until = <E>(
  predicate: () => Effect.Effect<boolean, E>,
  waitingFor = "the condition",
  seconds = 10,
) =>
  Effect.gen(function* () {
    while (!(yield* predicate())) yield* Effect.sleep("10 millis");
  }).pipe(
    Effect.timeout(`${seconds} seconds`),
    Effect.mapError((cause) =>
      Cause.isTimeoutError(cause)
        ? new Error(`Timed out after ${seconds}s waiting for ${waitingFor}`)
        : cause,
    ),
  );

// Observe from another connection: querying through the writer would keep
// resetting the worker's 100 ms idle timer. A tail below 1,000 frames is
// intentionally retained; the following write must still obey the WAL bound.
const checkpointed = (filename: string) => () =>
  Effect.sync(() => {
    const observer = new DatabaseSync(filename);
    try {
      const row = observer.prepare("PRAGMA wal_checkpoint(NOOP)").get()!;
      return (
        row.busy === 0 &&
        Number(row.log) >= 0 &&
        Number(row.checkpointed) >= 0 &&
        (row.log === row.checkpointed || Number(row.log) < 1000)
      );
    } finally {
      observer.close();
    }
  });

describe("SQLite checkpoint worker", () => {
  it("does not label an unattempted NOOP backlog as checkpoint contention", () => {
    let receive!: () => void;
    let idle!: () => void;
    let checkpointed = 1500;
    let noopBusy = false;
    let busyTimeoutConfigured = false;
    const messages: Array<{ blocked: boolean }> = [];
    const passive = vi.fn(() => ({ log: 2000, checkpointed, busy: 0 }));
    runInNewContext(checkpointWorkerSource, {
      require: (module: string) => {
        if (module === "node:worker_threads")
          return {
            workerData: { filename: "fixture", frames: 1000, idleMs: 100 },
            parentPort: {
              on: (_event: string, callback: () => void) => {
                receive = callback;
              },
              postMessage: (message: { blocked: boolean }) => messages.push(message),
            },
          };
        if (module === "node:fs")
          return { openSync: () => 3, fstatSync: () => ({ size: 8_240_032 }), closeSync: () => {} };
        if (module === "node:sqlite")
          return {
            DatabaseSync: class {
              exec(sql: string) {
                if (sql.includes("busy_timeout=5000")) busyTimeoutConfigured = true;
              }
              prepare(sql: string) {
                expect(busyTimeoutConfigured).toBe(true);
                return {
                  get: sql.includes("sqlite_version")
                    ? () => ({ version: "3.51.2" })
                    : sql.includes("PASSIVE")
                      ? passive
                      : () =>
                          noopBusy
                            ? { log: -1, checkpointed: -1, busy: 1 }
                            : { log: 2000, checkpointed, busy: 0 },
                };
              }
            },
          };
        throw new Error("Unexpected worker module");
      },
      setTimeout: (callback: () => void) => {
        idle = callback;
      },
      clearTimeout: () => {},
    });
    receive();
    expect(passive).not.toHaveBeenCalled();
    expect(messages.at(-1)?.blocked).toBe(false);
    idle();
    expect(passive).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.blocked).toBe(true);
    noopBusy = true;
    receive();
    expect(messages.at(-1)?.blocked).toBe(true);
    idle();
    expect(messages.at(-1)?.blocked).toBe(true);
    noopBusy = false;
    checkpointed = 2000;
    // The pending idle check must recover without another writer command.
    idle();
    expect(messages.at(-1)?.blocked).toBe(false);
  });
  it.skipIf(!supportsNoop)(
    "checkpoints large writes off-thread and reuses a bounded WAL",
    async () => {
      await withClient((sql, filename) =>
        Effect.gen(function* () {
          expect(
            (yield* sql<{ wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`)[0]!
              .wal_autocheckpoint,
          ).toBe(10000);
          // 100 MiB across small statements gives the worker and server turns between writes.
          for (let index = 0; index < 100; index++) {
            yield* sql`INSERT INTO payload VALUES (zeroblob(1048576))`;
            yield* Effect.yieldNow;
          }
          yield* until(checkpointed(filename));
          yield* sql`INSERT INTO payload VALUES (zeroblob(1))`;
          expect(statSync(`${filename}-wal`).size).toBeLessThanOrEqual(33554432);
          yield* until(
            () => Metric.value(sqliteWalBytes).pipe(Effect.map((state) => state.value > 0)),
            "the worker WAL metric",
          );
        }),
      );
    },
  );

  it.skipIf(!supportsNoop)(
    "reports a pinned reader and checkpoints after it releases",
    async () => {
      await withClient((sql, filename) =>
        // A generator's finally does not run when a yielded effect fails, so the reader is
        // released by the scope; left open, it also blocks the folder delete on Windows.
        Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* Effect.acquireRelease(
              Effect.sync(() => new DatabaseSync(filename)),
              (reader) => Effect.sync(() => reader.close()),
            );
            reader.exec("BEGIN; SELECT * FROM payload");
            for (let index = 0; index < 40; index++) {
              yield* sql`INSERT INTO payload VALUES (zeroblob(1048576))`;
              yield* Effect.yieldNow;
            }
            yield* until(
              () =>
                Metric.value(sqliteCheckpointBlocked).pipe(
                  Effect.map((state) => state.value === 1),
                ),
              "the pinned reader to be reported",
            );
            reader.exec("ROLLBACK");
            // Releasing an external reader alone must let the idle worker catch up.
            yield* until(checkpointed(filename), "the checkpoint after the reader released", 30);
            yield* sql`INSERT INTO payload VALUES (zeroblob(1))`;
            expect(statSync(`${filename}-wal`).size).toBeLessThanOrEqual(33554432);
          }),
        ),
      );
    },
    60_000,
  );

  it("hands checkpoints back when the worker crashes or cannot start", async () => {
    failure.enabled = true;
    try {
      await withClient((sql) =>
        Effect.gen(function* () {
          yield* until(() =>
            sql<{ wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`.pipe(
              Effect.map(([row]) => row?.wal_autocheckpoint === 1000),
            ),
          );
          yield* sql`INSERT INTO payload VALUES ('still usable')`;
          expect(yield* sql`SELECT count(*) FROM payload`.values).toEqual([[1]]);
        }),
      );
    } finally {
      failure.enabled = false;
    }
    expect(workers.at(-1)!.threadId).toBe(-1);
  });

  it.skipIf(!supportsNoop)(
    "hands checkpoints back after an already-running worker exits",
    async () => {
      await withClient((sql) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => workers.at(-1)!.terminate());
          yield* until(() =>
            sql<{ wal_autocheckpoint: number }>`PRAGMA wal_autocheckpoint`.pipe(
              Effect.map(([row]) => row?.wal_autocheckpoint === 1000),
            ),
          );
        }),
      );
      expect(workers.at(-1)!.threadId).toBe(-1);
    },
  );
});
