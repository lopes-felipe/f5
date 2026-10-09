import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  PREVIEW_IPC_CHANNELS,
  registerPreviewIpc,
  type PreviewIpcOperations,
} from "./registerPreviewIpc";

function makeHarness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  const operations = {
    getConfig: vi.fn(() => ({ partition: "persist:f5-preview", webPreferences: "sandbox=true" })),
    createTab: vi.fn(() => true),
    closeTab: vi.fn(),
    registerWebview: vi.fn(() => true),
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    refresh: vi.fn(),
    hardReload: vi.fn(),
    openDevTools: vi.fn(),
    pickElement: vi.fn(),
    cancelPickElement: vi.fn(),
    automationStatus: vi.fn(),
    automationSnapshot: vi.fn(),
    automationClick: vi.fn(),
    automationType: vi.fn(),
    automationPress: vi.fn(),
    automationScroll: vi.fn(),
    automationEvaluate: vi.fn(),
    automationWaitFor: vi.fn(),
    automationCancel: vi.fn(),
    setNavigationPolicy: vi.fn(() => true),
    captureThumbnail: vi.fn(),
    setViewport: vi.fn(() => true),
    setColorScheme: vi.fn(() => true),
    captureScreenshot: vi.fn(),
    setArtifactRetention: vi.fn(),
    recordingStart: vi.fn(),
    recordingAppend: vi.fn(),
    recordingStop: vi.fn(),
    recordingDiscard: vi.fn(),
  } satisfies PreviewIpcOperations;
  const operationsForSender = vi.fn(() => operations);
  registerPreviewIpc(ipcMain, operationsForSender);
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ sender: { id: 17 } }, ...args);
  return { handlers, invoke, operations, operationsForSender };
}

describe("registerPreviewIpc", () => {
  it("keeps the established preview channels and payload ordering", () => {
    const { handlers, invoke, operations, operationsForSender } = makeHarness();
    expect(handlers.size).toBe(Object.keys(PREVIEW_IPC_CHANNELS).length);

    invoke(PREVIEW_IPC_CHANNELS.registerWebview, "tab-1", 42);
    invoke(PREVIEW_IPC_CHANNELS.automationClick, "tab-1", { selector: "#save" });

    expect(operations.registerWebview).toHaveBeenCalledWith("tab-1", 42);
    expect(operations.automationClick).toHaveBeenCalledWith("tab-1", { selector: "#save" });
    invoke(PREVIEW_IPC_CHANNELS.setColorScheme, "tab-1", "dark");
    expect(operations.setColorScheme).toHaveBeenCalledWith("tab-1", "dark");
    expect(operationsForSender).toHaveBeenCalledWith(17);
  });

  it("validates the snapshot save flag through the owner-scoped operations", () => {
    const { invoke, operations } = makeHarness();
    invoke(PREVIEW_IPC_CHANNELS.automationSnapshot, "tab-1", true);
    expect(operations.automationSnapshot).toHaveBeenCalledWith("tab-1", true);
    expect(() => invoke(PREVIEW_IPC_CHANNELS.automationSnapshot, "tab-1", "true")).toThrow(
      "Invalid snapshot save flag",
    );
  });

  it("rejects stale viewport revisions in the runtime-facing operation", () => {
    const { invoke, operations } = makeHarness();
    invoke(PREVIEW_IPC_CHANNELS.setViewport, "tab-1", {
      width: 375,
      height: 812,
      revision: 7,
    });
    expect(operations.setViewport).toHaveBeenCalledWith("tab-1", {
      width: 375,
      height: 812,
      revision: 7,
    });
  });

  it("passes artifact retention through and rejects non-integer days", () => {
    const { invoke, operations } = makeHarness();
    invoke(PREVIEW_IPC_CHANNELS.setArtifactRetention, 14);
    invoke(PREVIEW_IPC_CHANNELS.setArtifactRetention, null);
    expect(operations.setArtifactRetention).toHaveBeenNthCalledWith(1, 14);
    expect(operations.setArtifactRetention).toHaveBeenNthCalledWith(2, null);
    expect(() => invoke(PREVIEW_IPC_CHANNELS.setArtifactRetention, "14")).toThrow(
      "Preview artifact retention is invalid.",
    );
  });

  it("routes take-over cancellation and rejects malformed navigation policies", () => {
    const { invoke, operations } = makeHarness();
    invoke(PREVIEW_IPC_CHANNELS.automationCancel, "tab-1");
    expect(operations.automationCancel).toHaveBeenCalledWith("tab-1");
    invoke(PREVIEW_IPC_CHANNELS.setNavigationPolicy, "tab-1", ["example.com"]);
    expect(operations.setNavigationPolicy).toHaveBeenCalledWith("tab-1", ["example.com"]);
    expect(invoke(PREVIEW_IPC_CHANNELS.setNavigationPolicy, "tab-1", "example.com")).toBe(false);
    expect(invoke(PREVIEW_IPC_CHANNELS.setNavigationPolicy, "tab-1", [42])).toBe(false);
    expect(operations.setNavigationPolicy).toHaveBeenCalledTimes(1);
  });

  it("marks only an explicit agent navigation as agent-driven", () => {
    const { invoke, operations } = makeHarness();
    invoke(PREVIEW_IPC_CHANNELS.navigate, "tab-1", "https://example.com/", { agent: true });
    invoke(PREVIEW_IPC_CHANNELS.navigate, "tab-1", "https://example.com/");
    invoke(PREVIEW_IPC_CHANNELS.navigate, "tab-1", "https://example.com/", { agent: "yes" });
    expect(operations.navigate.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("rejects unknown preview color schemes before they reach the runtime", () => {
    const { invoke, operations } = makeHarness();
    expect(invoke(PREVIEW_IPC_CHANNELS.setColorScheme, "tab-1", "sepia")).toBe(false);
    expect(operations.setColorScheme).not.toHaveBeenCalled();
  });
});
