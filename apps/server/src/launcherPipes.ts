import type { EventEmitter } from "node:events";

const CLOSED_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * The desktop launcher reads this process's stdout and stderr. Once it is gone,
 * every log write fails, and Node turns an unhandled stream error into a crash
 * that skips shutdown. A closed pipe is reported once as launcher loss and
 * later write failures are ignored, so the orderly shutdown can still log.
 */
export function watchLauncherPipes(
  streams: readonly EventEmitter[],
  onLauncherLost: () => void,
): void {
  let lost = false;
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (!CLOSED_PIPE_CODES.has(error.code ?? "")) throw error;
      if (lost) return;
      lost = true;
      onLauncherLost();
    });
  }
}
