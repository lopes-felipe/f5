import { describe, expect, it, vi } from "vitest";

import { createAppToastManager } from "./toast";
import {
  defaultToastTimeout,
  formatToastAge,
  resolveToastTopOffset,
  toastDedupeKey,
} from "./toast.logic";

function fakeBase() {
  const added: Array<Record<string, any>> = [];
  const updates: Array<{ id: string; updates: Record<string, any> }> = [];
  const base = {
    " subscribe": vi.fn(() => () => undefined),
    add: vi.fn((options: Record<string, any>) => {
      added.push(options);
      return options.id as string;
    }),
    close: vi.fn(),
    update: vi.fn((id: string, next: Record<string, any>) => {
      updates.push({ id, updates: next });
    }),
    promise: vi.fn(),
  };
  return { base, added, updates };
}

describe("createAppToastManager", () => {
  it("collapses an identical toast into the open one with a count and a fresh timeout", () => {
    const { base, added, updates } = fakeBase();
    const manager = createAppToastManager(base as never);
    const first = manager.add({ type: "error", title: "Could not push", description: "rejected" });
    const second = manager.add({ type: "error", title: "Could not push", description: "rejected" });
    expect(second).toBe(first);
    expect(added).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.updates.timeout).toBe(8_000);
    expect(updates[0]!.updates.data.count).toBe(2);
  });

  it("starts a new toast once the previous one closed", () => {
    const { base, added } = fakeBase();
    const manager = createAppToastManager(base as never);
    manager.add({ type: "info", title: "Copied" });
    added[0]!.onClose();
    manager.add({ type: "info", title: "Copied" });
    expect(added).toHaveLength(2);
  });

  it("runs the caller's close callback", () => {
    const { base, added } = fakeBase();
    const manager = createAppToastManager(base as never);
    const onClose = vi.fn();
    manager.add({ type: "info", title: "Hello", onClose });
    added[0]!.onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("applies type defaults but keeps an explicit timeout", () => {
    const { base, added } = fakeBase();
    const manager = createAppToastManager(base as never);
    manager.add({ type: "warning", title: "Slow" });
    manager.add({ type: "error", title: "Sticky", timeout: 0 });
    manager.add({ type: "info", title: "Approve?", data: { urgent: true } });
    expect(added.map((toast) => toast.timeout)).toEqual([6_000, 0, 0]);
  });

  it("gives error toasts copyable details", () => {
    const { base, added } = fakeBase();
    const manager = createAppToastManager(base as never);
    manager.add({ type: "error", title: "Could not push", description: "rejected" });
    expect(added[0]!.data.copyText).toMatch(/^Could not push\n\nrejected\n\n\d{4}-/);
  });
});

describe("toastDedupeKey", () => {
  it("keys plain-text toasts and skips the rest", () => {
    expect(toastDedupeKey({ type: "info", title: "A" })).toBeTruthy();
    expect(toastDedupeKey({ type: "info", title: "A", id: "mine" })).toBe(null);
    expect(toastDedupeKey({ type: "loading", title: "A" })).toBe(null);
    expect(toastDedupeKey({ type: "info", title: { node: true } })).toBe(null);
    expect(toastDedupeKey({ type: "info", title: "A", data: { dedupeKey: "k" } })).toBe("k");
    expect(toastDedupeKey({ type: "info", title: "A", data: { threadId: "t1" } })).not.toBe(
      toastDedupeKey({ type: "info", title: "A", data: { threadId: "t2" } }),
    );
  });
});

describe("toast logic", () => {
  it("formats compact ages", () => {
    const now = 1_000_000_000;
    expect(formatToastAge(now - 5_000, now)).toBe("now");
    expect(formatToastAge(now - 3 * 60_000, now)).toBe("3m");
    expect(formatToastAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(formatToastAge(now - 50 * 3_600_000, now)).toBe("2d");
  });

  it("keeps error and warning toasts longer", () => {
    expect(defaultToastTimeout("error")).toBe(8_000);
    expect(defaultToastTimeout("warning")).toBe(6_000);
    expect(defaultToastTimeout("success")).toBe(4_000);
  });

  it("starts the stack below an avoided strip in the right half", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    });
    expect(resolveToastTopOffset([], 1200)).toBe(52);
    expect(resolveToastTopOffset([rect(900, 48, 280, 24)], 1200)).toBe(80);
    // Left half, hidden, or far down the page: ignored.
    expect(resolveToastTopOffset([rect(10, 48, 280, 24)], 1200)).toBe(52);
    expect(resolveToastTopOffset([rect(900, 48, 0, 0)], 1200)).toBe(52);
    expect(resolveToastTopOffset([rect(900, 400, 280, 24)], 1200)).toBe(52);
  });
});
