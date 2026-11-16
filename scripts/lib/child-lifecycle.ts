// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import type { ChildProcess } from "node:child_process";

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * True for a spawned child that has not exited. A child that failed to spawn
 * has no pid and never emits `exit`, so it is not running.
 */
export function isRunning(child: ChildProcess | undefined): child is ChildProcess {
  return child !== undefined && child.pid !== undefined && !hasExited(child);
}

/**
 * Resolves when the child exits and rejects if it fails to spawn (or errors
 * before exiting), so callers never wait forever on a child that emitted
 * `error` without `exit`. Call it right after `spawn` or only while
 * `isRunning(child)` holds; a spawn error that already fired is not replayed.
 */
export function waitForChild(child: ChildProcess): Promise<ChildExit> {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      child.off("exit", onExit);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** SIGTERM, then SIGKILL after `graceMs`. Never rejects. */
export async function stopChild(child: ChildProcess | undefined, graceMs = 5000): Promise<void> {
  if (!isRunning(child)) return;
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    const exited = waitForChild(child).catch(() => undefined);
    child.kill("SIGTERM");
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
