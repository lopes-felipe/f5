import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { PullRequestKey, ThreadId, type ThreadPullRequestWatch } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration125 from "../persistence/Migrations/130_ThreadPullRequestWatches.ts";
import { makePullRequestWatchStore } from "./PullRequestWatchStore.ts";

const threadId = ThreadId.makeUnsafe("watch-thread");
const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
const now = "2026-10-19T12:00:00.000Z";
const watch: ThreadPullRequestWatch = {
  startedAt: now,
  headSha: "head",
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: now,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY,archived_at TEXT,deleted_at TEXT,settled_at TEXT)`;
  yield* sql`INSERT INTO projection_threads(thread_id) VALUES(${threadId})`;
  yield* Migration125;
  return yield* makePullRequestWatchStore;
});
function run<A, E>(
  test: (store: Effect.Success<typeof fixture>) => Effect.Effect<A, E, SqlClient.SqlClient>,
) {
  return fixture.pipe(Effect.flatMap(test), Effect.provide(SqliteClient.layerMemory()));
}
it.effect("coalesces repeated starts and gives a restarted watch a new incarnation", () =>
  run((store) =>
    Effect.gen(function* () {
      const first = yield* store.start({ threadId, key, accountId: "one", watch });
      assert.deepStrictEqual(yield* store.start({ threadId, key, accountId: "two", watch }), first);
      yield* store.stop(threadId, key);
      const next = yield* store.start({ threadId, key, accountId: "two", watch });
      assert.notEqual(next.watchId, first.watchId);
      assert.isFalse(yield* store.stopExpected(first));
      assert.equal((yield* store.get(threadId, key))?.watchId, next.watchId);
    }),
  ),
);
it.effect("applies a report once and rejects stale reports after stop or replacement", () =>
  run((store) =>
    Effect.gen(function* () {
      const row = yield* store.start({ threadId, key, accountId: "one", watch });
      assert.isTrue(yield* store.replace(row, { ...watch, wakes: 1 }, now));
      assert.isFalse(yield* store.replace(row, { ...watch, wakes: 2 }, now));
      assert.equal((yield* store.get(threadId, key))?.watch.wakes, 1);
      const current = (yield* store.get(threadId, key))!;
      yield* store.stop(threadId);
      assert.isFalse(yield* store.replace(current, watch, now));
    }),
  ),
);
it.effect("persists retry deadlines without treating rate-limit pauses as failed reads", () =>
  run((store) =>
    Effect.gen(function* () {
      let row = yield* store.start({ threadId, key, accountId: "one", watch });
      const later = "2026-10-19T12:05:00.000Z";
      yield* store.failure(row, now, later, true);
      assert.lengthOf(yield* store.due(now), 0);
      row = (yield* store.get(threadId, key))!;
      assert.equal(row.readFailures, 0);
      yield* store.failure(row, now, later, false);
      assert.equal((yield* store.get(threadId, key))?.readFailures, 1);
      assert.lengthOf(yield* store.due(later), 1);
    }),
  ),
);

it.effect("rejects a watch created after the thread is archived or deleted", () =>
  run((store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const column of ["archived_at", "deleted_at"] as const) {
        yield* sql`UPDATE projection_threads SET archived_at=NULL,deleted_at=NULL`;
        yield* sql`UPDATE projection_threads SET ${sql(column)}=${now} WHERE thread_id=${threadId}`;
        const result = yield* store
          .start({ threadId, key, accountId: "one", watch })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.lengthOf(yield* store.list(threadId), 0);
      }
    }),
  ),
);

it.effect("does not revive a start that was still fetching when Stop committed", () =>
  run((store) =>
    Effect.gen(function* () {
      const expectedStopGeneration = yield* store.stopGeneration(threadId);
      yield* store.stop(threadId);
      const started = yield* store
        .start({ threadId, key, accountId: "one", watch, expectedStopGeneration })
        .pipe(Effect.result);
      assert.equal(started._tag, "Failure");
      assert.lengthOf(yield* store.list(threadId), 0);
      yield* store.start({
        threadId,
        key,
        accountId: "one",
        watch,
        expectedStopGeneration: yield* store.stopGeneration(threadId),
      });
      assert.lengthOf(yield* store.list(threadId), 1);
    }),
  ),
);
