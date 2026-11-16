import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { makeCommandAdmission } from "./commandAdmission.ts";

it.effect("reserves control admission under saturation and retains it until completion", () =>
  Effect.gen(function* () {
    const queue = yield* makeCommandAdmission<string>({
      ordinaryEntries: 2,
      ordinaryBytes: 10,
      controlEntries: 1,
    });
    yield* queue.offer("active", 5, false);
    assert.equal(yield* queue.take, "active");
    yield* queue.offer("bulk", 5, false);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("overflow", 1, false))));
    yield* queue.offer("stop", 1, true);
    assert.equal(yield* queue.take, "stop");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("second-stop", 1, true))));
    yield* queue.release("stop");
    yield* queue.offer("approval", 1, true);
    assert.equal(yield* queue.take, "approval");
    yield* queue.release("approval");
    yield* queue.release("active");
    assert.equal(yield* queue.take, "bulk");
    yield* queue.release("bulk");
    assert.equal(queue.snapshot().entries, 0);
  }),
);
it.effect("cancels only queued starts and closes an idle consumer without leaking a waiter", () =>
  Effect.gen(function* () {
    const queue = yield* makeCommandAdmission<string>();
    yield* queue.offer("active-start", 1, false);
    yield* queue.take;
    yield* queue.offer("old-start", 1, false);
    yield* queue.offer("other-thread", 1, false);
    assert.deepEqual(yield* queue.cancelQueued((item) => item.endsWith("start")), ["old-start"]);
    assert.equal(yield* queue.take, "other-thread");
    yield* queue.release("active-start");
    yield* queue.release("other-thread");
    const waiter = yield* queue.take.pipe(Effect.forkChild);
    yield* queue.close;
    assert.isUndefined(yield* Fiber.join(waiter));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("late", 1, true))));
  }),
);

it.effect("control bookkeeping shares its reserved slot while bulk admission is full", () =>
  Effect.gen(function* () {
    const queue = yield* makeCommandAdmission<string>({
      ordinaryEntries: 1,
      ordinaryBytes: 10,
      controlEntries: 1,
    });
    yield* queue.offer("bulk", 10, false);
    yield* queue.offer("stop", 1, true);
    assert.equal(yield* queue.take, "stop");
    yield* queue.offerContinuation("session-set", 1, "stop");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(queue.offerContinuation("another", 1, "stop"))),
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.offer("other-control", 1, true))));
    assert.equal(queue.snapshot().entries, 2);
    assert.equal(yield* queue.take, "session-set");
    yield* queue.release("session-set");
    assert.equal(queue.snapshot().entries, 2);
    yield* queue.release("stop");
    yield* queue.offer("other-control", 1, true);
    assert.equal(yield* queue.take, "other-control");
    yield* queue.release("other-control");
    assert.equal(yield* queue.take, "bulk");
    yield* queue.release("bulk");
    assert.equal(queue.snapshot().entries, 0);
  }),
);

it.effect(
  "backpressures lossless work while controls progress, and cancellation admits nothing",
  () =>
    Effect.gen(function* () {
      const queue = yield* makeCommandAdmission<string>({
        ordinaryEntries: 1,
        ordinaryBytes: 3,
        controlEntries: 1,
      });
      yield* queue.offer("A", 3, false);
      const pending = yield* queue.enqueue("B", 1).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(queue.pending(), ["A"]);
      yield* queue.offer("stop", 1, true);
      assert.equal(yield* queue.take, "stop");
      yield* queue.release("stop");
      assert.equal(yield* queue.take, "A");
      yield* queue.release("A");
      yield* Fiber.join(pending);
      assert.equal(yield* queue.take, "B");
      const cancelled = yield* queue.enqueue("C", 1).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(cancelled);
      yield* queue.release("B");
      assert.deepEqual(queue.pending(), []);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(queue.enqueue("oversize", 4))));
      yield* queue.offer("D", 1, false);
      const closing = yield* queue.enqueue("E", 1).pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* queue.close;
      assert.isTrue(Exit.isFailure(yield* Fiber.join(closing)));
      assert.deepEqual(queue.pending(), ["D"]);
    }),
);
