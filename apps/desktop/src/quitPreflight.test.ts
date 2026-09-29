import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import { closeWindowsForQuit } from "./quitPreflight";

function windowFixture(veto: boolean) {
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    isDestroyed: () => false,
    close: vi.fn(() => {
      queueMicrotask(() =>
        veto ? window.webContents.emit("will-prevent-unload") : window.emit("closed"),
      );
    }),
  });
  return window;
}
it("stops update preflight on a veto before closing subsequent windows", async () => {
  const first = windowFixture(true),
    second = windowFixture(false);
  expect(await closeWindowsForQuit([first, second] as unknown as BrowserWindow[])).toBe(false);
  expect(second.close).not.toHaveBeenCalled();
  expect(first.webContents.listenerCount("will-prevent-unload")).toBe(0);
});
it("waits for every renderer to close before allowing cleanup and install", async () => {
  const first = windowFixture(false),
    second = windowFixture(false);
  expect(await closeWindowsForQuit([first, second] as unknown as BrowserWindow[])).toBe(true);
  expect(second.close).toHaveBeenCalledOnce();
  expect(first.listenerCount("closed")).toBe(0);
});
