import { it, expect } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makePullRequestEventQueue } from "./pullRequestEventQueue";

it.effect("retains one coalesced follow-up event while a read is in flight", () =>
  Effect.gen(function* () {
    const queue = yield* makePullRequestEventQueue;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    queue.offer("pr");
    queue.offer("pr");
    const read = yield* Effect.gen(function* () {
      expect(yield* queue.take).toBe("pr");
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      expect(yield* queue.take).toBe("pr");
    }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    queue.offer("pr");
    queue.offer("pr");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(read);
    yield* queue.shutdown;
  }),
);
