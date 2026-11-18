import { describe, expect, it, vi } from "vitest";
import { NotificationAdmission } from "./notificationAdmission.ts";

describe("notification admission", () => {
  it("uses configured diagnostic entry, context, and byte ceilings", () => {
    const queue = new NotificationAdmission({
      entries: 1,
      bytes: 1,
      controls: 1,
      diagnosticsPerContext: 1,
      diagnostics: 2,
      diagnosticBytes: 100,
    });
    const a = queue.reserveDiagnostic("a", 40)!;
    expect(queue.reserveDiagnostic("a", 1)).toBeUndefined();
    expect(queue.reserveDiagnostic("b", 61)).toBeUndefined();
    const b = queue.reserveDiagnostic("b", 60)!;
    expect(queue.reserveDiagnostic("c", 0)).toBeUndefined();
    expect(queue.reserve("c", 1)).toBeDefined();
    expect(queue.reserve("c", 1, "control")).toBeDefined();
    a.release();
    b.release();
    expect(queue.snapshot().diagnostics).toBe(0);
    expect(queue.reserveDiagnostic("c", 100)).toBeDefined();
  });

  it("can disable diagnostic admission without disabling lifecycle events", () => {
    const queue = new NotificationAdmission({
      entries: 1,
      bytes: 100,
      controls: 1,
      diagnostics: 0,
    });
    expect(queue.reserveDiagnostic("a", 1)).toBeUndefined();
    expect(queue.reserve("a", 1, "control")).toBeDefined();
  });

  it("rejects another context when conservative full-batch byte reservations fill the lane", () => {
    const queue = new NotificationAdmission({
      entries: 1,
      bytes: 100,
      controls: 1,
      diagnosticBytes: 34000,
    });
    const a = queue.reserveDiagnostic("a", 16900)!;
    const b = queue.reserveDiagnostic("b", 16900)!;
    expect(queue.reserveDiagnostic("c", 16900)).toBeUndefined();
    expect(queue.reserve("c", 1, "control")).toBeDefined();
    a.release();
    expect(queue.reserveDiagnostic("c", 16900)).toBeDefined();
    b.release();
  });

  it("isolates diagnostic quotas from transcript and control admission", () => {
    const queue = new NotificationAdmission({ entries: 1, bytes: 1, controls: 1 });
    const first = queue.reserveDiagnostic("a", 100)!;
    const second = queue.reserveDiagnostic("a", 100)!;
    expect(queue.reserveDiagnostic("a", 1)).toBeUndefined();
    expect(queue.reserveDiagnostic("b", 1)).toBeDefined();
    expect(queue.reserve("a", 1)).toBeDefined();
    expect(queue.reserve("a", 1, "control")).toBeDefined();
    expect(first.extend(1)).toBe(false);
    first.release();
    first.release();
    second.release();
    expect(queue.reserveDiagnostic("a", 100)).toBeDefined();
    expect(queue.snapshot()).toMatchObject({ diagnostics: 2 });
  });

  it("bounds diagnostics globally by entries and bytes, including oversized first entries", () => {
    const queue = new NotificationAdmission();
    expect(queue.reserveDiagnostic("a", 1024 * 1024 + 1)).toBeUndefined();
    expect(queue.reserveDiagnostic("a", -1)).toBeUndefined();
    const full = queue.reserveDiagnostic("a", 1024 * 1024)!;
    expect(queue.reserveDiagnostic("b", 1)).toBeUndefined();
    full.release();
    for (let index = 0; index < 64; index++) {
      expect(queue.reserveDiagnostic(String(index), 1)).toBeDefined();
    }
    expect(queue.reserveDiagnostic("another", 1)).toBeUndefined();
    expect(queue.reserve("another", 1, "control")).toBeDefined();
  });

  it("reserves control entries under entry saturation and releases each lease once", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const first = queue.reserve("a", 10)!,
      second = queue.reserve("a", 20)!;
    expect(queue.reserve("a", 1)).toBeUndefined();
    const control = queue.reserve("a", 30, "control")!;
    expect(control).toBeDefined();
    expect(queue.reserve("a", 1, "control")).toBeUndefined();
    first.release();
    first.release();
    second.release();
    control.release();
    expect(queue.snapshot()).toEqual({
      entries: 0,
      controls: 0,
      diagnostics: 0,
      bytes: 0,
      oldestAgeMs: 0,
    });
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
    const control = queue.reserve("a", 1, "control")!;
    expect(control.extend(1)).toBe(false);
    control.release();
    lease.release();
    lease.release();
    expect(lease.extend(1)).toBe(false);
    expect(queue.snapshot()).toEqual({
      entries: 0,
      controls: 0,
      diagnostics: 0,
      bytes: 0,
      oldestAgeMs: 0,
    });
  });

  it("admits one oversized valid frame alone without allowing a second allocation", () => {
    const queue = new NotificationAdmission({ entries: 2, bytes: 100, controls: 1 });
    const lease = queue.reserve("a", 1000)!;
    expect(lease).toBeDefined();
    expect(queue.reserve("b", 1)).toBeUndefined();
    expect(lease.extend(1)).toBe(false);
    const control = queue.reserve("a", 1, "control")!;
    expect(control).toBeDefined();
    control.release();
    lease.release();
    expect(queue.reserve("a", 50)).toBeDefined();
    expect(queue.reserve("a", 51)).toBeUndefined();
    expect(queue.reserve("a", -1)).toBeUndefined();
    expect(queue.reserve("a", NaN)).toBeUndefined();
  });

  it("admits small controls while an oversized control is still held", () => {
    // Codex sends a command's whole output in `item/completed`; the next item's
    // `item/started` must not be refused while that completion prepares.
    const queue = new NotificationAdmission();
    const oversized = queue.reserve("a", 1_089_492, "control")!;
    expect(oversized).toBeDefined();
    const started = queue.reserve("a", 1_300, "control")!;
    expect(started).toBeDefined();
    expect(queue.snapshot()).toMatchObject({ controls: 2, bytes: 1_090_792 });
    oversized.release();
    started.release();
    expect(queue.snapshot()).toMatchObject({ controls: 0, bytes: 0 });
  });

  it("bounds control bytes by the shared byte ceiling and control count", () => {
    const queue = new NotificationAdmission({ entries: 4, bytes: 100, controls: 3 });
    const alone = queue.reserve("a", 1000, "control")!;
    expect(alone).toBeDefined();
    expect(queue.reserve("a", 1, "control")).toBeUndefined();
    alone.release();
    const first = queue.reserve("a", 60, "control")!;
    expect(queue.reserve("a", 41, "control")).toBeUndefined();
    const second = queue.reserve("a", 40, "control")!;
    expect(second).toBeDefined();
    // Control bytes are tracked apart from data, so transcript data still flows.
    expect(queue.reserve("a", 100)).toBeDefined();
    const third = queue.reserve("b", 0, "control")!;
    expect(queue.reserve("b", 0, "control")).toBeUndefined();
    first.release();
    second.release();
    third.release();
  });

  it("always admits terminal lifecycle notifications and releases each once", () => {
    const queue = new NotificationAdmission({ entries: 1, bytes: 10, controls: 1 });
    const data = queue.reserve("a", 10)!;
    const control = queue.reserve("a", 10, "control")!;
    expect(queue.reserve("a", 1)).toBeUndefined();
    expect(queue.reserve("a", 1, "control")).toBeUndefined();
    const terminals = Array.from({ length: 3 }, () => queue.reserve("a", 1000, "terminal")!);
    expect(terminals.every(Boolean)).toBe(true);
    expect(queue.reserve("a", -1, "terminal")).toBeUndefined();
    expect(terminals[0]!.extend(1)).toBe(false);
    expect(queue.snapshot()).toMatchObject({ entries: 1, controls: 4, bytes: 3020 });
    for (const terminal of terminals) {
      terminal.release();
      terminal.release();
    }
    data.release();
    control.release();
    expect(queue.snapshot()).toEqual({
      entries: 0,
      controls: 0,
      diagnostics: 0,
      bytes: 0,
      oldestAgeMs: 0,
    });
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
