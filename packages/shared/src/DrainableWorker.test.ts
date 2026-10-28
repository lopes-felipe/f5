import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";

import { makeDrainableWorker } from "./DrainableWorker";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

it.live("settles every drain waiter and continues admission after processing failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const processed: number[] = [];
      const worker = yield* makeDrainableWorker(
        (item: number) =>
          Effect.gen(function* () {
            processed.push(item);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* Effect.fail(new Error("injected worker failure"));
          }),
        { name: "failure-test", maxEntries: 2 },
      );
      yield* worker.enqueue(1);
      yield* Deferred.await(entered);
      yield* worker.enqueue(2);
      const first = yield* Effect.exit(worker.drain).pipe(Effect.forkChild);
      const second = yield* Effect.exit(worker.drain).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true);
      expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true);
      expect(processed).toEqual([1, 2]);
      expect((yield* worker.snapshot).phase).toBe("accepting");
      yield* worker.enqueue(3);
      yield* worker.drain;
      expect(processed).toEqual([1, 2, 3]);
      expect((yield* worker.snapshot).entries).toBe(0);
      expect((yield* worker.snapshot).failures).toBe(3);
    }),
  ),
);

it.effect("recovers from thrown construction, defects and self-interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const processed: string[] = [];
      const worker = yield* makeDrainableWorker(
        (item: string) => {
          if (item === "throw") throw new Error("construction failure");
          if (item === "die") return Effect.die("defect");
          if (item === "interrupt") return Effect.interrupt;
          return Effect.sync(() => {
            processed.push(item);
          });
        },
        { maxEntries: 2, maxBytes: 20, sizeOf: (item) => item.length },
      );
      for (const item of ["throw", "die", "interrupt", "ok"]) yield* worker.enqueue(item);
      yield* worker.drain;
      expect(processed).toEqual(["ok"]);
      expect(yield* worker.snapshot).toMatchObject({
        entries: 0,
        bytes: 0,
        failures: 2,
        phase: "accepting",
      });
    }),
  ),
);

it.live("interruption during bounded admission leaves no outstanding ghost entry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const processed: number[] = [];
      const worker = yield* makeDrainableWorker(
        (item: number) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            processed.push(item);
          }),
        { name: "admission-test", maxEntries: 1 },
      );
      yield* worker.enqueue(1);
      yield* Deferred.await(entered);
      const waiting = yield* worker.enqueue(2).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect((yield* worker.snapshot).entries).toBe(1);
      yield* Fiber.interrupt(waiting);
      expect(yield* worker.offer(3)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      expect(processed).toEqual([1]);
      expect((yield* worker.snapshot).entries).toBe(0);
      yield* worker.close;
      expect(Exit.isFailure(yield* Effect.exit(worker.offer(4)))).toBe(true);
    }),
  ),
);

it.live("coalesces queued revisions into one dirty rerun with bounded byte accounting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const processed: number[] = [];
      const worker = yield* makeDrainableWorker(
        (item: { key: string; revision: number; text: string }) =>
          Effect.gen(function* () {
            if (item.revision === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            processed.push(item.revision);
          }),
        {
          name: "coalesce-test",
          maxEntries: 2,
          maxBytes: 10,
          sizeOf: (item) => item.text.length,
          key: (item) => item.key,
          revision: (item) => item.revision,
        },
      );
      yield* worker.enqueue({ key: "thread", revision: 1, text: "one" });
      yield* Deferred.await(entered);
      yield* worker.enqueue({ key: "thread", revision: 2, text: "two" });
      yield* worker.enqueue({ key: "thread", revision: 3, text: "three" });
      yield* worker.enqueue({ key: "thread", revision: 2, text: "older" });
      expect((yield* worker.snapshot).entries).toBe(1);
      expect((yield* worker.snapshot).bytes).toBe(5);
      expect(yield* worker.offer({ key: "other", revision: 9, text: "longer" })).toBe(false);
      expect(yield* worker.offer({ key: "other", revision: 9, text: "x" })).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      expect(processed).toEqual([1, 9, 3]);
      expect((yield* worker.snapshot).bytes).toBe(0);
    }),
  ),
);

it.live("self-notification at full admission reserves one fair dirty rerun and drains", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const processed: string[] = [];
      let reenqueue!: (item: string) => Effect.Effect<void>;
      const worker = yield* makeDrainableWorker(
        (item: string) =>
          Effect.gen(function* () {
            const first = processed.length === 0;
            processed.push(item);
            if (first) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* reenqueue(item);
              yield* reenqueue(item);
            }
          }),
        { maxEntries: 2, maxBytes: 2, sizeOf: () => 1, key: (item) => item },
      );
      reenqueue = (item) => worker.enqueue(item).pipe(Effect.orDie);
      yield* worker.enqueue("self");
      yield* Deferred.await(entered);
      yield* worker.enqueue("other");
      expect((yield* worker.snapshot).entries).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain.pipe(Effect.timeout("1 second"));
      expect(processed).toEqual(["self", "other", "self"]);
      expect((yield* worker.snapshot).entries).toBe(0);
      expect((yield* worker.snapshot).bytes).toBe(0);
    }),
  ),
);

it.live("runs reserved controls after the current item under saturated bulk admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const processed: string[] = [];
      const worker = yield* makeDrainableWorker(
        (item: string) =>
          Effect.gen(function* () {
            if (item === "active") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            processed.push(item);
          }),
        {
          maxEntries: 2,
          maxBytes: 10,
          sizeOf: () => 5,
          controlEntries: 1,
          isControl: (item) => item === "stop" || item === "approval",
        },
      );
      yield* worker.enqueue("active");
      yield* Deferred.await(entered);
      yield* worker.enqueue("bulk");
      expect(yield* worker.offer("overflow")).toBe(false);
      yield* worker.enqueue("stop");
      expect(yield* worker.offer("approval")).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      expect(processed).toEqual(["active", "stop", "bulk"]);
      expect((yield* worker.snapshot).entries).toBe(0);
    }),
  ),
);

it.live(
  "scope cancellation closes unfinished work and wakes admission without reporting worker failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const entered = yield* Deferred.make<void>();
        const worker = yield* makeDrainableWorker(
          (_: number) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          { name: "cancelled-worker", maxEntries: 1 },
        ).pipe(Scope.provide(scope));
        yield* worker.enqueue(1);
        yield* Deferred.await(entered);
        const drain = yield* worker.drain.pipe(Effect.exit, Effect.forkChild);
        const admission = yield* worker.enqueue(2).pipe(Effect.exit, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);
        const snapshot = yield* worker.snapshot;
        expect(snapshot.phase).toBe("closed");
        expect(snapshot.failures).toBe(0);
        expect(snapshot.entries).toBe(0);
        expect(snapshot.bytes).toBe(0);
        expect(Exit.isFailure(yield* Fiber.join(drain))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.join(admission))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(worker.drain))).toBe(true);
      }),
    ),
);
