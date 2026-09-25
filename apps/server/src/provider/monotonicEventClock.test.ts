import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeMonotonicIsoClock } from "./monotonicEventClock.ts";

it.effect("stamps strictly increasing timestamps while the clock stands still", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    const first = yield* nextCreatedAt("thread-a");
    const second = yield* nextCreatedAt("thread-a");
    const third = yield* nextCreatedAt("thread-a");

    assert.strictEqual(Date.parse(second) - Date.parse(first), 1);
    assert.strictEqual(Date.parse(third) - Date.parse(second), 1);
    assert.match(first, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }),
);

it.effect("follows the clock once it moves past the last stamp", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    const first = yield* nextCreatedAt("thread-a");
    yield* nextCreatedAt("thread-a");
    yield* TestClock.adjust("5 seconds");
    const later = yield* nextCreatedAt("thread-a");

    assert.strictEqual(Date.parse(later) - Date.parse(first), 5_000);
  }),
);

it.effect("keeps keys independent so one busy thread does not skew another", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    const busyFirst = yield* nextCreatedAt("thread-busy");
    for (let index = 0; index < 100; index += 1) {
      yield* nextCreatedAt("thread-busy");
    }
    const quietFirst = yield* nextCreatedAt("thread-quiet");

    assert.strictEqual(quietFirst, busyFirst);
  }),
);

it.effect("keeps separate clocks independent", () =>
  Effect.gen(function* () {
    const left = makeMonotonicIsoClock();
    const right = makeMonotonicIsoClock();

    const leftFirst = yield* left("thread-a");
    yield* left("thread-a");
    const rightFirst = yield* right("thread-a");

    assert.strictEqual(rightFirst, leftFirst);
  }),
);

it.effect("keeps per-key ordering correct across idle-key pruning", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    // Push a live key 10 ms ahead of the (frozen) clock.
    let liveLast = "";
    for (let index = 0; index < 10; index += 1) {
      liveLast = yield* nextCreatedAt("thread-live");
    }
    // Enough idle keys to trigger pruning, all still ahead of the prune cutoff.
    for (let index = 0; index < 200; index += 1) {
      yield* nextCreatedAt(`thread-idle-${index}`);
    }
    const liveNext = yield* nextCreatedAt("thread-live");
    assert.strictEqual(Date.parse(liveNext) - Date.parse(liveLast), 1);

    // After the retention window, pruned keys start fresh at the clock.
    yield* TestClock.adjust("2 minutes");
    for (let index = 0; index < 200; index += 1) {
      yield* nextCreatedAt(`thread-other-${index}`);
    }
    const now = yield* nextCreatedAt("thread-idle-0");
    const liveAfter = yield* nextCreatedAt("thread-live");
    assert.strictEqual(now, liveAfter);
  }),
);
