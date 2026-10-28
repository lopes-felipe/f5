import { afterEach, expect, it, vi } from "vitest";
import { APP_DISPLAY_NAME } from "./branding";
import { setDocumentAttentionCount, setDocumentPageTitle } from "./lib/documentTitle";
import {
  createNotificationSound,
  needsThreadAttention,
  setThreadAttentionBadge,
} from "./threadAttention";

afterEach(() => {
  vi.unstubAllGlobals();
  setDocumentPageTitle(null);
  setDocumentAttentionCount(0);
});
it("counts attention statuses rather than running work", () => {
  for (const status of [
    "pending-approval",
    "awaiting-input",
    "failed",
    "plan-ready",
    "completed",
  ] as const)
    expect(needsThreadAttention(status)).toBe(true);
  for (const status of ["working", "connecting", "none"] as const)
    expect(needsThreadAttention(status)).toBe(false);
});
it("uses desktop badges and prefixes the title the native window composes from", () => {
  const setAttentionBadge = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", { desktopBridge: { setAttentionBadge } });
  vi.stubGlobal("document", { title: APP_DISPLAY_NAME });
  setThreadAttentionBadge(3);
  expect(setAttentionBadge).toHaveBeenCalledWith(3);
  expect(document.title).toBe(`(3) ${APP_DISPLAY_NAME}`);
});
it("keeps the attention prefix when a route changes the page title", () => {
  vi.stubGlobal("window", {
    desktopBridge: { setAttentionBadge: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal("document", { title: APP_DISPLAY_NAME });
  setThreadAttentionBadge(2);
  setDocumentPageTitle("Settings");
  expect(document.title).toBe("(2) Settings · F5");
  setThreadAttentionBadge(0);
  expect(document.title).toBe("Settings · F5");
  setDocumentPageTitle(null);
  expect(document.title).toBe(APP_DISPLAY_NAME);
});
it("updates and clears the web badge and title without stacking prefixes", () => {
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const clearAppBadge = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });
  vi.stubGlobal("document", { title: APP_DISPLAY_NAME });
  setThreadAttentionBadge(2);
  setThreadAttentionBadge(5);
  expect(document.title).toBe(`(5) ${APP_DISPLAY_NAME}`);
  setThreadAttentionBadge(0);
  expect(document.title).toBe(APP_DISPLAY_NAME);
  expect(clearAppBadge).toHaveBeenCalledOnce();
});
it("does not start audio before a gesture and releases it when disabled", () => {
  const tone = {
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    onended: undefined,
  };
  const gain = {
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const close = vi.fn().mockResolvedValue(undefined);
  const resume = vi.fn().mockResolvedValue(undefined);
  const construct = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        construct();
      }
      state = "running";
      currentTime = 0;
      destination = {};
      resume = resume;
      close = close;
      createOscillator() {
        return tone;
      }
      createGain() {
        return gain;
      }
    },
  );
  const sound = createNotificationSound();
  sound.play();
  expect(construct).not.toHaveBeenCalled();
  sound.unlock();
  sound.play();
  expect(tone.start).toHaveBeenCalledOnce();
  expect(tone.stop).toHaveBeenCalledWith(0.3);
  sound.dispose();
  expect(close).toHaveBeenCalledOnce();
});
