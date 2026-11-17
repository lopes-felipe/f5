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

export const sqliteCheckpointDuration = Metric.gauge("f5_sqlite_checkpoint_duration_ms", {
  description: "Duration of the checkpoint worker's latest passive checkpoint.",
});

const CHECKPOINT_FRAMES = 1_000;
const WRITER_BACKSTOP_FRAMES = 32_768;
const CHECKPOINT_IDLE_MS = 100;
/**
 * Checkpoints this slow are logged. The checkpoint runs off the server's thread and no
 * statement of the writer runs during one (see `startCheckpointWorker`), so a slow one
 * delays database work without stopping the event loop. The log line says how long.
 */
export const SLOW_CHECKPOINT_LOG_MS = 1_000;

/**
 * The worker never checkpoints unasked. An inspection (`null`) that finds one due answers
 * `due`, and the writer answers with that value once it holds its connection:
 * `"now"` for the frame threshold, `"finish"` for the tail left when writes go idle.
 */
export type CheckpointRequest = "now" | "finish";

// A source string works in both the bundled standalone server and source tests.
// NOOP was added in SQLite 3.51; older versions interpret it as PASSIVE.
export const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { closeSync, fstatSync, openSync } = require("node:fs");
const db = new DatabaseSync(workerData.filename);
// Startup can overlap the writer's schema or journal-mode initialization.
// Install the busy handler before preparing the first statement.
db.exec("PRAGMA busy_timeout=5000; PRAGMA checkpoint_fullfsync=ON;");
const version = db.prepare("SELECT sqlite_version() AS version").get().version;
const [major, minor] = version.split(".").map(Number);
if (major < 3 || (major === 3 && minor < 51)) throw new Error("SQLite " + version + " has no NOOP checkpoint");
const frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
let idle;
let blocked = false;
// permitted: the writer holds its connection for this checkpoint and waits for the answer.
const inspect = (finishing, permitted) => {
  let state = frames.get();
  let retry = false;
  // Set when this inspection ran a checkpoint: how long it took and how many frames it faced.
  let checkpointed = null;
  let due = null;
  const knownFrames = state.log >= 0 && state.checkpointed >= 0;
  if (state.busy !== 0 || !knownFrames) {
    // SQLite can return -1/-1 while its checkpoint lock is held. This is
    // unknown progress, not a completed checkpoint and not a contention claim.
    retry = state.busy !== 0 || blocked;
  }
  else if (finishing ? state.log >= workerData.frames && state.checkpointed < state.log
                     : state.log - state.checkpointed >= workerData.frames) {
    if (!permitted) due = finishing ? "finish" : "now";
    else {
      const startedAt = Date.now();
      const pending = state.log - state.checkpointed;
      state = checkpoint.get();
      checkpointed = { durationMs: Date.now() - startedAt, frames: pending };
      blocked = state.busy !== 0 || state.checkpointed < state.log;
      retry = blocked;
    }
  }
  else if (state.log === state.checkpointed) blocked = false;
  if (finishing && retry) {
    clearTimeout(idle);
    idle = setTimeout(() => inspect(true, false), workerData.idleMs);
  }
  // fstat on an open handle: Windows stat by name can report the size cached in the directory
  // entry, which stays stale while SQLite holds the WAL open.
  let walBytes = 0;
  let wal;
  try { wal = openSync(workerData.filename + "-wal", "r"); walBytes = fstatSync(wal).size; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { if (wal !== undefined) closeSync(wal); }
  // ack answers an inspection the writer asked for, done a checkpoint it is waiting on.
  parentPort.postMessage({ ack: !finishing && !permitted, done: permitted, due, walBytes, blocked, checkpointed });
};
parentPort.on("message", (request) => {
  if (request === "now" || request === "finish") inspect(request === "finish", true);
  else inspect(false, false);
  // A checkpoint that was blocked leaves a tail: look again once writes go idle.
  clearTimeout(idle);
  idle = setTimeout(() => inspect(true, false), workerData.idleMs);
});
`;

/**
 * At most one outstanding request and one pending check, irrespective of write rate.
 *
 * `holdConnection` runs an effect while no statement can run on the writer. A checkpoint
 * syncs the WAL, and a statement that touches the file meanwhile waits inside SQLite for
 * that sync, on the server's thread: seconds when the disk is busy. Holding the connection
 * makes those statements wait for it asynchronously, so the event loop keeps running.
 */
export const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: DatabaseSync,
  holdConnection: (checkpoint: Effect.Effect<void>) => Effect.Effect<void>,
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
  // From asking for the connection until the worker answers the checkpoint it was held for.
  let holding = false;
  let checkpointAnswered: (() => void) | undefined;
  const releaseConnection = () => {
    checkpointAnswered?.();
    checkpointAnswered = undefined;
  };
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    releaseConnection();
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
      releaseConnection();
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
  const checkpointHoldingConnection = (request: CheckpointRequest) => {
    if (holding) return;
    holding = true;
    runFork(
      holdConnection(
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              if (stopped) return resolve();
              checkpointAnswered = resolve;
              try {
                worker.postMessage(request);
              } catch (cause) {
                handBack(String(cause));
              }
            }),
        ),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            holding = false;
          }),
        ),
      ),
    );
  };
  type WorkerReport = {
    ack: boolean;
    done?: boolean;
    due?: CheckpointRequest | null;
    walBytes: number;
    blocked: boolean;
    checkpointed?: { durationMs: number; frames: number } | null;
  };
  worker.on("message", (message: WorkerReport) => {
    if (stopped) return;
    if (message.done) releaseConnection();
    else if (message.due) checkpointHoldingConnection(message.due);
    const checkpointed = message.checkpointed ?? null;
    runFork(
      Effect.all([
        Metric.update(sqliteWalBytes, message.walBytes),
        Metric.update(sqliteCheckpointBlocked, message.blocked ? 1 : 0),
        checkpointed === null
          ? Effect.void
          : Metric.update(sqliteCheckpointDuration, checkpointed.durationMs),
        checkpointed !== null && checkpointed.durationMs >= SLOW_CHECKPOINT_LOG_MS
          ? Effect.logWarning("slow sqlite checkpoint", {
              durationMs: checkpointed.durationMs,
              frames: checkpointed.frames,
              walBytes: message.walBytes,
              blocked: message.blocked,
            })
          : Effect.void,
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
