import { describe, expect, it } from "vitest";
import { Effect, Scope } from "effect";
import { makeAccountRuntimeCache } from "./accountRuntimeCache.ts";

describe("account runtime lifecycle", () => {
  it("coalesces concurrent opens and closes replaced and evicted account resources", async () => {
    const opened: string[] = [],
      closed: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* Effect.scope;
          const cache = yield* makeAccountRuntimeCache(
            parent,
            (account, scope) =>
              Effect.gen(function* () {
                const identity = `${account.id}:${account.generation}`;
                opened.push(identity);
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    closed.push(identity);
                  }),
                );
                yield* Effect.never.pipe(Effect.forkIn(scope));
                return identity;
              }).pipe(Effect.provideService(Scope.Scope, scope)),
            2,
          );
          const results = yield* Effect.forEach(
            [1, 2, 3, 4],
            () => cache.get({ id: "alice", generation: "1" }),
            { concurrency: "unbounded" },
          );
          expect(results).toEqual(["alice:1", "alice:1", "alice:1", "alice:1"]);
          expect(opened).toEqual(["alice:1"]);
          yield* cache.get({ id: "alice", generation: "2" });
          expect(closed).toEqual(["alice:1"]);
          yield* cache.get({ id: "bob", generation: "1" });
          yield* cache.get({ id: "charlie", generation: "1" });
          expect(cache.entries.size).toBe(2);
          expect(closed).toEqual(["alice:1", "alice:2"]);
        }),
      ),
    );
    expect(closed.sort()).toEqual(opened.sort());
  });
  it("closes a failed generation build without caching or leaking its subscriptions", async () => {
    let finalized = 0,
      attempts = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* Effect.scope;
          const cache = yield* makeAccountRuntimeCache(parent, (_account, scope) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              attempts++;
              if (attempts === 1) return yield* Effect.fail("verification failed");
              return "runtime";
            }).pipe(Effect.provideService(Scope.Scope, scope)),
          );
          expect(
            (yield* cache.get({ id: "alice", generation: "1" }).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(finalized).toBe(1);
          expect(cache.entries.size).toBe(0);
          expect(yield* cache.get({ id: "alice", generation: "1" })).toBe("runtime");
          expect(cache.entries.size).toBe(1);
        }),
      ),
    );
    expect(finalized).toBe(2);
  });
});
