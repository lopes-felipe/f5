import { expect, it, vi } from "vitest";
import { createUpdatePoller } from "./updatePoller";
import { recoverUpdateSession } from "./updateRecovery";
it("restarts the poll after install recovery without duplicating timers or startup checks", async () => {
  vi.useFakeTimers();
  try {
    const check = vi.fn(async () => {});
    const poller = createUpdatePoller(check, 15_000, 4 * 60 * 60_000);
    poller.start(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledExactlyOnceWith("startup");
    poller.stop();
    check.mockClear();
    await recoverUpdateSession({
      cleanupStarted: false,
      initializePreview: async () => {},
      initializeComputer: () => {},
      runningBeforeInstall: [],
      startBackend: () => {},
      restoreWindows: () => {},
      resumeUpdates: () => poller.start(),
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(check).toHaveBeenCalledExactlyOnceWith("poll");
    poller.stop();
  } finally {
    vi.useRealTimers();
  }
});
