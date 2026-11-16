import { ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { makeQueueRetryScheduler } from "./retryScheduler.ts";
afterEach(() => vi.useRealTimers());
it("coalesces storms at the earliest wakeup and releases unrelated threads fairly", async () => {
  vi.useFakeTimers();
  const wake = vi.fn(),
    retries = makeQueueRetryScheduler(wake);
  const a = ThreadId.makeUnsafe("a"),
    b = ThreadId.makeUnsafe("b");
  for (let index = 0; index < 100; index++) retries.schedule(a, 1000 + index);
  retries.schedule(a, 500);
  retries.schedule(b, 250);
  expect(retries.size).toBe(2);
  expect(vi.getTimerCount()).toBe(2);
  await vi.advanceTimersByTimeAsync(250);
  expect(wake).toHaveBeenCalledExactlyOnceWith(b);
  await vi.advanceTimersByTimeAsync(250);
  expect(wake.mock.calls).toEqual([[b], [a]]);
  expect(retries.size).toBe(0);
  retries.dispose();
});
it("cancels paused/deleted generations, supports rearming and leaves no timers after disposal", async () => {
  vi.useFakeTimers();
  const wake = vi.fn(),
    retries = makeQueueRetryScheduler(wake),
    a = ThreadId.makeUnsafe("a");
  retries.schedule(a, 100);
  retries.cancel(a);
  retries.schedule(a, 200);
  await vi.advanceTimersByTimeAsync(100);
  expect(wake).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(wake).toHaveBeenCalledOnce();
  retries.schedule(a, 100);
  retries.dispose();
  retries.dispose();
  retries.schedule(a, 1);
  await vi.advanceTimersByTimeAsync(500);
  expect(wake).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
