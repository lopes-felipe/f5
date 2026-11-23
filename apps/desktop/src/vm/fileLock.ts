import * as FS from "node:fs";

/** Thrown when an abort signal ends a wait. */
export class LockWaitAborted extends Error {
  override readonly name = "LockWaitAborted";
}

/** Thrown when another holder keeps the lock past the caller's wait. */
export class LockHeld extends Error {
  override readonly name = "LockHeld";
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new LockWaitAborted());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LockWaitAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface FileLockOptions {
  /** How long to wait for another holder; Infinity waits until it finishes. */
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/** Acquires the lock at a path; resolves with its release function. */
export type AcquireLock = (
  path: string,
  signal: AbortSignal,
  options?: FileLockOptions,
) => Promise<() => void>;

/** `O_EXLOCK` from macOS <fcntl.h>: open and take an exclusive flock(2) lock atomically. */
const O_EXLOCK = 0x20;

/**
 * A cross-process lock held by the kernel: an exclusive flock(2) lock taken atomically
 * with the open (macOS `O_EXLOCK`, non-blocking, polled). The kernel drops it when the
 * holder closes the descriptor or exits, however it exits, so there is no stale lock to
 * judge and no pid to trust. The file itself stays in place: unlinking a lock file lets a
 * later opener lock a new inode while another still holds the old one.
 *
 * Linux VM profiles run only on macOS. Elsewhere this refuses; tests inject their own lock.
 */
export const acquireFileLock: AcquireLock = async (path, signal, options = {}) => {
  if (process.platform !== "darwin")
    throw new Error("Linux VM profile locks need macOS (O_EXLOCK).");
  const deadline = Date.now() + (options.waitMs ?? Number.POSITIVE_INFINITY);
  const flags = FS.constants.O_RDWR | FS.constants.O_CREAT | FS.constants.O_NONBLOCK | O_EXLOCK;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = FS.openSync(path, flags, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Anything but "someone else holds it" (permissions, I/O, a missing directory) is final.
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
    }
    if (fd !== null) {
      const held = fd;
      try {
        // For diagnostics only: who holds it.
        FS.ftruncateSync(held);
        FS.writeSync(held, `${process.pid}\n`);
      } catch {
        /* The lock is what matters. */
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        FS.closeSync(held);
      };
    }
    if (Date.now() >= deadline) throw new LockHeld(`Lock ${path} is held${describeHolder(path)}.`);
    await abortableDelay(options.pollMs ?? 500, signal);
  }
};

function describeHolder(path: string): string {
  try {
    const pid = FS.readFileSync(path, "utf8").trim();
    return /^\d+$/.test(pid) ? ` by process ${pid}` : "";
  } catch {
    return "";
  }
}
