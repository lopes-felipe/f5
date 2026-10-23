import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Exit, Option, Scope } from "effect";
import { expect, it } from "vitest";
import {
  makeProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "./ProviderContinuationRequests.ts";
const request = (id: string, clearIfCurrent = Effect.void): ProviderContinuationRequest => ({
  requestId: id,
  threadId: ThreadId.make(id),
  providerInstanceId: ProviderInstanceId.make("pi"),
  generation: "generation",
  createdAt: 100,
  previousTurnId: TurnId.make("previous"),
  runtimeMode: "approval-required",
  model: "default",
  status: Effect.succeed("pending"),
  dispatchIfCurrent: (effect) => effect.pipe(Effect.map(Option.some)),
  clearIfCurrent,
});
it("deduplicates an exact offer and fences a replacement while its predecessor is in flight", async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeProviderContinuationRequests;
        const first = request("thread");
        expect(yield* broker.offer(first)).toBe(true);
        expect(yield* broker.offer(first)).toBe(true);
        expect(yield* broker.take).toBe(first);
        const replacement = request("thread");
        expect(yield* broker.offer(replacement)).toBe(false);
        yield* broker.settle(replacement);
        expect(yield* broker.offer(replacement)).toBe(false);
        yield* broker.settle(first);
        expect(yield* broker.offer(replacement)).toBe(true);
        expect(yield* broker.take).toBe(replacement);
      }),
    ),
  ));
it("bounds queued and in-flight requests together and reclaims their native owner on close", async () => {
  let cleared = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const owner = yield* Scope.make("sequential");
      const broker = yield* makeProviderContinuationRequests.pipe(Scope.provide(owner));
      for (let i = 0; i < 64; i++) {
        expect(
          yield* broker.offer(
            request(
              `thread-${i}`,
              Effect.sync(() => {
                cleared++;
              }),
            ),
          ),
        ).toBe(true);
        yield* broker.take;
      }
      expect(yield* broker.offer(request("overflow"))).toBe(false);
      yield* Scope.close(owner, Exit.void);
      expect(cleared).toBe(64);
      expect(yield* broker.offer(request("closed"))).toBe(false);
    }),
  );
});

it("allows a subsequent wake after adoption without an old settlement removing the new owner", async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeProviderContinuationRequests;
        let adopted = false;
        const old = {
          ...request("thread"),
          status: Effect.sync(() => (adopted ? ("adopted" as const) : ("pending" as const))),
        };
        yield* broker.offer(old);
        yield* broker.take;
        adopted = true;
        const next = request("thread");
        expect(yield* broker.offer(next)).toBe(true);
        yield* broker.settle(old);
        expect(yield* broker.offer(request("thread"))).toBe(false);
        expect(yield* broker.take).toBe(next);
      }),
    ),
  ));
