import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeMonotonicIsoClock } from "./monotonicEventClock.ts";

it.effect("stamps strictly increasing timestamps while the clock stands still", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    const first = yield* nextCreatedAt;
    const second = yield* nextCreatedAt;
    const third = yield* nextCreatedAt;

    assert.strictEqual(Date.parse(second) - Date.parse(first), 1);
    assert.strictEqual(Date.parse(third) - Date.parse(second), 1);
    assert.match(first, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }),
);

it.effect("follows the clock once it moves past the last stamp", () =>
  Effect.gen(function* () {
    const nextCreatedAt = makeMonotonicIsoClock();

    const first = yield* nextCreatedAt;
    yield* nextCreatedAt;
    yield* TestClock.adjust("5 seconds");
    const later = yield* nextCreatedAt;

    assert.strictEqual(Date.parse(later) - Date.parse(first), 5_000);
  }),
);

it.effect("keeps separate clocks independent", () =>
  Effect.gen(function* () {
    const left = makeMonotonicIsoClock();
    const right = makeMonotonicIsoClock();

    const leftFirst = yield* left;
    yield* left;
    const rightFirst = yield* right;

    assert.strictEqual(rightFirst, leftFirst);
  }),
);
