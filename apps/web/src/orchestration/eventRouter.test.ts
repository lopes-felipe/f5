import { describe, expect, it, vi } from "vitest";
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { createOrchestrationEventRouter, type RouterSnapshot } from "./eventRouter";

const threadId = ThreadId.makeUnsafe("background");
const event = (sequence: number) =>
  ({
    sequence,
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.meta-updated",
    payload: { threadId, title: `title-${sequence}` },
  }) as OrchestrationEvent;
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let id = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const microtasks: Array<() => void> = [];
  const state = { lastAppliedSequence: 0 };
  const actions = {
    applyBatch: vi.fn((events: readonly OrchestrationEvent[]) => {
      state.lastAppliedSequence = events.at(-1)!.sequence;
    }),
    applyEvent: vi.fn((next: OrchestrationEvent) => {
      state.lastAppliedSequence = next.sequence;
    }),
    onGap: vi.fn(),
    onResynchronizing: vi.fn(),
    onSynchronized: vi.fn(),
    onRecoveryError: vi.fn(),
    repairThreads: vi.fn(),
    logPoison: vi.fn(),
  };
  const snapshot = (sequence: number): RouterSnapshot => ({
    sequence,
    provisional: false,
    merge: () => {
      state.lastAppliedSequence = sequence;
    },
    finish: async () => {},
  });
  const readSnapshot = vi.fn(async () => snapshot(1));
  const router = createOrchestrationEventRouter({
    api: { readSnapshot },
    actions,
    now: () => 0,
    scheduler: {
      raf: (callback) => {
        frames.set(++id, callback);
        return id;
      },
      cancelRaf: (key) => {
        frames.delete(key);
      },
      setTimeout: (callback, delay) => {
        timers.set(++id, { callback, delay });
        return id;
      },
      clearTimeout: (key) => {
        timers.delete(key);
      },
      queueMicrotask: (callback) => {
        microtasks.push(callback);
      },
    },
  });
  const flushMicrotasks = async () => {
    for (const callback of microtasks.splice(0)) callback();
    await settle();
  };
  return {
    router,
    actions,
    readSnapshot,
    snapshot,
    frames,
    timers,
    microtasks,
    flushMicrotasks,
    state,
  };
}

describe("orchestration event router", () => {
  it("immediately replaces a snapshot invalidated by a welcome without retry backoff", async () => {
    const f = fixture(),
      pending = deferred<RouterSnapshot>();
    f.readSnapshot.mockReturnValueOnce(pending.promise);
    f.readSnapshot.mockResolvedValueOnce(f.snapshot(2));
    const stale = f.snapshot(1);
    const merge = vi.spyOn(stale, "merge");
    const syncing = f.router.syncSnapshot();
    f.router.invalidateSnapshot();
    await f.router.syncSnapshot();
    pending.resolve(stale);
    await syncing;
    expect(merge).not.toHaveBeenCalled();
    expect(f.router.hasSnapshotRetry).toBe(false);
    await f.flushMicrotasks();
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    expect(f.router.committedSequence).toBe(2);
    expect(f.actions.onSynchronized).toHaveBeenCalledTimes(1);
    f.router.dispose();
  });

  it("batches in-order events and advances only its committed stream cursor", async () => {
    const f = fixture();
    f.router.receive(event(1));
    f.router.receive(event(2));
    expect(f.router.latestSequence).toBe(2);
    expect(f.router.committedSequence).toBe(0);
    const committed = f.router.waitForCommittedSequence(2);
    [...f.frames.values()][0]!();
    await committed;
    expect(f.actions.applyBatch).toHaveBeenCalledWith([event(1), event(2)]);
    expect(f.router.committedSequence).toBe(2);
    expect(f.timers.size).toBe(0);
    f.router.dispose();
  });
  it("buffers a gap and drains ordered unique events after the snapshot", async () => {
    const f = fixture(),
      pending = deferred<RouterSnapshot>();
    f.readSnapshot.mockReturnValueOnce(pending.promise);
    f.router.receive(event(3));
    f.router.receive(event(2));
    f.router.receive(event(3));
    pending.resolve(f.snapshot(1));
    await settle();
    expect(f.actions.onGap).toHaveBeenCalledTimes(1);
    expect(f.actions.applyEvent.mock.calls.map(([e]) => e.sequence)).toEqual([2, 3]);
    expect(f.router.committedSequence).toBe(3);
    f.router.dispose();
  });
  it("bounds an overflowing recovery buffer and refetches the invalidated snapshot", async () => {
    const f = fixture(),
      pending = deferred<RouterSnapshot>();
    f.readSnapshot.mockReturnValueOnce(pending.promise);
    f.router.receive(event(2));
    for (let i = 3; i <= 2002; i++) f.router.receive(event(i));
    pending.resolve(f.snapshot(1));
    await settle();
    expect(f.actions.applyEvent).not.toHaveBeenCalled();
    const retry = [...f.timers.values()].find((timer) => timer.delay === 1000)!;
    expect(retry).toBeDefined();
    f.readSnapshot.mockResolvedValueOnce(f.snapshot(2002));
    retry.callback();
    await settle();
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    expect(f.router.committedSequence).toBe(2002);
    f.router.dispose();
  });
  it("flushes through the timeout when a hidden tab never runs rAF", () => {
    const f = fixture();
    f.router.receive(event(1));
    [...f.timers.values()][0]!.callback();
    expect(f.router.committedSequence).toBe(1);
    expect(f.frames.size).toBe(0);
    f.router.dispose();
  });
  it("drops poison, recovers once, repairs a background thread, and applies later events", async () => {
    const f = fixture();
    f.actions.applyBatch.mockImplementationOnce(() => {
      throw new Error("poison");
    });
    f.router.receive(event(1));
    expect(() => f.router.flushPending()).not.toThrow();
    expect(f.router.poisonBatches).toBe(1);
    f.router.flushPending();
    f.router.flushPending();
    await f.flushMicrotasks();
    expect(f.readSnapshot).toHaveBeenCalledTimes(1);
    expect(f.actions.repairThreads).toHaveBeenCalledWith(new Set([threadId]));
    expect(f.actions.logPoison).toHaveBeenCalledTimes(1);
    f.router.receive(event(2));
    f.router.flushPending();
    expect(f.router.committedSequence).toBe(2);
    f.router.dispose();
  });
  it("does not duplicate recovery when reconcile starts a snapshot before the microtask", async () => {
    const f = fixture();
    f.actions.applyBatch.mockImplementationOnce(() => {
      throw new Error("poison");
    });
    f.router.receive(event(1));
    await f.router.syncSnapshot();
    await f.flushMicrotasks();
    expect(f.readSnapshot).toHaveBeenCalledTimes(1);
    f.router.dispose();
  });
  it("drains pushes received during deferred snapshot finalization", async () => {
    const f = fixture();
    const finish = deferred<void>();
    f.readSnapshot.mockResolvedValueOnce({ ...f.snapshot(1), finish: () => finish.promise });
    const syncing = f.router.syncSnapshot();
    await settle();
    expect(f.actions.onSynchronized).not.toHaveBeenCalled();
    f.router.receive(event(2));
    finish.resolve();
    await syncing;
    expect(f.actions.applyEvent).toHaveBeenCalledWith(event(2));
    expect(f.router.committedSequence).toBe(2);
    expect(f.actions.onSynchronized).toHaveBeenCalledTimes(1);
    expect(f.router.hasSnapshotRetry).toBe(false);
    f.router.dispose();
  });
  it("immediately recovers poison encountered while draining a snapshot", async () => {
    const f = fixture();
    const pending = deferred<RouterSnapshot>();
    f.readSnapshot.mockReturnValueOnce(pending.promise);
    f.actions.applyEvent.mockImplementationOnce(() => {
      throw new Error("poison");
    });
    const syncing = f.router.syncSnapshot();
    f.router.receive(event(2));
    pending.resolve(f.snapshot(1));
    await syncing;
    expect(f.router.hasSnapshotRetry).toBe(false);
    await f.flushMicrotasks();
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    f.router.dispose();
  });
  it("resets stream cursors for a lower-head replacement and rejects an old snapshot", async () => {
    const f = fixture();
    f.readSnapshot.mockResolvedValueOnce(f.snapshot(120));
    await f.router.syncSnapshot();
    const pending = deferred<RouterSnapshot>();
    f.readSnapshot.mockReturnValueOnce(pending.promise);
    const oldSync = f.router.syncSnapshot();
    f.router.resetStream();
    pending.resolve(f.snapshot(121));
    await oldSync;
    f.readSnapshot.mockResolvedValueOnce(f.snapshot(1));
    await f.flushMicrotasks();
    f.router.receive(event(2));
    f.router.flushPending();
    expect(f.router.committedSequence).toBe(2);
    expect(f.state.lastAppliedSequence).toBe(2);
    f.router.dispose();
  });
  it("opens the reload breaker after three poison batches and stops automatic resync", async () => {
    const f = fixture();
    f.actions.applyBatch.mockImplementation(() => {
      throw new Error("poison");
    });
    for (let sequence = 1; sequence <= 3; sequence++) {
      f.readSnapshot.mockResolvedValueOnce(f.snapshot(sequence));
      f.router.receive(event(sequence));
      f.router.flushPending();
      await f.flushMicrotasks();
    }
    expect(f.router.breakerOpen).toBe(true);
    expect(f.actions.onRecoveryError).toHaveBeenCalledTimes(1);
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    await f.router.syncSnapshot();
    f.router.receive(event(4));
    f.router.flushPending();
    expect(f.readSnapshot).toHaveBeenCalledTimes(2);
    f.router.dispose();
  });
  it("does not run a queued recovery microtask after disposal", async () => {
    const f = fixture();
    f.actions.applyBatch.mockImplementationOnce(() => {
      throw new Error("poison");
    });
    f.router.receive(event(1));
    f.router.flushPending();
    f.router.dispose();
    await f.flushMicrotasks();
    expect(f.readSnapshot).not.toHaveBeenCalled();
    expect(f.timers.size + f.frames.size).toBe(0);
  });
  it("releases commit waiters on abort and disposal", async () => {
    const f = fixture(),
      controller = new AbortController();
    const aborted = expect(
      f.router.waitForCommittedSequence(10, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    const disposed = expect(f.router.waitForCommittedSequence(20)).rejects.toMatchObject({
      name: "AbortError",
    });
    f.router.dispose();
    await disposed;
  });
});
