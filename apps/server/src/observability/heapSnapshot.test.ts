import { expect, it, vi } from "vitest";
import { installHeapSnapshotSignal } from "./heapSnapshot.ts";

it.skipIf(process.platform === "win32")(
  "owns its signal handler, bounds re-entry, and hides write errors",
  () => {
    const count = process.listenerCount("SIGUSR2");
    const write = vi.fn(() => {
      process.emit("SIGUSR2");
      throw new Error("private snapshot failure");
    });
    const report = vi.fn();
    const stop = installHeapSnapshotSignal("/logs/observability", write, report);
    try {
      process.emit("SIGUSR2");
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0]).toHaveLength(1);
      expect(report).toHaveBeenCalledExactlyOnceWith();
      expect(process.listenerCount("SIGUSR2")).toBe(count + 1);
    } finally {
      stop();
    }
    expect(process.listenerCount("SIGUSR2")).toBe(count);
  },
);
