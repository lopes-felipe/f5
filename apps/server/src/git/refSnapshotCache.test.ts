import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeRefSnapshotCache } from "./refSnapshotCache.ts";

it.effect(
  "coalesces simultaneous ref scans and refreshes only after the short refresh window",
  () =>
    Effect.gen(function* () {
      let now = 0,
        reads = 0;
      const cache = makeRefSnapshotCache<number, Error>(
        () => new Error("overloaded"),
        () => now,
      );
      const started = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const lookup = Effect.gen(function* () {
        reads++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return reads;
      });
      const first = yield* cache.get("common", lookup).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* cache.get("common", lookup).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(first), 1);
      assert.equal(yield* Fiber.join(second), 1);
      assert.equal(yield* cache.get("common", lookup, true), 1);
      now = 5_001;
      assert.equal(yield* cache.get("common", lookup, true), 2);
    }),
);

it.effect("does not republish a snapshot invalidated while its scan was running", () =>
  Effect.gen(function* () {
    const cache = makeRefSnapshotCache<string, Error>(() => new Error("overloaded"));
    const started = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    const old = yield* cache
      .get(
        "common",
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return "old";
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    cache.invalidate();
    const fresh = yield* cache.get("common", Effect.succeed("fresh")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(old);
    assert.equal(yield* Fiber.join(fresh), "fresh");
    assert.equal(yield* cache.get("common", Effect.succeed("unexpected")), "fresh");
  }),
);

it.effect("retries after a failed or interrupted caller without caching its exit", () =>
  Effect.gen(function* () {
    const cache = makeRefSnapshotCache<string, Error>(() => new Error("overloaded"));
    yield* cache.get("common", Effect.fail(new Error("offline"))).pipe(Effect.flip);
    const started = yield* Deferred.make<void>();
    const reader = yield* cache
      .get("common", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(reader);
    assert.equal(yield* cache.get("common", Effect.succeed("recovered")), "recovered");
  }),
);

it.effect("does not interrupt an existing waiter when the scan's caller disconnects", () =>
  Effect.gen(function* () {
    const cache = makeRefSnapshotCache<string, Error>(() => new Error("overloaded"));
    const started = yield* Deferred.make<void>();
    const leader = yield* cache
      .get("common", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const waiter = yield* cache.get("common", Effect.succeed("recovered")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(leader);
    assert.equal(yield* Fiber.join(waiter), "recovered");
  }),
);

it.effect("invalidates one repository without expiring another repository's snapshot", () =>
  Effect.gen(function* () {
    const cache = makeRefSnapshotCache<string, Error>(() => new Error("overloaded"));
    yield* cache.get("one", Effect.succeed("old"));
    yield* cache.get("two", Effect.succeed("kept"));
    cache.invalidate("one");
    assert.equal(yield* cache.get("one", Effect.succeed("new")), "new");
    assert.equal(yield* cache.get("two", Effect.succeed("unexpected")), "kept");
  }),
);
