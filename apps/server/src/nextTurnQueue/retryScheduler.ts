import type { ThreadId } from "@t3tools/contracts";

/** One earliest wakeup per thread; retired callbacks cannot wake a newer generation. */
export function makeQueueRetryScheduler(wake: (threadId: ThreadId) => void) {
  const entries = new Map<ThreadId, { due: number; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;
  const cancel = (threadId: ThreadId) => {
    const entry = entries.get(threadId);
    if (entry) clearTimeout(entry.timer);
    entries.delete(threadId);
  };
  return {
    get size() {
      return entries.size;
    },
    cancel,
    schedule(threadId: ThreadId, delayMs: number) {
      if (disposed) return;
      const due = Date.now() + Math.max(0, delayMs);
      if ((entries.get(threadId)?.due ?? Infinity) <= due) return;
      cancel(threadId);
      const entry = {
        due,
        timer: setTimeout(
          () => {
            if (disposed || entries.get(threadId) !== entry) return;
            entries.delete(threadId);
            wake(threadId);
          },
          Math.max(0, due - Date.now()),
        ),
      };
      entry.timer.unref?.();
      entries.set(threadId, entry);
    },
    dispose() {
      disposed = true;
      for (const threadId of entries.keys()) cancel(threadId);
    },
  };
}
