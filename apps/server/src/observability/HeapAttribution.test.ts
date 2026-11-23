import { assert, it } from "@effect/vitest";
import { Effect, Exit, ServiceMap } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { makeHeapAttribution } from "./HeapAttribution.ts";
import { makeLocalFileTracer } from "./LocalFileTracer.ts";
import type { TraceRecord } from "./TraceRecord.ts";

const MB = 1024 * 1024;

const makeFixture = Effect.gen(function* () {
  const records: TraceRecord[] = [];
  const baseTracer = yield* makeLocalFileTracer({
    filePath: "unused.ndjson",
    maxBytes: 1024,
    maxFiles: 1,
    batchWindowMs: 200,
    sink: {
      filePath: "unused.ndjson",
      push: (record) => records.push(record),
      flush: Effect.void,
      close: () => Effect.void,
    },
  });
  let heap = 300 * MB;
  let reads = 0;
  const { tracer, run } = makeHeapAttribution(baseTracer, () => {
    reads++;
    return heap;
  });
  return {
    run,
    grow: (megabytes: number) => {
      heap += megabytes * MB;
    },
    reads: () => reads,
    spikes: () => records.filter((record) => record.name === "server.heap.spike"),
    growthFor: (name: string) =>
      records.find((record) => record.name === name)?.attributes["memory.heap_growth_bytes"],
    open: (name: string) =>
      tracer.span({
        name,
        parent: undefined,
        annotations: ServiceMap.empty(),
        links: [],
        startTime: 0n,
        kind: "internal",
        root: false,
        sampled: true,
      }),
  };
});

it.effect("exports growth and ranks recently active spans as spike suspects", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* fixture.run;
    yield* TestClock.adjust("1 second");

    const subscription = fixture.open("subscription");
    const old = fixture.open("old-query");
    const recentlyClosedSubscription = fixture.open("closed-subscription");
    for (let step = 0; step < 5; step++) {
      fixture.grow(80);
      yield* TestClock.adjust("11 seconds");
      if (step === 1) old.end(1n, Exit.void);
    }
    assert.deepEqual(fixture.spikes(), []);
    recentlyClosedSubscription.end(1n, Exit.void);

    const small = fixture.open("small-query");
    fixture.grow(2);
    small.end(1n, Exit.void);
    const recent = fixture.open("completed-query");
    fixture.grow(8);
    recent.end(1n, Exit.void);
    const big = fixture.open("large-query");
    fixture.grow(120);
    yield* TestClock.adjust("1 second");

    const spikes = fixture.spikes();
    assert.lengthOf(spikes, 1);
    assert.isUndefined(spikes[0]?.parentSpanId);
    assert.deepEqual(spikes[0]?.attributes, {
      heapUsedMb: 830,
      growthMb: 130,
      suspects: ["large-query +120 MB", "completed-query +8 MB"],
    });
    big.end(2n, Exit.void);
    subscription.end(3n, Exit.void);
    assert.equal(fixture.growthFor("large-query"), 120 * MB);
    assert.equal(fixture.growthFor("subscription"), 530 * MB);
    assert.equal(fixture.growthFor("closed-subscription"), 400 * MB);
    assert.equal(fixture.growthFor("old-query"), 160 * MB);
    assert.equal(fixture.growthFor("completed-query"), 8 * MB);
    assert.isUndefined(fixture.growthFor("small-query"));
  }),
);

it.effect("compares the current heap with the reading from ten seconds ago", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* fixture.run;
    yield* TestClock.adjust("1 second");
    for (let second = 0; second < 9; second++) {
      fixture.grow(13);
      yield* TestClock.adjust("1 second");
    }
    assert.lengthOf(fixture.spikes(), 0);
    fixture.grow(13);
    yield* TestClock.adjust("1 second");
    assert.lengthOf(fixture.spikes(), 1);
    assert.equal(fixture.spikes()[0]?.attributes["growthMb"], 130);
  }),
);

it.effect("rate limits spikes and stops sampling when its scope closes", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fixture.run;
        yield* TestClock.adjust("1 second");
        fixture.grow(127);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(fixture.spikes(), 0);
        fixture.grow(1);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(fixture.spikes(), 1);
        assert.equal(fixture.spikes()[0]?.attributes["growthMb"], 128);
        fixture.grow(128);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(fixture.spikes(), 1);
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(fixture.spikes(), 1);
        fixture.grow(130);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(fixture.spikes(), 2);
        assert.equal(fixture.spikes()[1]?.attributes["growthMb"], 130);
      }),
    );
    const reads = fixture.reads();
    yield* TestClock.adjust("2 seconds");
    assert.equal(fixture.reads(), reads);
  }),
);
