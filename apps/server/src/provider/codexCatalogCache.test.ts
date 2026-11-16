import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { makeCodexCatalogCache } from "./codexCatalogCache";
import type { CodexInstanceCatalog } from "./codexModelCatalog";

const catalog = (slug: string, skills?: CodexInstanceCatalog["skills"]): CodexInstanceCatalog => ({
  models: [{ slug, name: slug, capabilities: { source: "reported", optionDescriptors: [] } }],
  presentSlugs: [slug],
  complete: true,
  fetchedAt: new Date(0).toISOString(),
  ...(skills !== undefined ? { skills } : {}),
});

it.effect(
  "returns stale data immediately, coalesces background probes, and exposes the result on the next read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const cache = yield* makeCodexCatalogCache(() =>
          Effect.gen(function* () {
            calls++;
            if (calls > 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return catalog(calls === 1 ? "old" : "new");
          }),
        );
        expect((yield* cache.read("1"))?.models[0]?.slug).toBe("old");
        yield* TestClock.adjust("1 hour");
        expect((yield* cache.read("1"))?.models[0]?.slug).toBe("old");
        yield* Deferred.await(started);
        expect((yield* cache.read("1"))?.models[0]?.slug).toBe("old");
        expect(calls).toBe(2);
        yield* Deferred.succeed(release, undefined);
        // The probe lock lets this explicit read join the background result.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect((yield* cache.read("1"))?.models[0]?.slug).toBe("new");
      }),
    ),
);

it.effect("probes immediately on version changes and coalesces concurrent invalidated reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const cache = yield* makeCodexCatalogCache((version) =>
        Effect.gen(function* () {
          calls++;
          if (calls === 3) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return catalog(version);
        }),
      );
      yield* cache.read("1");
      expect((yield* cache.read("2"))?.models[0]?.slug).toBe("2");
      yield* cache.invalidate;
      const first = yield* cache.read("2").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* cache.read("2").pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(calls).toBe(3);
    }),
  ),
);

it.effect("keeps failures failed beyond the registry lease and respects backoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;
      const cache = yield* makeCodexCatalogCache(() =>
        Effect.suspend(() =>
          ++calls === 1 ? Effect.succeed(catalog("old")) : Effect.fail("offline"),
        ),
      );
      yield* cache.read("1");
      yield* TestClock.adjust("1 hour");
      yield* cache.read("1"); // initial stale-while-revalidate
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* cache.read("1")).toBeUndefined();
      expect(calls).toBe(2);
      for (let attempt = 0; attempt < 50; attempt++) {
        yield* TestClock.adjust("30 minutes");
        expect(yield* cache.read("1")).toBeUndefined();
        const before = calls;
        expect(yield* cache.read("1")).toBeUndefined();
        expect(calls).toBe(before);
      }
      expect(yield* Clock.currentTimeMillis).toBeGreaterThan(24 * 60 * 60 * 1000);
      yield* cache.invalidate;
      yield* cache.read("1");
      expect(calls).toBe(53);
    }),
  ),
);

it.effect(
  "keeps skills after model or skills failures, clears successful empty skills, and isolates versions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const skills = [{ name: "skill", path: "/skill", enabled: true }];
        let calls = 0;
        const cache = yield* makeCodexCatalogCache(() =>
          Effect.suspend(() => {
            calls++;
            return calls === 2
              ? Effect.fail("offline")
              : Effect.succeed(
                  catalog("model", calls === 1 ? skills : calls === 3 ? undefined : []),
                );
          }),
        );
        yield* cache.read("1");
        yield* cache.invalidate;
        yield* cache.read("1");
        expect(yield* cache.readSkills("1")).toEqual(skills);
        expect(yield* cache.readSkills("2")).toEqual([]);
        yield* cache.invalidate;
        yield* cache.read("1");
        expect(yield* cache.readSkills("1")).toEqual(skills);
        yield* cache.invalidate;
        yield* cache.read("1");
        expect(yield* cache.readSkills("1")).toEqual([]);
      }),
    ),
);

it.effect("interrupts the background refresh when the instance scope closes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Ref.make(false);
    yield* Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const cache = yield* makeCodexCatalogCache(() =>
          ++calls === 1
            ? Effect.succeed(catalog("old"))
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Ref.set(stopped, true)),
              ),
        );
        yield* cache.read("1");
        yield* TestClock.adjust("1 hour");
        yield* cache.read("1");
        yield* Deferred.await(started);
      }),
    );
    expect(yield* Ref.get(stopped)).toBe(true);
  }),
);
