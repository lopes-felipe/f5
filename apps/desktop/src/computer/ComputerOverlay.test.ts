import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComputerLeaseHolder } from "@t3tools/contracts";
const mocks = vi.hoisted(() => ({
  windows: [] as any[],
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  screen: {
    screenToDipPoint: (point: { x: number; y: number }) => point,
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
    once = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setContentProtection = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => {}),
    };
    getBounds() {
      return (this.options as any).bounds ?? this.options;
    }
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
afterEach(() => vi.unstubAllGlobals());
it("does not await renderer acknowledgements and coalesces to the latest action", async () => {
  const overlay = new ComputerOverlay();
  overlay.show({ executionGeneration: 1 } as ComputerLeaseHolder);
  let finish!: () => void;
  const render = new Promise<void>((resolve) => {
    finish = resolve;
  });
  for (const window of mocks.windows)
    window.webContents.executeJavaScript.mockReturnValueOnce(render);
  const request = (text: string) => ({ op: "type", text, agent: { provider: "codex" } }) as any;
  try {
    await overlay.action(request("a"), []);
    await overlay.action(request("bb"), []);
    await overlay.action(request("ccc"), []);
    for (const window of mocks.windows)
      expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const window of mocks.windows) {
      expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
      expect(window.webContents.executeJavaScript.mock.calls[1][0]).toContain(
        "Typing 3 characters",
      );
    }
  } finally {
    overlay.close();
  }
});
it.each(["darwin", "win32"])(
  "waits only 90 ms for a moved pointer on %s, and does not wait at the same point",
  async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    vi.useFakeTimers();
    const overlay = new ComputerOverlay();
    overlay.show({ executionGeneration: 1 } as ComputerLeaseHolder);
    const request = {
      op: "move",
      displayId: "1",
      x: 20,
      y: 20,
      agent: { provider: "codex" },
    } as any;
    const display = {
      displayId: "1",
      nativeBounds: { x: 0, y: 0, width: 100, height: 100 },
      modelSize: { width: 100, height: 100 },
    } as any;
    try {
      let finished = false;
      const action = overlay.action(request, [display]).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(89);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await action;
      expect(finished).toBe(true);
      await overlay.action(request, [display]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      overlay.close();
      vi.useRealTimers();
    }
  },
);
it.each(["darwin", "win32"])(
  "creates protected, non-interactive overlays on %s and clears them on release",
  async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const overlay = new ComputerOverlay();
    overlay.show({ executionGeneration: 1 } as ComputerLeaseHolder);
    await Promise.resolve();
    expect(mocks.windows).toHaveLength(2);
    for (const window of mocks.windows) {
      expect(window.options).toMatchObject({
        ...(platform === "darwin" ? { type: "panel" } : {}),
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
      expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({
        action: "deny",
      });
    }
    mocks.listeners.get("display-metrics-changed")!();
    expect(mocks.windows.slice(0, 2).every((window) => window.destroyed)).toBe(true);
    expect(mocks.windows).toHaveLength(4);
    for (const window of mocks.windows) {
      if (platform === "darwin") {
        expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      } else {
        expect(window.options).not.toHaveProperty("type");
        expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
      }
    }
    overlay.close();
    expect(mocks.windows.every((window) => window.destroyed)).toBe(true);
    expect(mocks.listeners.size).toBe(0);
  },
);
