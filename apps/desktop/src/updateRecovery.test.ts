import { expect, it, vi } from "vitest";
import { recoverUpdateSession, restoreUpdateWindows } from "./updateRecovery";
it.each([false, true])(
  "restores running profiles and closed windows after cleanup (preview fails: %s)",
  async (previewFails) => {
    const active = { stopped: true, id: "active" };
    const inactive = { stopped: true, id: "inactive" };
    const bounds = { x: 20, y: 30, width: 800, height: 600 };
    const snapshots = [
      {
        window: { isDestroyed: () => true, setBounds: vi.fn() },
        runtime: active,
        threadId: "thread-1",
        bounds,
      },
      {
        window: { isDestroyed: () => false, setBounds: vi.fn() },
        runtime: active,
        threadId: "thread-2",
        bounds,
      },
    ];
    const restored = { isDestroyed: () => false, setBounds: vi.fn() };
    const createWindow = vi.fn(() => restored);
    const startBackend = vi.fn();
    const initializeComputer = vi.fn();
    const initializeKeepAwake = vi.fn(async () => {});
    const errors = await recoverUpdateSession({
      cleanupStarted: true,
      initializePreview: async () => {
        if (previewFails) throw new Error("preview");
      },
      initializeComputer,
      initializeKeepAwake,
      runningBeforeInstall: [active],
      startBackend,
      restoreWindows: () => restoreUpdateWindows(snapshots, createWindow),
    });
    expect(errors).toHaveLength(previewFails ? 1 : 0);
    expect(initializeComputer).toHaveBeenCalledTimes(1);
    expect(initializeKeepAwake).toHaveBeenCalledTimes(1);
    expect(active.stopped).toBe(false);
    expect(inactive.stopped).toBe(true);
    expect(startBackend).toHaveBeenCalledExactlyOnceWith(active);
    expect(createWindow).toHaveBeenCalledExactlyOnceWith("thread-1", active);
    expect(restored.setBounds).toHaveBeenCalledWith(bounds);
  },
);
it("leaves Keep Awake running when update cleanup never started", async () => {
  const initializeKeepAwake = vi.fn(async () => {});
  await recoverUpdateSession({
    cleanupStarted: false,
    initializePreview: async () => {},
    initializeComputer: () => {},
    initializeKeepAwake,
    runningBeforeInstall: [],
    startBackend: () => {},
    restoreWindows: () => {},
  });
  expect(initializeKeepAwake).not.toHaveBeenCalled();
});
