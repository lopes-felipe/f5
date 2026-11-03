import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentTranscriptRequest, settleAgentTranscript } from "./agentTranscriptRequests";

afterEach(() => vi.useRealTimers());
describe("transcript settlement", () => {
  it("waits for a drain longer than the retry window before scheduling retries", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const deferred = new Promise<void>((done) => {
      resolve = done;
    });
    const active = runAgentTranscriptRequest("slow", () => deferred);
    const refresh = vi.fn(async () => {});
    const done = vi.fn();
    const cancel = settleAgentTranscript({
      drain: () => runAgentTranscriptRequest("slow", refresh),
      refresh,
      onSettled: done,
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).not.toHaveBeenCalled();
    resolve();
    await active;
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const delay of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(delay);
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(done).toHaveBeenCalledOnce();
    cancel();
  });
  it("cancels while waiting for a drain or retry timer", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const deferred = new Promise<void>((done) => {
      resolve = done;
    });
    const refresh = vi.fn(async () => {});
    const cancel = settleAgentTranscript({ drain: () => deferred, refresh });
    cancel();
    resolve();
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).not.toHaveBeenCalled();
    const cancelTimer = settleAgentTranscript({ drain: async () => {}, refresh });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    cancelTimer();
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
