import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Returning free database pages to the file system.
 *
 * Deleting rows only moves pages to SQLite's freelist; the file keeps its
 * size until a VACUUM. A full VACUUM rewrites the whole database: SQLite
 * copies the live pages to a temporary database and then back through the
 * WAL, so it needs about twice the live data in free disk, and it blocks every
 * other query while it runs. Nothing can tell that a user is about to come
 * back, so the automatic conversion picks a quiet moment and may still make
 * the app wait for a few minutes once. With `auto_vacuum = INCREMENTAL`, freed pages can
 * instead be returned in bounded steps with `PRAGMA incremental_vacuum(N)`.
 *
 * New databases are created incremental (the pragma runs before the first
 * table). An existing database switches with one full VACUUM, after which
 * the hourly storage job reclaims free pages in steps.
 */

export const AUTO_VACUUM_INCREMENTAL = 2;
/**
 * Free space one copy of the live (non-free) data needs during a full VACUUM.
 * There are two copies: the temporary database, in SQLite's temp directory,
 * and the rebuilt pages written back through the WAL, next to the database.
 */
const VACUUM_COPY_FACTOR = 1.1;
const INCREMENTAL_VACUUM_STEP_PAGES = 2_048;

type Statfs = (path: string) => Promise<{ bavail: number; bsize: number }>;

/** Where SQLite builds VACUUM's temporary database on Unix. */
export const sqliteTempDirectory = () =>
  process.env.SQLITE_TMPDIR || process.env.TMPDIR || OS.tmpdir();

/**
 * Why a full VACUUM would not fit on disk, or null when it does. Checks the
 * database's volume and the temp directory's, and adds both copies up when
 * they are the same volume.
 */
export async function vacuumFreeSpaceShortfall(input: {
  readonly dbPath: string;
  readonly liveBytes: number;
  readonly statfs: Statfs;
  readonly tempDirectory?: string;
}): Promise<string | null> {
  const copyBytes = input.liveBytes * VACUUM_COPY_FACTOR;
  const dbDirectory = Path.dirname(input.dbPath);
  const tempDirectory = input.tempDirectory ?? sqliteTempDirectory();
  const free = async (path: string) => {
    const stat = await input.statfs(path);
    return stat.bavail * stat.bsize;
  };
  const [dbStat, tempStat] = await Promise.all([
    FS.stat(dbDirectory),
    FS.stat(tempDirectory).catch(() => null),
  ]);
  if (tempStat === null || tempStat.dev === dbStat.dev) {
    return (await free(dbDirectory)) < copyBytes * 2
      ? `free disk is below ${VACUUM_COPY_FACTOR * 2}x the database's live data`
      : null;
  }
  if ((await free(dbDirectory)) < copyBytes) {
    return `free disk next to the database is below ${VACUUM_COPY_FACTOR}x its live data`;
  }
  if ((await free(tempDirectory)) < copyBytes) {
    return `free space in the temp directory (${tempDirectory}) is below ${VACUUM_COPY_FACTOR}x the database's live data`;
  }
  return null;
}

export interface DatabasePages {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  /** 0 none, 1 full, 2 incremental. */
  readonly autoVacuum: number;
}

export const liveDatabaseBytes = (pages: DatabasePages) =>
  Math.max(0, pages.pageCount - pages.freelistCount) * pages.pageSize;

export const freeDatabaseBytes = (pages: DatabasePages) => pages.freelistCount * pages.pageSize;

export const readDatabasePages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pageSize = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const pageCount = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const freelistCount = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const autoVacuum = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  return {
    pageSize: pageSize[0]?.page_size ?? 0,
    pageCount: pageCount[0]?.page_count ?? 0,
    freelistCount: freelistCount[0]?.freelist_count ?? 0,
    autoVacuum: autoVacuum[0]?.auto_vacuum ?? 0,
  } satisfies DatabasePages;
});

/**
 * Full VACUUM that also switches the database to incremental auto-vacuum.
 * Callers hold the storage maintenance lock and have checked free disk.
 */
export const vacuumToIncremental = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  yield* sql`VACUUM`;
  // VACUUM writes the rebuilt database through the WAL; truncate it so the
  // space comes back now rather than at the next checkpoint.
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
});

/**
 * Returns free pages to the file system in bounded steps until the freelist
 * is empty or the time budget runs out. A no-op unless the database is
 * incremental. Returns the number of pages released.
 */
export const incrementalVacuum = (input: { readonly maxDurationMs: number }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* readDatabasePages;
    if (before.autoVacuum !== AUTO_VACUUM_INCREMENTAL || before.freelistCount === 0) return 0;
    const startedAtMs = Date.now();
    let freelist = before.freelistCount;
    while (freelist > 0 && Date.now() - startedAtMs < input.maxDurationMs) {
      yield* sql.unsafe(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_STEP_PAGES})`);
      const rows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const next = rows[0]?.freelist_count ?? 0;
      if (next >= freelist) break;
      freelist = next;
      yield* Effect.yieldNow;
    }
    // The main file shrinks when the WAL is checkpointed.
    yield* sql`PRAGMA wal_checkpoint(PASSIVE)`;
    return before.freelistCount - freelist;
  });
