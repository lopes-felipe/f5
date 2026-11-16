import { expect, it, vi } from "vitest";
import { Deferred, Effect } from "effect";
import { makeShutdownSourceScope, ServerShutdown, ShutdownRegistry } from "./shutdown.ts";

it("shares an absolute deadline, runs phases in order, and settles incomplete work", async () => {
  vi.useFakeTimers();
  try {
    const shutdown = new ShutdownRegistry();
    const order: string[] = [];
    const deadlines: number[] = [];
    const add = (
      name: string,
      phase: "admission" | "flush" | "producers" | "drain",
      work = async () => {},
    ) =>
      shutdown.register({
        name,
        phase,
        run: async (deadline) => {
          deadlines.push(deadline);
          order.push(name);
          await work();
        },
      });
    add("admission", "admission");
    add("history", "flush", () => new Promise((resolve) => setTimeout(resolve, 200)));
    add("logs", "flush");
    add("provider", "producers", () => new Promise(() => {}));
    add("ingestion", "drain");
    const work = shutdown.run();
    expect(shutdown.run()).toBe(work);
    await vi.advanceTimersByTimeAsync(1800);
    const results = await work;
    expect(deadlines.slice(0, 4)).toEqual(Array(4).fill(shutdown.deadline! - 450));
    expect(deadlines[4]).toBe(shutdown.deadline! - 150);
    expect(order).toEqual(["admission", "history", "logs", "provider", "ingestion"]);
    expect(results.find((step) => step.name === "provider")?.outcome).toBe("incomplete");
    expect(results.find((step) => step.name === "ingestion")?.outcome).toBe("complete");
  } finally {
    vi.useRealTimers();
  }
});

it("drains causal consumers after upstream final events, even if registered first", async () => {
  const shutdown = new ShutdownRegistry();
  const order: string[] = [];
  const upstream = Promise.withResolvers<void>();
  let ingestion = 0,
    checkpoints = 0;
  shutdown.register({
    name: "checkpoints",
    phase: "drain",
    after: ["ingestion"],
    run: async () => {
      order.push("checkpoints");
      expect(ingestion).toBe(0);
      expect(checkpoints).toBe(1);
      checkpoints--;
    },
  });
  shutdown.register({
    name: "ingestion",
    phase: "drain",
    after: ["provider"],
    run: async () => {
      order.push("ingestion");
      expect(ingestion).toBe(1);
      ingestion--;
      checkpoints++;
    },
  });
  shutdown.register({
    name: "provider",
    phase: "drain",
    run: async () => {
      order.push("provider");
      await upstream.promise;
      ingestion++;
    },
  });
  const work = shutdown.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual(["provider"]);
  upstream.resolve();
  const results = await work;
  expect(results.every((result) => result.outcome === "complete")).toBe(true);
  expect(order).toEqual(["provider", "ingestion", "checkpoints"]);
  expect(checkpoints).toBe(0);
});
it("reports cyclic drain dependencies instead of hanging teardown", async () => {
  const shutdown = new ShutdownRegistry();
  const run = vi.fn(async () => {});
  shutdown.register({ name: "a", phase: "drain", after: ["b"], run });
  shutdown.register({ name: "b", phase: "drain", after: ["a"], run });
  const results = await shutdown.run();
  expect(results.map((result) => result.outcome)).toEqual(["failed", "failed"]);
  expect(run).not.toHaveBeenCalled();
});

it("stops source subscriptions and retry timers before producer shutdown", async () => {
  const shutdown = new ShutdownRegistry();
  let retired = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sources = yield* makeShutdownSourceScope("workflow-sources");
        const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        for (const signal of entered)
          yield* Effect.forkIn(sources.scope)(
            Deferred.succeed(signal, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  retired++;
                }),
              ),
            ),
          );
        yield* Effect.all(entered.map(Deferred.await));
        shutdown.register({
          name: "producer",
          phase: "producers",
          run: async () => {
            expect(sources.stopped).toBe(true);
            expect(retired).toBe(2);
          },
        });
        const results = yield* Effect.promise(() => shutdown.run());
        expect(results.every((result) => result.outcome === "complete")).toBe(true);
        yield* sources.stop;
        expect(retired).toBe(2);
      }),
    ).pipe(Effect.provideService(ServerShutdown, shutdown)),
  );
});

it("reserves drain and final-log time even when an earlier phase hangs", async () => {
  vi.useFakeTimers();
  try {
    const shutdown = new ShutdownRegistry();
    const budgets: number[] = [];
    for (const phase of ["admission", "drain", "logs"] as const)
      shutdown.register({
        name: phase,
        phase,
        run: async (deadline) => {
          budgets.push(deadline - Date.now());
          return new Promise(() => {});
        },
      });
    const work = shutdown.run();
    await vi.advanceTimersByTimeAsync(1800);
    expect(budgets).toEqual([1350, 300, 150]);
    expect((await work).map((r) => r.outcome)).toEqual(["incomplete", "incomplete", "incomplete"]);
  } finally {
    vi.useRealTimers();
  }
});
