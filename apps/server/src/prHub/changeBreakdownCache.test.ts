import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { makeChangeBreakdownCache } from "./changeBreakdownCache";

describe("breakdown cache", () => {
  it("keeps the shared fetch alive when its first reader is interrupted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* makeChangeBreakdownCache;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<null>();
        let calls = 0;
        const fetch = Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(release);
        });
        const first = yield* Effect.forkChild(read("shared", fetch));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(read("shared", fetch));
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, null);
        expect(yield* Fiber.join(second)).toBeNull();
        expect(calls).toBe(1);
      }),
    );
  });
  it("coalesces requests and separates accounts and comparison revisions", async () => {
    let calls = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* makeChangeBreakdownCache;
        const fetch = Effect.sync(() => {
          calls++;
          return null;
        }).pipe(Effect.delay("10 millis"));
        yield* Effect.all([read("a:pr:head1:base1", fetch), read("a:pr:head1:base1", fetch)], {
          concurrency: "unbounded",
        });
        expect(calls).toBe(1);
        yield* read("a:pr:head1:base1", fetch);
        expect(calls).toBe(1);
        yield* read("b:pr:head1:base1", fetch);
        yield* read("a:pr:head2:base1", fetch);
        expect(calls).toBe(3);
      }),
    );
  });
});
