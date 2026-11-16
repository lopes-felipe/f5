import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSequenceReconciliation } from "./sequenceReconciliation";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  let sequence = 10,
    connected = true,
    onConnection: (() => void) | undefined;
  const probe = vi.fn(async () => ({ latestSequence: 10, backendIncarnation: "backend" }));
  const syncSnapshot = vi.fn(async () => {}),
    recoverIncarnation = vi.fn(async (_incarnation: string) => {});
  const waits: { target: number; signal: AbortSignal; resolve: () => void }[] = [];
  const waitForSequence = vi.fn(
    (target: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        waits.push({
          target,
          signal,
          resolve: () => {
            cleanup();
            resolve();
          },
        });
      }),
  );
  const reconciliation = startSequenceReconciliation({
    probe,
    committedSequence: () => sequence,
    incarnation: () => "backend",
    recoverIncarnation,
    waitForSequence,
    syncSnapshot,
    connected: () => connected,
    subscribeConnection: (callback) => {
      onConnection = callback;
      return () => {
        onConnection = undefined;
      };
    },
    scheduler: {
      setTimeout: (callback, delay) => setTimeout(callback, delay) as unknown as number,
      clearTimeout,
    },
    now: Date.now,
  });
  return {
    reconciliation,
    probe,
    waits,
    syncSnapshot,
    recoverIncarnation,
    waitForSequence,
    advance(value: number) {
      sequence = value;
    },
    disconnect() {
      connected = false;
      onConnection?.();
    },
  };
}

describe("fixed-target sequence reconciliation", () => {
  it("does no snapshot work when already in sync and retains the ten-minute full sync", async () => {
    const f = fixture();
    await f.reconciliation.run();
    expect(f.syncSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.syncSnapshot).toHaveBeenCalledTimes(1);
    f.reconciliation.dispose();
  });
  it("waits for the captured target while streaming continues beyond it", async () => {
    const f = fixture();
    f.probe.mockResolvedValue({ latestSequence: 12, backendIncarnation: "backend" });
    const cycle = f.reconciliation.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.waits[0]!.target).toBe(12);
    f.advance(15);
    f.waits[0]!.resolve();
    await cycle;
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.syncSnapshot).not.toHaveBeenCalled();
    f.reconciliation.dispose();
  });
  it("checks progress after a delayed probe and does not wait on an obsolete target", async () => {
    const f = fixture(),
      reply = deferred<{ latestSequence: number; backendIncarnation: string }>();
    f.probe.mockReturnValue(reply.promise);
    const cycle = f.reconciliation.run();
    f.advance(20);
    reply.resolve({ latestSequence: 15, backendIncarnation: "backend" });
    await cycle;
    expect(f.waitForSequence).not.toHaveBeenCalled();
    expect(f.syncSnapshot).not.toHaveBeenCalled();
    f.reconciliation.dispose();
  });
  it("recovers persistent lag after five seconds without re-probing", async () => {
    const f = fixture();
    f.probe.mockResolvedValue({ latestSequence: 20, backendIncarnation: "backend" });
    const cycle = f.reconciliation.run();
    await vi.advanceTimersByTimeAsync(5_000);
    await cycle;
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.syncSnapshot).toHaveBeenCalledTimes(1);
    expect(f.waits[0]!.signal.aborted).toBe(true);
    f.reconciliation.dispose();
  });
  it.each(["disconnect", "dispose"] as const)("cancels a lag wait on %s", async (action) => {
    const f = fixture();
    f.probe.mockResolvedValue({ latestSequence: 20, backendIncarnation: "backend" });
    const cycle = f.reconciliation.run();
    await Promise.resolve();
    await Promise.resolve();
    if (action === "disconnect") f.disconnect();
    else f.reconciliation.dispose();
    await cycle;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.syncSnapshot).not.toHaveBeenCalled();
    f.reconciliation.dispose();
  });
  it("ignores a late probe after disposal and cancels failed probe cycles", async () => {
    const f = fixture(),
      reply = deferred<{ latestSequence: number; backendIncarnation: string }>();
    f.probe.mockReturnValue(reply.promise);
    const cycle = f.reconciliation.run();
    f.reconciliation.dispose();
    await cycle;
    reply.resolve({ latestSequence: 1, backendIncarnation: "old" });
    await Promise.resolve();
    expect(f.recoverIncarnation).not.toHaveBeenCalled();
    const next = fixture();
    next.probe.mockRejectedValue(new Error("offline"));
    await next.reconciliation.run();
    expect(next.syncSnapshot).not.toHaveBeenCalled();
    next.reconciliation.dispose();
  });
  it("recovers an incarnation change before comparing sequence numbers", async () => {
    const f = fixture();
    f.probe.mockResolvedValue({ latestSequence: 1, backendIncarnation: "replacement" });
    await f.reconciliation.run();
    expect(f.recoverIncarnation).toHaveBeenCalledWith("replacement");
    expect(f.waitForSequence).not.toHaveBeenCalled();
    f.reconciliation.dispose();
  });
});
