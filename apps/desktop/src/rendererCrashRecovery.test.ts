import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MainRendererCrashRecovery, mainRendererCrashScreenUrl } from "./rendererCrashRecovery";

function makeHarness() {
  let now = 0;
  const cleanupRendererResources = vi.fn(async () => undefined);
  const reloadRenderer = vi.fn(async () => undefined);
  const showCrashScreen = vi.fn(async () => undefined);
  const reportError = vi.fn();
  const recovery = new MainRendererCrashRecovery({
    cleanupRendererResources,
    reloadRenderer,
    showCrashScreen,
    reportError,
    now: () => now,
  });
  return {
    recovery,
    cleanupRendererResources,
    reloadRenderer,
    showCrashScreen,
    reportError,
    setNow: (value: number) => {
      now = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MainRendererCrashRecovery", () => {
  it("reloads at most three times with one, two, and four second backoff", async () => {
    const harness = makeHarness();

    harness.setNow(0);
    await expect(harness.recovery.handleCrash()).resolves.toEqual({
      kind: "reload-scheduled",
      attempt: 1,
      delayMs: 1_000,
    });
    expect(harness.cleanupRendererResources).toHaveBeenCalledTimes(1);
    expect(harness.reloadRenderer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    harness.setNow(10_000);
    await expect(harness.recovery.handleCrash()).resolves.toEqual({
      kind: "reload-scheduled",
      attempt: 2,
      delayMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    harness.setNow(20_000);
    await expect(harness.recovery.handleCrash()).resolves.toEqual({
      kind: "reload-scheduled",
      attempt: 3,
      delayMs: 4_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);

    harness.setNow(30_000);
    await expect(harness.recovery.handleCrash()).resolves.toEqual({ kind: "crash-screen" });

    expect(harness.reloadRenderer).toHaveBeenCalledTimes(3);
    expect(harness.cleanupRendererResources).toHaveBeenCalledTimes(4);
    expect(harness.showCrashScreen).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh retry budget after sixty seconds", async () => {
    const harness = makeHarness();
    await harness.recovery.handleCrash();
    await vi.advanceTimersByTimeAsync(1_000);

    harness.setNow(60_000);
    await expect(harness.recovery.handleCrash()).resolves.toEqual({
      kind: "reload-scheduled",
      attempt: 1,
      delayMs: 1_000,
    });
  });

  it("coalesces duplicate crash notifications while recovery is pending", async () => {
    const harness = makeHarness();

    await harness.recovery.handleCrash();
    await expect(harness.recovery.handleCrash()).resolves.toEqual({ kind: "ignored" });

    expect(harness.cleanupRendererResources).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.reloadRenderer).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending reload when its window closes", async () => {
    const harness = makeHarness();
    await harness.recovery.handleCrash();

    harness.recovery.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.reloadRenderer).not.toHaveBeenCalled();
  });

  it("falls back to the crash screen when renderer reload fails", async () => {
    const harness = makeHarness();
    harness.reloadRenderer.mockRejectedValueOnce(new Error("reload failed"));
    await harness.recovery.handleCrash();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.showCrashScreen).toHaveBeenCalledTimes(1);
    expect(harness.reportError).toHaveBeenCalledWith("reload", expect.any(Error));
  });

  it("builds a local plain-HTML recovery page with an escaped reload target", () => {
    const dataUrl = mainRendererCrashScreenUrl('f5://app/index.html?next="unsafe"&ready=true');
    const html = decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));

    expect(dataUrl.startsWith("data:text/html;charset=UTF-8,")).toBe(true);
    expect(html).toContain('href="f5://app/index.html?next=&quot;unsafe&quot;&amp;ready=true"');
    expect(html).not.toContain("<script");
  });
});
