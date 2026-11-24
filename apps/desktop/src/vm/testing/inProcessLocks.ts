import { abortableDelay, LockHeld, type AcquireLock } from "../fileLock";

/**
 * Test stand-in for `acquireFileLock`, with the same wait, poll and LockHeld behavior,
 * held in memory so tests run on every platform. The real kernel lock is tested on macOS.
 */
export function inProcessLocks(): { acquire: AcquireLock; held: Set<string> } {
  const held = new Set<string>();
  const acquire: AcquireLock = async (path, signal, options = {}) => {
    const deadline = Date.now() + (options.waitMs ?? Number.POSITIVE_INFINITY);
    for (;;) {
      if (!held.has(path)) {
        held.add(path);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          held.delete(path);
        };
      }
      if (Date.now() >= deadline) throw new LockHeld(`Lock ${path} is held.`);
      await abortableDelay(options.pollMs ?? 1, signal);
    }
  };
  return { acquire, held };
}
