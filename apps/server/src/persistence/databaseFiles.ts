/**
 * databaseFiles - File-level checks and snapshot layout for profile databases.
 *
 * A profile database once got overwritten with five bytes of test output while
 * F5 was running. These helpers let startup refuse such a file instead of
 * initializing a fresh database over it, and locate the automatic snapshots
 * written by `storage/databaseSnapshots.ts`.
 *
 * @module databaseFiles
 */
import * as FS from "node:fs";
import * as Path from "node:path";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/** Directory name of a published automatic snapshot; captures its creation time. */
export const DATABASE_SNAPSHOT_NAME = /^snapshot-(\d{13})$/;
const SNAPSHOT_NAME = DATABASE_SNAPSHOT_NAME;

/** Whether `name` is the directory name of a published automatic snapshot. */
export function isDatabaseSnapshotName(name: string): boolean {
  return SNAPSHOT_NAME.test(name);
}

export type DatabaseHeaderStatus =
  | { readonly status: "missing" }
  | { readonly status: "empty" }
  | { readonly status: "valid"; readonly pageSize: number; readonly sizeBytes: number }
  | { readonly status: "invalid"; readonly sizeBytes: number; readonly reason: string };

/**
 * Checks the SQLite magic string, the page size, and that the file is a whole
 * number of pages. Does not open the database.
 */
export function inspectDatabaseHeader(path: string): DatabaseHeaderStatus {
  let fd: number;
  try {
    fd = FS.openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const sizeBytes = FS.fstatSync(fd).size;
    if (sizeBytes === 0) return { status: "empty" };
    const header = Buffer.alloc(100);
    const read = FS.readSync(fd, header, 0, header.length, 0);
    if (read < header.length || !header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
      return { status: "invalid", sizeBytes, reason: "missing the SQLite file header" };
    }
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      return { status: "invalid", sizeBytes, reason: `invalid page size ${rawPageSize}` };
    }
    if (sizeBytes % pageSize !== 0) {
      return { status: "invalid", sizeBytes, reason: "size is not a whole number of pages" };
    }
    return { status: "valid", pageSize, sizeBytes };
  } finally {
    FS.closeSync(fd);
  }
}

/** Automatic snapshots live next to the scheduled `.f5backup` archives. */
export function databaseSnapshotsDir(stateDir: string): string {
  return Path.join(stateDir, "backups");
}

export function databaseSnapshotName(createdAt: number): string {
  return `snapshot-${createdAt}`;
}

export interface DatabaseSnapshotEntry {
  readonly name: string;
  readonly path: string;
  readonly createdAt: number;
}

/**
 * Published snapshots, newest first. `.partial` directories are excluded, and
 * so are directories without a `state.sqlite`: storage cleanup once emptied
 * snapshots without removing them, and such a husk is not a recovery copy.
 */
export function listDatabaseSnapshots(directory: string): DatabaseSnapshotEntry[] {
  let entries: FS.Dirent[];
  try {
    entries = FS.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .flatMap((entry) => {
      const match = entry.isDirectory() ? SNAPSHOT_NAME.exec(entry.name) : null;
      return match && FS.existsSync(Path.join(directory, entry.name, "state.sqlite"))
        ? [
            {
              name: entry.name,
              path: Path.join(directory, entry.name),
              createdAt: Number(match[1]),
            },
          ]
        : [];
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function latestDatabaseSnapshot(stateDir: string): string | null {
  return listDatabaseSnapshots(databaseSnapshotsDir(stateDir))[0]?.path ?? null;
}

/**
 * Refuses to open a non-empty file that is not a SQLite database. Opening it
 * would fail, and a fallback that re-creates the file would destroy whatever
 * forensic or partial data is left.
 */
export function assertDatabaseFileUsable(dbPath: string): void {
  const header = inspectDatabaseHeader(dbPath);
  if (header.status !== "invalid") return;
  const stateDir = Path.dirname(dbPath);
  const snapshot = latestDatabaseSnapshot(stateDir);
  const restore = snapshot
    ? `The newest automatic snapshot is ${snapshot}. To restore it, quit F5, move ${dbPath}, ${dbPath}-wal and ${dbPath}-shm aside, then copy the snapshot's state.sqlite (and state.sqlite-wal, if present) into ${stateDir}.`
    : `No automatic snapshot exists in ${databaseSnapshotsDir(stateDir)}. Keep the file for recovery and restore from another backup.`;
  throw new Error(
    `The F5 database at ${dbPath} is damaged (${header.reason}; ${header.sizeBytes} bytes). ` +
      `F5 will not open or replace it. ${restore}`,
  );
}
