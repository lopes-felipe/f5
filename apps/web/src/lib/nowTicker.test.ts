import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getNowSnapshot, isNowTickerRunning, subscribeNow } from "./nowTicker";

describe("nowTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("starts on the first subscriber and stops after the last", () => {
    expect(isNowTickerRunning()).toBe(false);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeNow(first);
    const unsubscribeSecond = subscribeNow(second);
    expect(isNowTickerRunning()).toBe(true);

    vi.advanceTimersByTime(3_000);
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);

    unsubscribeFirst();
    unsubscribeFirst();
    expect(isNowTickerRunning()).toBe(true);
    unsubscribeSecond();
    expect(isNowTickerRunning()).toBe(false);
    vi.advanceTimersByTime(3_000);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("returns the cached tick between ticks rather than the current time", () => {
    const unsubscribe = subscribeNow(() => {});
    const started = getNowSnapshot();
    vi.advanceTimersByTime(400);
    expect(getNowSnapshot()).toBe(started);
    expect(getNowSnapshot()).toBe(getNowSnapshot());
    vi.advanceTimersByTime(600);
    expect(getNowSnapshot()).toBe(started + 1_000);
    unsubscribe();
  });

  it("serves a fresh value to a first subscriber that reads before subscribing", () => {
    subscribeNow(() => {})();
    const stale = getNowSnapshot();
    vi.setSystemTime(new Date("2026-10-01T01:00:00.000Z"));
    const fresh = getNowSnapshot();
    expect(fresh).toBe(stale + 60 * 60 * 1000);
    expect(getNowSnapshot()).toBe(fresh);
  });

  it("refreshes the snapshot when the ticker restarts", () => {
    subscribeNow(() => {})();
    const before = getNowSnapshot();
    vi.setSystemTime(new Date("2026-10-01T01:00:00.000Z"));
    const unsubscribe = subscribeNow(() => {});
    expect(getNowSnapshot()).toBe(before + 60 * 60 * 1000);
    unsubscribe();
  });
});
