import { describe, expect, it, vi } from "vitest";
import { NotificationAdmission } from "./notificationAdmission.ts";

describe("notification admission", () => {
  it("reserves control entries under entry saturation and releases each lease once", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const first = queue.reserve("a", 10)!,
      second = queue.reserve("a", 20)!;
    expect(queue.reserve("a", 1)).toBeUndefined();
    const control = queue.reserve("a", 30, true)!;
    expect(control).toBeDefined();
    expect(queue.reserve("a", 1, true)).toBeUndefined();
    first.release();
    first.release();
    second.release();
    control.release();
    expect(queue.snapshot()).toEqual({ entries: 0, controls: 0, bytes: 0, oldestAgeMs: 0 });
  });

  it("gives each context its own entry quota under a global entry ceiling", () => {
    const queue = new NotificationAdmission({
      entries: 2,
      bytes: 1000,
      controls: 1,
      globalEntries: 3,
    });
    queue.reserve("a", 1);
    const held = queue.reserve("a", 1)!;
    expect(queue.reserve("a", 1)).toBeUndefined();
    expect(queue.reserve("b", 1)).toBeDefined();
    expect(queue.reserve("c", 1)).toBeUndefined();
    held.release();
    expect(queue.reserve("a", 1)).toBeDefined();
    expect(queue.snapshot().entries).toBe(3);
  });

  it("extends a data lease by bytes only, within the byte limit and while held", () => {
    const queue = new NotificationAdmission({ entries: 1, bytes: 100, controls: 1 });
    const lease = queue.reserve("a", 10)!;
    expect(lease.extend(40)).toBe(true);
    expect(queue.snapshot()).toMatchObject({ entries: 1, bytes: 50 });
    expect(lease.extend(51)).toBe(false);
    expect(lease.extend(-1)).toBe(false);
    expect(lease.extend(Number.NaN)).toBe(false);
    const control = queue.reserve("a", 1, true)!;
    expect(control.extend(1)).toBe(false);
    control.release();
    lease.release();
    lease.release();
    expect(lease.extend(1)).toBe(false);
    expect(queue.snapshot()).toEqual({ entries: 0, controls: 0, bytes: 0, oldestAgeMs: 0 });
  });

  it("admits one oversized valid frame alone without allowing a second allocation", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const lease = queue.reserve("a", 1000)!;
    expect(lease).toBeDefined();
    expect(queue.reserve("b", 1)).toBeUndefined();
    expect(lease.extend(1)).toBe(false);
    const control = queue.reserve("a", 1, true)!;
    expect(control).toBeDefined();
    control.release();
    lease.release();
    expect(queue.reserve("a", 50)).toBeDefined();
    expect(queue.reserve("a", 51)).toBeUndefined();
    expect(queue.reserve("a", -1)).toBeUndefined();
    expect(queue.reserve("a", NaN)).toBeUndefined();
  });

  it("counts active preparation, not just queued callbacks, and tracks oldest age", () => {
    vi.useFakeTimers();
    try {
      const queue = new NotificationAdmission();
      const first = queue.reserve("a", 10)!;
      vi.advanceTimersByTime(100);
      const second = queue.reserve("b", 20)!;
      vi.advanceTimersByTime(100);
      expect(queue.snapshot()).toMatchObject({ entries: 2, bytes: 30, oldestAgeMs: 200 });
      first.release();
      expect(queue.snapshot().oldestAgeMs).toBe(100);
      second.release();
      expect(queue.snapshot().oldestAgeMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
