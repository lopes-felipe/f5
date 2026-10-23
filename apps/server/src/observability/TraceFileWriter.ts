import { javascriptRuntimeExecutable } from "@t3tools/shared/hostRuntime";
import { spawn, type ChildProcess } from "node:child_process";

export interface TraceBatchWriter {
  /** Takes ownership of these buffers. At most one call is outstanding. */
  write(records: readonly Uint8Array[]): Promise<void>;
  close(): Promise<void>;
}

// Kept inline so the source checkout and bundled standalone distribution use
// exactly the same worker. Filesystem calls and rotation run off the event loop.
const workerSource = String.raw`
let workerData;
const fs = require("node:fs");
const path = require("node:path");
process.on("disconnect", () => process.exit(0));
let initialized = false;
let poisoned = false;
const missing = (error) => { if (error.code !== "ENOENT") throw error; };
const move = (from, to) => { try { fs.renameSync(from, to); } catch (error) { missing(error); } };
const rotate = () => {
  fs.rmSync(workerData.filePath + "." + workerData.maxFiles, { force: true });
  for (let i = workerData.maxFiles - 1; i >= 1; i--)
    move(workerData.filePath + "." + i, workerData.filePath + "." + (i + 1));
  move(workerData.filePath, workerData.filePath + ".1");
};
process.on("message", (message) => {
  if (message.type === "init") { workerData = message.options; return; }
  const records = message.records;
  let fd;
  let before;
  try {
    if (poisoned) throw new Error("Trace file has an incomplete write; restart to reopen it.");
    if (!initialized) {
      const directory = path.dirname(workerData.filePath);
      const base = path.basename(workerData.filePath);
      fs.mkdirSync(directory, { recursive: true });
      for (const name of fs.readdirSync(directory)) {
        if (!name.startsWith(base + ".")) continue;
        const suffix = Number(name.slice(base.length + 1));
        if (Number.isInteger(suffix) && suffix > workerData.maxFiles)
          fs.rmSync(path.join(directory, name), { force: true });
      }
      initialized = true;
    }
    let size = 0;
    try { size = fs.statSync(workerData.filePath).size; } catch (error) { missing(error); }
    const buffers = records.map((record) => Buffer.from(record));
    const bytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
    if (size > 0 && size + bytes > workerData.maxBytes) { rotate(); size = 0; }
    fd = fs.openSync(workerData.filePath, "a", 0o600);
    before = size;
    // A process may have exited during an earlier write. Keep its incomplete
    // tail out of the next NDJSON record without reading the whole trace file.
    if (size > 0) {
      const last = Buffer.alloc(1);
      const reader = fs.openSync(workerData.filePath, "r");
      try { fs.readSync(reader, last, 0, 1, size - 1); } finally { fs.closeSync(reader); }
      if (last[0] !== 10) { fs.closeSync(fd); fd = undefined; rotate(); fd = fs.openSync(workerData.filePath, "a", 0o600); before = 0; }
    }
    let pending = buffers;
    while (pending.length) {
      let written = fs.writevSync(fd, pending);
      if (written <= 0) throw new Error("Trace write made no progress.");
      let consumed = 0;
      while (consumed < pending.length && written >= pending[consumed].length) {
        written -= pending[consumed].length;
        consumed++;
      }
      pending = pending.slice(consumed);
      if (written > 0 && pending.length) pending[0] = pending[0].subarray(written);
    }
    fs.closeSync(fd); fd = undefined;
    if (before + bytes > workerData.maxBytes) rotate();
    process.send({ ok: true });
  } catch {
    if (fd !== undefined) {
      try { if (before !== undefined) fs.ftruncateSync(fd, before); }
      catch { poisoned = true; }
      try { fs.closeSync(fd); } catch {}
    }
    // File contents and errors may contain sensitive values. The main process
    // needs only a failure signal, never a serialized filesystem exception.
    process.send({ ok: false });
  }
});
`;

export function makeTraceFileWriter(options: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
}): TraceBatchWriter {
  let worker: ChildProcess | undefined;
  let pending: { resolve: () => void; reject: (cause: Error) => void } | undefined;
  let unavailable = false;
  let closed = false;
  const failed = () => {
    unavailable = true;
    pending?.reject(new Error("Trace writer unavailable."));
    pending = undefined;
  };
  try {
    // A separate process is required: Node waits for a worker thread blocked
    // in a filesystem syscall even when its Worker handle is unreferenced.
    worker = spawn(
      javascriptRuntimeExecutable(),
      ["--input-type=commonjs", "--eval", workerSource],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap((key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key]!]],
            ),
          ),
          ...(process.versions.electron && !process.env.F5_STANDALONE_DIR
            ? { ELECTRON_RUN_AS_NODE: "1" }
            : {}),
        },
      },
    );
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on("message", (message: { ok?: boolean }) => {
      const request = pending;
      pending = undefined;
      if (message.ok === true) request?.resolve();
      else request?.reject(new Error("Trace file write failed."));
    });
    // A hung disk never keeps the server alive beyond its shutdown budget.
    worker.send!({ type: "init", options }, (cause) => {
      if (cause) failed();
    });
    worker.unref();
    worker.channel?.unref();
  } catch {
    unavailable = true;
  }
  return {
    write(records) {
      if (!worker || unavailable || closed)
        return Promise.reject(new Error("Trace writer unavailable."));
      if (pending) return Promise.reject(new Error("Trace writer already has a batch in flight."));
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        try {
          const buffers = records.map((record) => {
            if (
              !(record.buffer instanceof ArrayBuffer) ||
              record.byteOffset !== 0 ||
              record.byteLength !== record.buffer.byteLength
            )
              throw new Error("Trace records require owned buffers.");
            return record.buffer;
          });
          // IPC serializes synchronously before returning. Detach the source
          // buffers afterwards so the parent retains only the in-flight receipt.
          worker!.send!({ type: "batch", records: buffers }, (cause) => {
            if (cause) failed();
          });
          structuredClone(buffers, { transfer: buffers });
        } catch {
          failed();
        }
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      failed();
      // Every successful write closed its file before acknowledging. After a
      // deadline, kill only this owned process and never wait for a stuck disk.
      try {
        if (worker?.connected) worker.disconnect();
      } catch {
        /* Already gone. */
      }
      worker?.kill("SIGKILL");
      worker?.unref();
      worker?.channel?.unref();
    },
  };
}
