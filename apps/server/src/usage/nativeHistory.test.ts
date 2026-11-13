import { assert, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { makeNativeHistoryCapability, type NativeHistoryCapability } from "./nativeHistory.ts";
import { parseMuseHistoryLine } from "./museHistory.ts";

const settle = (capability: NativeHistoryCapability) =>
  Effect.gen(function* () {
    while ((yield* capability.getSnapshot).status === "refreshing") yield* Effect.yieldNow;
  });

it.effect("returns immediately during a single-flight discovery and times it out", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let discoveries = 0;
    const capability = yield* makeNativeHistoryCapability({
      enabled: true,
      discover: Effect.sync(() => {
        discoveries++;
      }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
      scan: () => Effect.succeed([]),
    });
    yield* capability.refresh;
    yield* Deferred.await(started);
    yield* capability.refresh;
    assert.equal(discoveries, 1);
    assert.equal((yield* capability.getSnapshot).status, "refreshing");
    yield* TestClock.adjust("5 seconds");
    yield* settle(capability);
    assert.equal((yield* capability.getSnapshot).status, "error");
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    yield* Effect.yieldNow;
    assert.equal(discoveries, 2);
  }),
);

it.effect("retains the last successful scan on failure and reuses successful discovery", () =>
  Effect.gen(function* () {
    let discoveries = 0,
      scans = 0;
    const record = parseMuseHistoryLine(
      JSON.stringify({
        schema_version: 1,
        record_type: "event",
        payload_type: "runtime.session",
        payload_schema_version: 1,
        id: "inference",
        recorded_at: 1785578400123456,
        stream: { kind: "session", id: "session" },
        payload: {
          event: {
            kind: "model_completed",
            model: "muse",
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
      }),
    )!;
    const capability = yield* makeNativeHistoryCapability({
      enabled: true,
      discover: Effect.sync(() => {
        discoveries++;
        return "/native/home";
      }),
      scan: () =>
        Effect.suspend(() => {
          scans++;
          return scans === 2
            ? Effect.fail(new Error("scan failed"))
            : scans === 3
              ? Effect.never
              : Effect.succeed([record]);
        }),
    });
    yield* capability.refresh;
    yield* settle(capability);
    const first = yield* capability.getSnapshot;
    assert.equal(first.status, "ready");
    assert.equal(first.records[0]?.row.totalTokens, 120);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    yield* settle(capability);
    assert.equal((yield* capability.getSnapshot).status, "error");
    assert.strictEqual((yield* capability.getSnapshot).records, first.records);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    yield* TestClock.adjust("2 minutes");
    yield* settle(capability);
    const failed = yield* capability.getSnapshot;
    assert.equal(failed.status, "error");
    assert.strictEqual(failed.records, first.records);
    yield* TestClock.adjust("60 seconds");
    yield* capability.refresh;
    yield* settle(capability);
    assert.equal((yield* capability.getSnapshot).status, "ready");
    assert.equal(discoveries, 1);
    assert.equal(scans, 4);
  }),
);

it.effect("does not discover or scan disabled instances", () =>
  Effect.gen(function* () {
    let calls = 0;
    const capability = yield* makeNativeHistoryCapability({
      enabled: false,
      discover: Effect.sync(() => {
        calls++;
        return "/native/home";
      }),
      scan: () =>
        Effect.sync(() => {
          calls++;
          return [];
        }),
    });
    yield* capability.refresh;
    assert.equal((yield* capability.getSnapshot).status, "idle");
    assert.equal(calls, 0);
  }),
);

it.effect("backs off repeated discovery failures and exposes a safe actionable reason", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const capability = yield* makeNativeHistoryCapability({
      enabled: true,
      discover: Effect.suspend(() => {
        attempts++;
        return Effect.fail(
          Object.assign(new Error("private provider diagnostic"), { code: "EACCES" }),
        );
      }),
      scan: () => Effect.succeed([]),
    });
    yield* capability.refresh;
    yield* settle(capability);
    assert.include((yield* capability.getSnapshot).errorMessage, "discovery failed");
    assert.include((yield* capability.getSnapshot).errorMessage, "permission denied");
    assert.notInclude((yield* capability.getSnapshot).errorMessage, "private provider diagnostic");
    yield* capability.refresh;
    assert.equal(attempts, 1);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    yield* settle(capability);
    assert.equal(attempts, 2);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    assert.equal(attempts, 2);
    yield* TestClock.adjust("30 seconds");
    yield* capability.refresh;
    yield* settle(capability);
    assert.equal(attempts, 3);
  }),
);
