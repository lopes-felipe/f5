import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { openRuntimeSqliteDatabase } from "../persistence/runtimeSqlite.ts";
import { vacuumFreeSpaceShortfall } from "./databaseSpace.ts";
import * as FS from "node:fs/promises";

/** Runs only inside the owned maintenance process. */
export async function compactDatabaseFile(dbPath: string): Promise<void> {
  const database = await openRuntimeSqliteDatabase(dbPath, { readOnly: false });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const read = (pragma: string) =>
      Number(
        Object.values(database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[0],
      );
    const shortfall = await vacuumFreeSpaceShortfall({
      dbPath,
      liveBytes: (read("page_count") - read("freelist_count")) * read("page_size"),
      statfs: FS.statfs,
    });
    if (shortfall) throw new Error(`Cannot compact database: ${shortfall}.`);
    database.exec(
      "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
    );
  } finally {
    database.close();
  }
}
function runDatabaseMaintenance(dbPath: string, signal: AbortSignal): Promise<void> {
  const source = import.meta.url.endsWith(".ts");
  const entry = source
    ? fileURLToPath(new URL("../backupMaintenanceEntry.ts", import.meta.url))
    : fileURLToPath(
        new URL(
          `./maintenance/backup-maintenance.${import.meta.url.endsWith(".cjs") ? "cjs" : "mjs"}`,
          import.meta.url,
        ),
      );
  const args =
    process.env.F5_STANDALONE === "1"
      ? ["--internal-backup-export"]
      : [entry, "--internal-backup-export"];
  return new Promise((resolve, reject) => {
    const child = spawn(
      source && process.versions.bun === undefined ? "bun" : process.execPath,
      args,
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let output = "",
      failure: Error | undefined;
    const abort = () => {
      failure ??= new Error("Database compaction cancelled.");
      child.kill("SIGKILL");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 8192) abort();
    });
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    signal.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
        return;
      }
      try {
        const response = JSON.parse(output) as { compacted?: boolean; error?: string };
        if (code !== 0 || !response.compacted)
          throw new Error(response.error ?? "Database maintenance process failed.");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    if (signal.aborted) abort();
    else child.stdin.end(JSON.stringify({ kind: "compact-database", dbPath }));
  });
}
/** Finalization waits for child exit before the caller releases its SQL reservation. */
export const databaseMaintenanceEffect = (dbPath: string, cancelled: () => boolean = () => false) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const timer = setInterval(() => {
        if (cancelled()) controller.abort();
      }, 100);
      const result = runDatabaseMaintenance(dbPath, controller.signal);
      return { controller, timer, result };
    }),
    ({ result }) => Effect.tryPromise(() => result),
    ({ controller, timer, result }) =>
      Effect.promise(async () => {
        clearInterval(timer);
        controller.abort();
        await result.catch(() => {});
      }),
  );
