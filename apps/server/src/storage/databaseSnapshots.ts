/**
 * databaseSnapshots - Hourly copy-on-write clones of the profile database.
 *
 * The opt-in `.f5backup` export copies the whole database, which is too slow
 * and large to run by default on a 20 GB profile. A clone of `state.sqlite`
 * and its WAL costs almost nothing on APFS and is a complete, openable copy,
 * so these run by default and keep 24 hourly and 7 daily copies.
 *
 * Consistency: the clones are taken while holding the write lock
 * (`BEGIN IMMEDIATE`). No commit can happen and the WAL cannot be reset while
 * the lock is held; a concurrent passive checkpoint may copy frames into the
 * main file, but those frames stay in the WAL that is cloned afterwards, so
 * opening the snapshot replays them.
 *
 * Volumes without clone support get status `unsupported`; a full copy is never
 * made implicitly.
 *
 * @module databaseSnapshots
 */
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { Data, Effect, Schedule, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import {
  databaseSnapshotName,
  databaseSnapshotsDir,
  inspectDatabaseHeader,
  listDatabaseSnapshots,
  type DatabaseSnapshotEntry,
} from "../persistence/databaseFiles.ts";
import { getDatabaseDamage } from "../persistence/databaseHealth.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_INTERVAL_MS = 55 * 60 * 1000;
const HOURLY_RETAINED = 24;
const DAILY_RETAINED = 7;
const PARTIAL_SUFFIX = ".partial";
const STATUS_FILE = "snapshot-status.json";
const UNSUPPORTED_CODES = new Set(["ENOTSUP", "EXDEV", "ENOSYS", "EOPNOTSUPP", "EINVAL"]);

const gate = Semaphore.makeUnsafe(1);

export class DatabaseSnapshotError extends Data.TaggedError("DatabaseSnapshotError")<{
  readonly code: string | null;
  readonly cause: unknown;
}> {}

export type DatabaseSnapshotResult =
  | { readonly status: "published"; readonly path: string; readonly pruned: number }
  | {
      readonly status: "skipped";
      readonly reason: "damaged" | "recent" | "missing" | "invalid-header";
    }
  | { readonly status: "unsupported"; readonly code: string };

export type CloneFile = (source: string, destination: string) => Promise<void>;

const execFileAsync = promisify(execFile);

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** The mount point and filesystem type holding `path` (macOS). */
async function darwinMount(path: string): Promise<{ mountPoint: string; fsType: string } | null> {
  const { stdout: df } = await execFileAsync("/bin/df", ["-P", path]);
  const mountPoint = df.trim().split("\n").at(-1)?.split(/\s+/).slice(5).join(" ");
  if (!mountPoint) return null;
  const { stdout: mounts } = await execFileAsync("/sbin/mount");
  for (const line of mounts.split("\n")) {
    const match = / on (.+) \(([^,)]+)/.exec(line);
    if (match?.[1] === mountPoint) return { mountPoint, fsType: match[2]! };
  }
  return null;
}

// libuv has no COPYFILE_FICLONE_FORCE on macOS (ENOSYS), and COPYFILE_FICLONE
// silently falls back to a full copy. Only clone where clonefile(2) will work.
const cloneFile: CloneFile = async (source, destination) => {
  if (process.platform !== "darwin") {
    await copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
    return;
  }
  const [from, to] = await Promise.all([
    darwinMount(dirname(source)),
    darwinMount(dirname(destination)),
  ]);
  if (from?.fsType !== "apfs") throw errnoError("ENOTSUP", `${source} is not on an APFS volume`);
  if (to?.mountPoint !== from.mountPoint)
    throw errnoError("EXDEV", `${destination} is on a different volume than ${source}`);
  await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
};

export interface RunDatabaseSnapshotInput {
  readonly dbPath: string;
  readonly directory: string;
  readonly now?: number;
  readonly clone?: CloneFile;
}

/**
 * Snapshots to keep: the newest {@link HOURLY_RETAINED}, plus the newest of
 * each UTC day for the last {@link DAILY_RETAINED} days.
 */
export function selectRetainedSnapshots(
  snapshots: ReadonlyArray<DatabaseSnapshotEntry>,
  now: number,
): Set<string> {
  const newestFirst = snapshots.toSorted((left, right) => right.createdAt - left.createdAt);
  const keep = new Set(newestFirst.slice(0, HOURLY_RETAINED).map((entry) => entry.name));
  const days = new Set<number>();
  for (const entry of newestFirst) {
    if (entry.createdAt < now - DAILY_RETAINED * DAY_MS) break;
    const day = Math.floor(entry.createdAt / DAY_MS);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(entry.name);
  }
  return keep;
}

async function removePartials(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory() && /^snapshot-\d{13}\.partial-/.test(entry.name))
      await rm(join(directory, entry.name), { recursive: true, force: true });
}

async function prune(directory: string, now: number): Promise<number> {
  // Never discard a known-good copy while the live database is damaged.
  if (getDatabaseDamage() !== null) return 0;
  const snapshots = listDatabaseSnapshots(directory);
  const keep = selectRetainedSnapshots(snapshots, now);
  let pruned = 0;
  for (const snapshot of snapshots) {
    if (keep.has(snapshot.name)) continue;
    await rm(snapshot.path, { recursive: true, force: true });
    pruned += 1;
  }
  return pruned;
}

async function writeStatus(directory: string, result: DatabaseSnapshotResult, at: number) {
  const temporary = join(directory, `${STATUS_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ at: new Date(at).toISOString(), ...result }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, join(directory, STATUS_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Takes one snapshot unless one was published within the last hour. */
export const runDatabaseSnapshot = (input: RunDatabaseSnapshotInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = input.now ?? Date.now();
    const clone = input.clone ?? cloneFile;
    const { dbPath, directory } = input;

    if (getDatabaseDamage() !== null) return { status: "skipped", reason: "damaged" } as const;
    const header = inspectDatabaseHeader(dbPath);
    if (header.status === "missing" || header.status === "empty")
      return { status: "skipped", reason: "missing" } as const;
    if (header.status === "invalid")
      return { status: "skipped", reason: "invalid-header" } as const;

    yield* Effect.promise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await removePartials(directory);
    });
    const latest = listDatabaseSnapshots(directory)[0];
    if (latest && now - latest.createdAt < MIN_INTERVAL_MS && latest.createdAt <= now)
      return { status: "skipped", reason: "recent" } as const;

    const name = databaseSnapshotName(now);
    const partial = join(directory, `${name}${PARTIAL_SUFFIX}-${randomUUID()}`);
    const published = join(directory, name);
    const cloned = yield* sql
      .withTransaction(
        Effect.tryPromise({
          try: async () => {
            await mkdir(partial, { mode: 0o700 });
            await clone(dbPath, join(partial, "state.sqlite"));
            if (existsSync(`${dbPath}-wal`))
              await clone(`${dbPath}-wal`, join(partial, "state.sqlite-wal"));
          },
          catch: (cause) =>
            new DatabaseSnapshotError({
              code: (cause as NodeJS.ErrnoException).code ?? null,
              cause,
            }),
        }),
      )
      .pipe(
        Effect.map(() => null),
        Effect.catch((error) =>
          error._tag === "DatabaseSnapshotError" &&
          error.code !== null &&
          UNSUPPORTED_CODES.has(error.code)
            ? Effect.succeed(error.code)
            : Effect.fail(error),
        ),
        Effect.onError(() => Effect.promise(() => rm(partial, { recursive: true, force: true }))),
      );
    if (cloned !== null) {
      yield* Effect.promise(() => rm(partial, { recursive: true, force: true }));
      return { status: "unsupported", code: cloned } as const;
    }

    yield* Effect.promise(() => rename(partial, published));
    const pruned = yield* Effect.promise(() => prune(directory, now));
    return { status: "published", path: published, pruned } as const;
  }).pipe(
    Effect.tap((result: DatabaseSnapshotResult) =>
      Effect.promise(() => writeStatus(input.directory, result, input.now ?? Date.now())).pipe(
        Effect.catchCause(() => Effect.void),
      ),
    ),
    gate.withPermit,
  );

export const startDatabaseSnapshots = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const directory = databaseSnapshotsDir(config.stateDir);
  const tick = Effect.gen(function* () {
    if (!(yield* settings.getSettings).databaseSnapshotsEnabled) return;
    const result = yield* runDatabaseSnapshot({ dbPath: config.dbPath, directory });
    if (result.status === "unsupported")
      yield* Effect.logInfo("database snapshots unsupported on this volume", { code: result.code });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("database snapshot failed", { cause: String(cause) }),
    ),
  );
  yield* tick.pipe(
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.delay("5 minutes"),
    Effect.forkScoped,
  );
});
