import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeChangeBreakdownCache } from "./changeBreakdownCache";

describe("breakdown cache", () => {
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
