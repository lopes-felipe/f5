import type { EventEmitter } from "node:events";

/** A closed launcher pipe must not crash the desktop process. */
export function ignoreBrokenPipeErrors(streams: readonly EventEmitter[]): void {
  for (const stream of streams) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
  }
}

ignoreBrokenPipeErrors([process.stdout, process.stderr]);
