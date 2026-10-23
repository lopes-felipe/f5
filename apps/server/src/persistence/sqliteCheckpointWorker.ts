import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Effect, Metric } from "effect";

export const sqliteWalBytes = Metric.gauge("f5_sqlite_wal_bytes", {
  description: "Last WAL size reported by the checkpoint worker.",
});
export const sqliteCheckpointBlocked = Metric.gauge("f5_sqlite_checkpoint_blocked", {
  description:
    "Whether the latest passive checkpoint was incomplete (reader or writer contention).",
});

const CHECKPOINT_FRAMES = 1_000;
const WRITER_BACKSTOP_FRAMES = 10_000;
const CHECKPOINT_IDLE_MS = 100;

// A source string works in both the bundled standalone server and source tests.
// NOOP was added in SQLite 3.51; older versions interpret it as PASSIVE.
export const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { closeSync, fstatSync, openSync } = require("node:fs");
const db = new DatabaseSync(workerData.filename);
const version = db.prepare("SELECT sqlite_version() AS version").get().version;
const [major, minor] = version.split(".").map(Number);
if (major < 3 || (major === 3 && minor < 51)) throw new Error("SQLite " + version + " has no NOOP checkpoint");
db.exec("PRAGMA busy_timeout=5000; PRAGMA checkpoint_fullfsync=ON;");
const frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
let idle;
let blocked = false;
const inspect = (finishing) => {
  let state = frames.get();
  let retry = false;
  const knownFrames = state.log >= 0 && state.checkpointed >= 0;
  if (state.busy !== 0 || !knownFrames) {
    // SQLite can return -1/-1 while its checkpoint lock is held. This is
    // unknown progress, not a completed checkpoint and not a contention claim.
    retry = state.busy !== 0 || blocked;
  }
  else if (finishing ? state.log >= workerData.frames && state.checkpointed < state.log
                     : state.log - state.checkpointed >= workerData.frames) {
    state = checkpoint.get();
    blocked = state.busy !== 0 || state.checkpointed < state.log;
    retry = blocked;
  }
  else if (state.log === state.checkpointed) blocked = false;
  if (finishing && retry) {
    clearTimeout(idle);
    idle = setTimeout(() => inspect(true), workerData.idleMs);
  }
  // fstat on an open handle: Windows stat by name can report the size cached in the directory
  // entry, which stays stale while SQLite holds the WAL open.
  let walBytes = 0;
  let wal;
  try { wal = openSync(workerData.filename + "-wal", "r"); walBytes = fstatSync(wal).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { if (wal !== undefined) closeSync(wal); }
  parentPort.postMessage({ ack: !finishing, walBytes, blocked });
};
parentPort.on("message", () => {
  inspect(false);
  clearTimeout(idle);
  idle = setTimeout(() => inspect(true), workerData.idleMs);
});
`;

/** At most one outstanding request and one pending check, irrespective of write rate. */
export const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: DatabaseSync,
) {
  const runFork = Effect.runForkWith(yield* Effect.services<never>());
  const warn = (reason: string) =>
    Effect.logWarning(
      "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
      { reason },
    );
  let worker: Worker;
  try {
    worker = new Worker(checkpointWorkerSource, {
      eval: true,
      workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
    });
  } catch (cause) {
    yield* warn(String(cause));
    return undefined;
  }
  let stopped = false;
  let checking = false;
  let checkAgain = false;
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint=${CHECKPOINT_FRAMES}`);
    } catch {
      /* The writer may already be closed. */
    }
    runFork(warn(reason));
  };
  worker.on("error", (error) => handBack(error.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      return worker.terminate();
    }),
  );
  writer.exec(`PRAGMA wal_autocheckpoint=${WRITER_BACKSTOP_FRAMES}`);
  const check = () => {
    if (stopped) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      worker.postMessage(null);
    } catch (cause) {
      handBack(String(cause));
    }
  };
  worker.on("message", (message: { ack: boolean; walBytes: number; blocked: boolean }) => {
    if (stopped) return;
    runFork(
      Effect.all([
        Metric.update(sqliteWalBytes, message.walBytes),
        Metric.update(sqliteCheckpointBlocked, message.blocked ? 1 : 0),
      ]),
    );
    // The idle callback reports diagnostics without acknowledging a request.
    if (!message.ack) return;
    checking = false;
    if (checkAgain) {
      checkAgain = false;
      check();
    }
  });
  worker.unref();
  return check;
});
