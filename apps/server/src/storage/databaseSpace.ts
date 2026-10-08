import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Returning free database pages to the file system.
 *
 * Deleting rows only moves pages to SQLite's freelist; the file keeps its
 * size until a VACUUM. A full VACUUM rewrites the whole database: SQLite
 * copies the live pages to a temporary database and then back through the
 * WAL, so it needs about twice the live data in free disk, and it blocks every
 * other query while it runs. With `auto_vacuum = INCREMENTAL`, freed pages can
 * instead be returned in bounded steps with `PRAGMA incremental_vacuum(N)`.
 *
 * New databases are created incremental (the pragma runs before the first
 * table). An existing database switches with one full VACUUM, after which
 * the hourly storage job reclaims free pages in steps.
 */

export const AUTO_VACUUM_INCREMENTAL = 2;
/** Free disk a full VACUUM needs, as a multiple of the live (non-free) data. */
export const VACUUM_FREE_SPACE_FACTOR = 2.2;
const INCREMENTAL_VACUUM_STEP_PAGES = 2_048;

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
