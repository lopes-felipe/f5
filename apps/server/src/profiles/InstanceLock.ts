import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { safeLstat } from "../storage/storagePathSafety";
import { Data, Effect } from "effect";

export class ProfileBusyError extends Data.TaggedError("ProfileBusyError")<{
  readonly message: string;
  readonly pid?: number;
}> {}
export class ProfileLockError extends Data.TaggedError("ProfileLockError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The SQLite connection, rather than a heartbeat or PID, owns exclusion. */
export async function acquireInstanceLock(lockPath: string): Promise<{ release(): void }> {
  let database: { exec(sql: string): unknown; close(): void } | undefined;
  try {
    await FS.mkdir(Path.dirname(lockPath), { recursive: true });
    for (const target of [Path.dirname(lockPath), lockPath + ".owner"])
      if ((await safeLstat(target))?.isSymbolicLink())
        throw new Error("Lock metadata cannot be a symbolic link or junction.");
    if ((await safeLstat(lockPath))?.isSymbolicLink())
      throw new Error("Lock path is a symbolic link.");
    database = process.versions.bun
      ? new (await import("bun:sqlite")).Database(lockPath)
      : new (await import("node:sqlite")).DatabaseSync(lockPath);
    database.exec(
      "PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (pid INTEGER); BEGIN EXCLUSIVE; DELETE FROM owner; INSERT INTO owner VALUES (" +
        process.pid +
        "); COMMIT;",
    );
    await FS.writeFile(lockPath + ".owner", String(process.pid), { mode: 0o600 });
    let released = false;
    const owned = database;
    return {
      release() {
        if (!released) {
          released = true;
          owned.close();
        }
      },
    };
  } catch (cause) {
    database?.close();
    if (/SQLITE_BUSY|database is locked/i.test(String(cause))) {
      const pid = Number(await FS.readFile(lockPath + ".owner", "utf8").catch(() => ""));
      throw new ProfileBusyError({
        message: `Profile is already running${pid ? ` in process ${pid}` : ""}. Stop it before continuing.`,
        ...(pid ? { pid } : {}),
      });
    }
    throw new ProfileLockError({
      message: `Cannot lock ${lockPath}. Use a writable local filesystem; network filesystems are unsupported. ${String(cause)}`,
      cause,
    });
  }
}
export const instanceLock = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => acquireInstanceLock(path),
      catch: (error) =>
        error instanceof ProfileBusyError || error instanceof ProfileLockError
          ? error
          : new ProfileLockError({ message: String(error) }),
    }),
    (lock) => Effect.sync(() => lock.release()),
  );
