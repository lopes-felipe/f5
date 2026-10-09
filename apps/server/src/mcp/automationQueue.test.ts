import { describe, expect, it, vi } from "vitest";
import { AutomationQueue } from "./automationQueue";
const make = () =>
  new AutomationQueue({
    capacity: 1,
    busy: () => "busy",
    cancelled: () => "cancelled",
    expired: () => "expired",
  });
describe("automation FIFO", () => {
  it("enforces capacity and keeps independent resources available", async () => {
    const queue = make();
    const signal = new AbortController().signal;
    const first = await queue.acquire("a", signal, 1000);
    const waiting = queue.acquire("a", signal, 1000);
    await expect(queue.acquire("a", signal, 1000)).rejects.toBe("busy");
    const other = await queue.acquire("b", signal, 1000);
    expect(other.waited).toBe(false);
    first.release();
    const next = await waiting;
    expect(next.waited).toBe(true);
    next.release();
    other.release();
  });
  it("expires or aborts before dispatch and supports flushing", async () => {
    vi.useFakeTimers();
    try {
      const queue = make();
      const controller = new AbortController();
      const active = await queue.acquire("a", controller.signal, 100);
      const expired = queue.acquire("a", controller.signal, 10);
      const check = expect(expired).rejects.toBe("expired");
      await vi.advanceTimersByTimeAsync(10);
      await check;
      const waiting = queue.acquire("a", controller.signal, 100);
      controller.abort();
      await expect(waiting).rejects.toBe("cancelled");
      const flush = queue.acquire("a", new AbortController().signal, 100);
      queue.flush("a", "stop");
      await expect(flush).rejects.toBe("stop");
      active.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
