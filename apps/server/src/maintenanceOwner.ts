import { Worker } from "node:worker_threads";
import { Socket } from "node:net";

/**
 * SQLite maintenance can block the helper's main JS thread. Watch the private
 * lifetime pipe on an independent thread so parent death still kills the whole
 * helper (and releases SQLite locks), even in the middle of synchronous VACUUM.
 * This script uses built-ins only and is identical in source and bundled builds.
 */
export async function watchMaintenanceOwner(fd = 3): Promise<() => Promise<void>> {
  // Configure Node's inherited POSIX pipe as nonblocking. The independent
  // worker owns all reads; its async I/O also works with Bun's blocking pipes.
  const owner =
    process.platform === "win32" ? null : new Socket({ fd, readable: true, writable: false });
  owner?.pause();
  owner?.unref();
  const stopping = new Int32Array(new SharedArrayBuffer(4));
  const watchdog = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { Socket } = require("node:net");
    const { read } = require("node:fs");
    const stopping = new Int32Array(workerData.stopping);
    const terminate = () => {
      // Worker teardown may itself close/error the Windows pipe. Normal helper
      // completion revokes this callback before terminating the watchdog.
      if (Atomics.load(stopping, 0) === 0) process.kill(process.pid, "SIGKILL");
    };
    try {
      // Read through this worker's filesystem I/O, so neither synchronous SQL
      // nor a blocking pipe read prevents the worker from acknowledging stop.
      // Bun's Windows socket dispatch can wait on the blocked main thread.
      // Filesystem reads complete on the owning worker instead.
      if (process.platform !== "win32" || process.versions.bun !== undefined) {
        const byte = Buffer.alloc(1);
        const poll = () => read(workerData.fd, byte, 0, 1, null, (error, bytes) => {
          if (Atomics.load(stopping, 0) !== 0) return;
          if (error && !["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code)) terminate();
          else if (!error && bytes === 0) terminate();
          else setTimeout(poll, 25);
        });
        parentPort.once("message", () => process.exit(0));
        poll();
        parentPort.postMessage("ready");
      } else {
        const owner = new Socket({ fd: workerData.fd, readable: true, writable: false });
        owner.on("end", terminate);
        owner.on("error", terminate);
        owner.resume();
        parentPort.once("message", () => {
          owner.removeAllListeners();
          owner.destroy();
          process.exit(0);
        });
        parentPort.postMessage("ready");
      }
    } catch { terminate(); }
  `,
    { eval: true, workerData: { fd, stopping: stopping.buffer }, execArgv: [] },
  );
  await new Promise<void>((resolve, reject) => {
    watchdog.once("message", () => resolve());
    watchdog.once("error", reject);
    watchdog.once("exit", (code) =>
      reject(new Error(`Maintenance owner watchdog exited (${code}).`)),
    );
  });
  return async () => {
    Atomics.store(stopping, 0, 1);
    const exited = new Promise<void>((resolve) => watchdog.once("exit", () => resolve()));
    watchdog.postMessage("stop");
    await exited;
    owner?.destroy();
  };
}
