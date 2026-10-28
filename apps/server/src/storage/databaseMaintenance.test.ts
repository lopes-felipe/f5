import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { openRuntimeSqliteDatabase } from "../persistence/runtimeSqlite.ts";
import { databaseMaintenanceEffect } from "./databaseMaintenance.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { Readable } from "node:stream";
const roots: string[] = [];
// Allow Windows process startup the suite's normal budget; the helper's
// post-parent-death exit deadline remains 1.5 seconds.
const parentDeathTimeout = process.platform === "win32" ? 30_000 : 15_000;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => FS.rm(path, { recursive: true, force: true })));
});
test("real helper compaction switches to incremental vacuum while the parent stays responsive", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-database-helper-"));
  roots.push(root);
  const path = Path.join(root, "state.sqlite");
  const database = await openRuntimeSqliteDatabase(path, { readOnly: false });
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE filler(value TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO filler SELECT printf('%.4000c','x') FROM n; DELETE FROM filler; PRAGMA wal_checkpoint(TRUNCATE)",
  );
  database.close();
  const before = (await FS.stat(path)).size;
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 1);
  try {
    await Effect.runPromise(databaseMaintenanceEffect(path));
  } finally {
    clearInterval(timer);
  }
  const compacted = await openRuntimeSqliteDatabase(path, { readOnly: true });
  try {
    expect(compacted.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  } finally {
    compacted.close();
  }
  expect((await FS.stat(path)).size).toBeLessThan(before);
  expect(heartbeats).toBeGreaterThan(0);
});
test("helper errors are reported only after the owned child has exited", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-database-helper-"));
  roots.push(root);
  const path = Path.join(root, "not-a-database");
  await FS.writeFile(path, "invalid database");
  await expect(Effect.runPromise(databaseMaintenanceEffect(path))).rejects.toThrow();
  expect(await FS.readFile(path, "utf8")).toBe("invalid database");
});

test(
  "parent death kills a helper blocked inside a real VACUUM and releases SQLite locks",
  async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-vacuum-parent-death-"));
    roots.push(root);
    const path = Path.join(root, "state.sqlite");
    const reader = await openRuntimeSqliteDatabase(path, { readOnly: false });
    reader.exec(
      "PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=DELETE; CREATE TABLE filler(value BLOB); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO filler SELECT zeroblob(4000) FROM n; DELETE FROM filler WHERE rowid % 2 = 0; BEGIN; SELECT COUNT(*) FROM filler;",
    );
    const entry = fileURLToPath(new URL("../backupMaintenanceEntry.ts", import.meta.url));
    const parentPath = Path.join(root, "parent.mjs");
    await FS.writeFile(
      parentPath,
      `
    import { spawn } from "node:child_process";
    const helper = spawn("bun", [${JSON.stringify(entry)}], { stdio: ["pipe", "pipe", 4, "pipe"] });
    helper.stdin.end(JSON.stringify({ kind: "compact-database", dbPath: ${JSON.stringify(path)} }));
    helper.stdout.pipe(process.stderr);
    console.log(helper.pid);
    helper.on("close", () => process.exit(0));
  `,
    );
    const parent = spawn(process.execPath, [parentPath], {
      stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
    });
    let diagnostics = "";
    parent.stderr!.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    const helperLifetime = parent.stdio[4] as Readable;
    helperLifetime.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
    // This pipe is also the helper's stderr. EOF requires both processes to
    // close it, and does not mistake an already-dead orphan zombie for a live helper.
    const helperExited = once(helperLifetime, "end");
    helperLifetime.resume();
    let helperPid: number | undefined;
    const alive = () => {
      try {
        if (helperPid) process.kill(helperPid, 0);
        return helperPid !== undefined;
      } catch {
        return false;
      }
    };
    try {
      const [pid] = await once(parent.stdout!, "data");
      helperPid = Number(String(pid).trim());
      expect(Number.isSafeInteger(helperPid)).toBe(true);
      // The read transaction prevents VACUUM's copy-back from completing. Its
      // rollback journal proves the helper has entered SQLite's synchronous work.
      await expect
        .poll(
          async () => {
            if (parent.exitCode !== null)
              throw new Error(diagnostics || "Maintenance parent exited before VACUUM.");
            return (await FS.stat(`${path}-journal`).catch(() => null))?.size ?? 0;
          },
          { timeout: 3000, interval: 5 },
        )
        .toBeGreaterThan(0);
      expect(alive()).toBe(true);
      const parentClosed = once(parent, "exit");
      parent.kill("SIGKILL");
      await parentClosed;
      let exitTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          helperExited,
          new Promise<never>((_, reject) => {
            exitTimeout = setTimeout(
              () => reject(new Error(`Compaction helper outlived its parent: ${diagnostics}`)),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(exitTimeout);
      }
      reader.exec("ROLLBACK");
      reader.exec(
        "PRAGMA busy_timeout=1000; INSERT INTO filler VALUES ('replacement backend can write')",
      );
      expect(reader.prepare("SELECT COUNT(*) AS count FROM filler").get()).toEqual({ count: 1001 });
    } finally {
      parent.kill("SIGKILL");
      try {
        if (alive() && helperPid) process.kill(helperPid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
      reader.close();
    }
  },
  parentDeathTimeout,
);
