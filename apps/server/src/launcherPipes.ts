// @effect-diagnostics globalTimers:off -- Runs outside any Effect runtime, beside the process's own stdio.
import type { EventEmitter } from "node:events";

const CLOSED_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);
const PARENT_POLL_INTERVAL_MS = 2_000;

/**
 * The desktop launcher reads this process's stdout and stderr. Once it is gone,
 * every log write fails, and Node turns an unhandled stream error into a crash
 * that skips shutdown. A closed pipe is reported as launcher loss and later
 * write failures are ignored, so the orderly shutdown can still log.
 */
export function watchLauncherPipes(
  streams: readonly EventEmitter[],
  onLauncherLost: () => void,
): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (!CLOSED_PIPE_CODES.has(error.code ?? "")) throw error;
      onLauncherLost();
    });
  }
}

/**
 * A quiet backend never writes to a closed pipe. On POSIX an orphan is
 * reparented, so a changed parent PID also means the launcher died.
 */
export function watchLauncherParent(
  onLauncherLost: () => void,
  readParentPid: () => number = () => process.ppid,
  intervalMs = PARENT_POLL_INTERVAL_MS,
): () => void {
  const launcherPid = readParentPid();
  const timer = setInterval(() => {
    if (readParentPid() === launcherPid) return;
    clearInterval(timer);
    onLauncherLost();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Runs the `runMain` SIGTERM handler: interrupt, finalizers, then exit.
 * `process.kill(process.pid, "SIGTERM")` would skip all of it on Windows,
 * where it terminates the process outright.
 */
export function requestOrderlyShutdown(target: Pick<NodeJS.Process, "emit"> = process): void {
  target.emit("SIGTERM", "SIGTERM");
}

/** Shuts down once, on whichever sign of launcher loss comes first. */
export function shutdownOnLauncherLoss(options: {
  readonly streams: readonly EventEmitter[];
  readonly watchParent: boolean;
  readonly shutdown?: () => void;
}): void {
  const shutdown = options.shutdown ?? requestOrderlyShutdown;
  let lost = false;
  const onLauncherLost = () => {
    if (lost) return;
    lost = true;
    shutdown();
  };
  watchLauncherPipes(options.streams, onLauncherLost);
  if (options.watchParent) watchLauncherParent(onLauncherLost);
}
