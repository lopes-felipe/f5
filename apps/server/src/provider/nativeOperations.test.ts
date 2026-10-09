import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import {
  ThreadId,
  type NativeOperationInput,
  type NativeOperationRecord,
} from "@t3tools/contracts";
import {
  makeNativeOperationCoordinator,
  nativeOperationSqlRepository,
  hasNativeOperationReservation,
  type NativeOperationRepository,
} from "./nativeOperations.ts";
import { withProviderThreadAccess } from "./providerThreadAccess.ts";

function harness() {
  const records = new Map<string, NativeOperationRecord>();
  const states: string[] = [];
  const repository: NativeOperationRepository = {
    get: (id) => Effect.sync(() => records.get(id)),
    list: (threadId) =>
      Effect.sync(() =>
        [...records.values()].filter((record) => !threadId || record.threadId === threadId),
      ),
    save: (record) =>
      Effect.sync(() => {
        records.set(record.operationId, { ...record });
        states.push(record.state);
      }),
  };
  const input: NativeOperationInput = {
    threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
    operationId: crypto.randomUUID(),
    generation: 1,
    command: { kind: "compact" },
  };
  return {
    input,
    states,
    records,
    coordinator: makeNativeOperationCoordinator(repository),
    repository,
  };
}
const callbacks = {
  validate: Effect.void,
  generation: Effect.succeed(1),
  dispatch: Effect.succeed({ nativeTurnId: "control-turn" }),
};

describe("native operation coordinator", () => {
  it("persists ordered receipts before dispatch and applies under the shared reentrant lock", async () => {
    const h = harness();
    let applied = false;
    const result = await Effect.runPromise(
      h.coordinator.execute(h.input, {
        ...callbacks,
        dispatch: Effect.sync(() => {
          expect(h.states).toEqual(["requested", "dispatched", "running"]);
          expect(hasNativeOperationReservation(h.input.threadId)).toBe(true);
          return { nativeTurnId: "native" };
        }),
        apply: () =>
          withProviderThreadAccess(
            h.input.threadId,
            Effect.sync(() => {
              applied = true;
            }),
          ),
      }),
    );
    expect(result.state).toBe("completed");
    expect(applied).toBe(true);
    expect(hasNativeOperationReservation(h.input.threadId)).toBe(false);
    expect(h.states).toEqual([
      "requested",
      "dispatched",
      "running",
      "running",
      "running",
      "completed",
    ]);
  });
  it("returns an existing receipt without dispatching twice and refuses identifier reuse", async () => {
    const h = harness();
    let calls = 0;
    const cb = { ...callbacks, dispatch: Effect.sync(() => ++calls) };
    await Effect.runPromise(h.coordinator.execute(h.input, cb));
    await Effect.runPromise(h.coordinator.execute(h.input, cb));
    expect(calls).toBe(1);
    await expect(
      Effect.runPromise(
        h.coordinator.execute(
          { ...h.input, command: { kind: "review", target: { type: "uncommittedChanges" } } },
          cb,
        ),
      ),
    ).rejects.toThrow("different request");
  });
  it("excludes another operation while allowing approval work through the thread lock", async () => {
    const h = harness();
    let settle!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = Effect.runPromise(
      h.coordinator.execute(h.input, {
        ...callbacks,
        dispatch: Effect.promise(() => {
          entered();
          return new Promise((resolve) => {
            settle = resolve;
          });
        }),
      }),
    );
    await started;
    await expect(
      Effect.runPromise(
        h.coordinator.execute({ ...h.input, operationId: crypto.randomUUID() }, callbacks),
      ),
    ).rejects.toThrow("still pending");
    expect(
      await Effect.runPromise(
        withProviderThreadAccess(h.input.threadId, Effect.succeed("approval")),
      ),
    ).toBe("approval");
    settle({});
    await pending;
  });
  it("records an older-generation result without applying it", async () => {
    const h = harness();
    let generation = 1;
    let applied = false;
    const result = await Effect.runPromise(
      h.coordinator.execute(h.input, {
        ...callbacks,
        generation: Effect.sync(() => generation),
        dispatch: Effect.sync(() => {
          generation = 2;
          return {};
        }),
        apply: () =>
          Effect.sync(() => {
            applied = true;
          }),
      }),
    );
    expect(result.staleGeneration).toBe(true);
    expect(applied).toBe(false);
  });
  it("keeps an uncertain dispatch reserved until provider reconciliation proves its outcome", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      h.coordinator.execute(h.input, {
        ...callbacks,
        dispatch: Effect.fail(new Error("Response lost")),
      }),
    );
    expect(result.state).toBe("indeterminate");
    expect(hasNativeOperationReservation(h.input.threadId)).toBe(true);
    const restarted = makeNativeOperationCoordinator(h.repository);
    await Effect.runPromise(restarted.reconcile(() => Effect.succeed({ state: "completed" })));
    expect(hasNativeOperationReservation(h.input.threadId)).toBe(false);
    expect(h.records.get(h.input.operationId)?.state).toBe("completed");
  });
  it("cancels a requested operation at startup without sending it", async () => {
    const h = harness();
    const at = new Date().toISOString();
    h.records.set(h.input.operationId, {
      ...h.input,
      state: "requested",
      createdAt: at,
      updatedAt: at,
    });
    let checked = false;
    await Effect.runPromise(
      h.coordinator.reconcile(() =>
        Effect.sync(() => {
          checked = true;
          return { state: "indeterminate" };
        }),
      ),
    );
    expect(checked).toBe(false);
    expect(h.records.get(h.input.operationId)?.state).toBe("cancelled");
  });
  it("records shutdown while awaiting a provider and preserves the reservation", async () => {
    const h = harness();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fiber = Effect.runFork(
      h.coordinator.execute(h.input, {
        ...callbacks,
        dispatch: Effect.sync(entered).pipe(Effect.andThen(Effect.never)),
      }),
    );
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(h.records.get(h.input.operationId)?.state).toBe("indeterminate");
    await Effect.runPromise(h.coordinator.reconcile(() => Effect.succeed({ state: "failed" })));
  });
  it("leaves the conversation untouched when a file rewind is refused", async () => {
    const h = harness();
    let applied = false;
    const result = await Effect.runPromise(
      h.coordinator.execute(h.input, {
        ...callbacks,
        dispatch: Effect.succeed({ canRewind: false, error: "No backups" }),
        apply: () =>
          Effect.sync(() => {
            applied = true;
          }),
      }),
    );
    expect(result.state).toBe("failed");
    expect(applied).toBe(false);
    expect(hasNativeOperationReservation(h.input.threadId)).toBe(false);
  });
});

it("does not inherit reentrant lock ownership into a child fiber", async () => {
  const id = crypto.randomUUID();
  let childEntered = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* withProviderThreadAccess(
          id,
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(
              withProviderThreadAccess(
                id,
                Effect.sync(() => {
                  childEntered = true;
                }),
              ),
            );
            yield* Effect.yieldNow;
            expect(childEntered).toBe(false);
            return fiber;
          }),
        );
        yield* Fiber.join(child);
        expect(childEntered).toBe(true);
      }),
    ),
  );
});

it("persists the provider receipt before waiting for completion", async () => {
  const h = harness();
  const result = await Effect.runPromise(
    h.coordinator.execute(h.input, {
      ...callbacks,
      dispatchWithReceipt: (receipt) =>
        Effect.gen(function* () {
          yield* receipt({ nativeTurnId: "turn" });
          expect(h.records.get(h.input.operationId)?.receipt).toEqual({ nativeTurnId: "turn" });
          return { nativeTurnId: "turn" };
        }),
    }),
  );
  expect(result.receipt).toEqual({ nativeTurnId: "turn" });
  expect(result.state).toBe("completed");
});

it("does not claim completion after a crash between provider settlement and application", async () => {
  const h = harness();
  const at = new Date().toISOString();
  h.records.set(h.input.operationId, {
    ...h.input,
    state: "running",
    applicationRequired: true,
    result: { nativeTurnId: "turn" },
    createdAt: at,
    updatedAt: at,
  });
  await Effect.runPromise(h.coordinator.reconcile(() => Effect.succeed({ state: "completed" })));
  expect(h.records.get(h.input.operationId)?.state).toBe("indeterminate");
  expect(hasNativeOperationReservation(h.input.threadId)).toBe(true);
});

it("refuses a native file rewind reporting an error even when canRewind is true", async () => {
  const h = harness();
  let applied = false;
  const result = await Effect.runPromise(
    h.coordinator.execute(
      { ...h.input, command: { kind: "revertFiles", userMessageId: "uuid" } },
      {
        ...callbacks,
        dispatch: Effect.succeed({ canRewind: true, error: "Backups missing" }),
        apply: () =>
          Effect.sync(() => {
            applied = true;
          }),
      },
    ),
  );
  expect(result.state).toBe("failed");
  expect(applied).toBe(false);
});

it("restores running SQL receipts and enforces the durable per-thread reservation", async () => {
  const { SqlClient } = await import("effect/unstable/sql/SqlClient");
  const { SqlitePersistenceMemory } = await import("../persistence/Layers/Sqlite.ts");
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const repository = nativeOperationSqlRepository(sql);
      const h = harness();
      const at = new Date().toISOString();
      const record = {
        ...h.input,
        state: "running" as const,
        receipt: { nativeTurnId: "persisted" },
        createdAt: at,
        updatedAt: at,
      };
      yield* repository.save(record);
      const restored = makeNativeOperationCoordinator(repository);
      yield* restored.reconcile((operation) => {
        expect(operation.receipt).toEqual({ nativeTurnId: "persisted" });
        return Effect.succeed({ state: "indeterminate" as const });
      });
      expect(hasNativeOperationReservation(record.threadId)).toBe(true);
      const duplicate = yield* Effect.result(
        repository.save({ ...record, operationId: crypto.randomUUID() }),
      );
      expect(duplicate._tag).toBe("Failure");
      yield* restored.reconcile(() => Effect.succeed({ state: "completed" as const }));
      expect((yield* repository.get(record.operationId))?.state).toBe("completed");
      expect(hasNativeOperationReservation(record.threadId)).toBe(false);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
