import * as FS from "node:fs";

/** Thrown when an abort signal ends a wait. */
export class LockWaitAborted extends Error {
  override readonly name = "LockWaitAborted";
}

/** Thrown when a live holder keeps the lock past the caller's wait. */
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

/** A signal 0 probe: EPERM still means the process exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface FileLockOptions {
  /** How long to wait for a live holder; Infinity waits until it finishes. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * A cross-process lock: a file created exclusively, holding the owner's pid. A lock whose
 * owner is gone (killed, crashed) is stale and removed. Returns the release function,
 * which removes the file only while it still names this process.
 */
export async function acquireFileLock(
  path: string,
  signal: AbortSignal,
  options: FileLockOptions = {},
): Promise<() => void> {
  const isAlive = options.isAlive ?? processAlive;
  const deadline = Date.now() + (options.waitMs ?? Number.POSITIVE_INFINITY);
  const owner = String(process.pid);
  for (;;) {
    try {
      FS.writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (FS.readFileSync(path, "utf8") === owner) FS.unlinkSync(path);
        } catch {
          /* Already gone. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number(FS.readFileSync(path, "utf8").trim());
    } catch {
      continue;
    }
    if (!isAlive(holder)) {
      FS.rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new LockHeld(`Lock ${path} is held by process ${holder}.`);
    await abortableDelay(options.pollMs ?? 500, signal);
  }
}
