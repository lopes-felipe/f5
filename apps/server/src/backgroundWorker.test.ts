import { Deferred, Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { enqueueBackgroundWork, makeBackgroundWorker } from "./backgroundWorker.ts";

it.each(["closed", "item-failed"])(
  "settles a detached flush timer after worker %s without a rejected Promise",
  async (phase) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* makeBackgroundWorker(
              (_item: number) => (phase === "item-failed" ? Effect.die("item died") : Effect.void),
              { name: "flush-admission" },
            );
            if (phase === "closed") yield* worker.close;
            else {
              yield* worker.enqueue(0);
              expect(Exit.isSuccess(yield* Effect.exit(worker.drain))).toBe(true);
            }
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) =>
                  setTimeout(() => {
                    enqueueBackgroundWork(worker.enqueue(1));
                    setImmediate(resolve);
                  }, 0),
                ),
            );
            expect(unhandled).not.toHaveBeenCalled();
            if (phase === "item-failed") {
              yield* worker.drain;
              expect((yield* worker.snapshot).failures).toBe(2);
            }
          }),
        ),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  },
);

it("sizes items only for workers with a byte ceiling", async () => {
  const serialized = vi.fn(() => "x".repeat(10));
  const item = { toJSON: serialized };
  const snapshots = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Items stay accounted until processed, so hold them while reading snapshots.
        const gate = yield* Deferred.make<void>();
        const hold = (_item: typeof item) => Deferred.await(gate);
        const lossless = yield* makeBackgroundWorker(hold, { name: "lossless" });
        const rejecting = yield* makeBackgroundWorker(hold, {
          name: "rejecting",
          admission: "reject",
        });
        yield* lossless.enqueue(item);
        expect(serialized).not.toHaveBeenCalled();
        yield* rejecting.enqueue(item);
        expect(serialized).toHaveBeenCalledTimes(1);
        const result = [yield* lossless.snapshot, yield* rejecting.snapshot];
        yield* Deferred.succeed(gate, undefined);
        return result;
      }),
    ),
  );
  // Lossless byte accounting counts entries; the byte ceiling counts JSON bytes.
  expect(snapshots.map((snapshot) => snapshot.bytes)).toEqual([1, 12]);
});
