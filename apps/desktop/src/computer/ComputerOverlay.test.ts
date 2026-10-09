import { beforeEach, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  screen: {
    on: (name: string, callback: () => void) => mocks.listeners.set(name, callback),
    off: (name: string) => mocks.listeners.delete(name),
    getAllDisplays: () => [
      { id: 1, bounds: { x: -1200, y: 0, width: 1200, height: 900 } },
      { id: 2, bounds: { x: 0, y: 0, width: 1600, height: 1000 } },
    ],
  },
  BrowserWindow: class {
    options: unknown;
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setContentProtection = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    destroyed = false;
    constructor(options: unknown) {
      this.options = options;
      mocks.windows.push(this);
    }
    loadURL = vi.fn(async () => {});
    showInactive = vi.fn();
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
    }
  },
}));
import { ComputerOverlay } from "./ComputerOverlay";
beforeEach(() => {
  mocks.windows.length = 0;
  mocks.listeners.clear();
});
it("creates protected, non-interactive overlays on every display and clears them on release", async () => {
  const overlay = new ComputerOverlay();
  overlay.show({ executionGeneration: 1 } as ComputerLeaseHolder);
  await Promise.resolve();
  expect(mocks.windows).toHaveLength(2);
  for (const window of mocks.windows) {
    expect(window.options).toMatchObject({
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    });
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
  }
  mocks.listeners.get("display-metrics-changed")!();
  expect(mocks.windows.slice(0, 2).every((window) => window.destroyed)).toBe(true);
  expect(mocks.windows).toHaveLength(4);
  overlay.close();
  expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
  expect(mocks.listeners.size).toBe(0);
});
