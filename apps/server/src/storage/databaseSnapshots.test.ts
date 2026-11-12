import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { listDatabaseSnapshots } from "../persistence/databaseFiles.ts";
import {
  reportDatabaseCorruption,
  resetDatabaseHealthForTest,
} from "../persistence/databaseHealth.ts";
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import {
  mountFsType,
  prepareClone,
  retentionTierForFreeBytes,
  runDatabaseSnapshot,
  selectRetainedSnapshots,
  SNAPSHOT_RETENTION,
  type CloneFile,
} from "./databaseSnapshots.ts";

const HOUR_MS = 60 * 60 * 1000;
const GIB = 1024 ** 3;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetDatabaseHealthForTest();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeDatabase() {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-db-snapshots-"));
  const dbPath = Path.join(root, "state.sqlite");
  const runtime = ManagedRuntime.make(makeRuntimeSqliteLayer({ filename: dbPath }));
  cleanups.push(async () => {
    await runtime.dispose();
    FS.rmSync(root, { recursive: true, force: true });
  });
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE notes (body TEXT NOT NULL)`;
      yield* sql`INSERT INTO notes (body) VALUES ('kept in the WAL')`;
    }),
  );
  return { root, dbPath, directory: Path.join(root, "backups"), runtime };
}

function seedSnapshots(directory: string, createdAts: ReadonlyArray<number>) {
  for (const createdAt of createdAts) {
    FS.mkdirSync(Path.join(directory, `snapshot-${createdAt}`), { recursive: true });
    FS.writeFileSync(Path.join(directory, `snapshot-${createdAt}`, "state.sqlite"), "old");
  }
}

const unsupportedClone: CloneFile = async () => {
  throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
};

// CI volumes (ext4, NTFS) cannot clone; a plain copy exercises the same
// transaction, publish and retention logic.
const copyClone: CloneFile = (source, destination) =>
  FS.promises.copyFile(source, destination, FS.constants.COPYFILE_EXCL);

async function expectSnapshotRows(snapshot: string) {
  const reopened = new DatabaseSync(Path.join(snapshot, "state.sqlite"));
  try {
    expect(reopened.prepare("SELECT body FROM notes").all()).toEqual([{ body: "kept in the WAL" }]);
    expect(
      (reopened.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    ).toBe("ok");
  } finally {
    reopened.close();
  }
}

describe("runDatabaseSnapshot", () => {
  it("publishes a snapshot that opens with the committed rows", async () => {
    const db = await makeDatabase();
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
      }),
    );
    expect(result.status).toBe("published");
    await expectSnapshotRows(Path.join(db.directory, `snapshot-${NOW}`));
  });

  it("clones with the real copy-on-write primitive, or reports the volume unsupported", async () => {
    const db = await makeDatabase();
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({ dbPath: db.dbPath, directory: db.directory, now: NOW }),
    );
    if (result.status === "unsupported") {
      // Expected off APFS; never a silent full copy.
      expect(listDatabaseSnapshots(db.directory)).toEqual([]);
      return;
    }
    expect(result.status).toBe("published");
    await expectSnapshotRows(Path.join(db.directory, `snapshot-${NOW}`));
  });

  it.runIf(process.platform === "darwin")(
    "clones on macOS through clonefile(2), not libuv's silent full copy",
    async () => {
      const db = await makeDatabase();
      FS.mkdirSync(db.directory, { recursive: true });
      const clone = await prepareClone(db.dbPath, db.directory);
      // The temporary directory sits on the APFS data volume on every supported macOS.
      expect(typeof clone).toBe("function");
      const target = Path.join(db.directory, "clone.sqlite");
      await (clone as CloneFile)(db.dbPath, target);
      expect(FS.readFileSync(target)).toEqual(FS.readFileSync(db.dbPath));
    },
  );

  it("reads the filesystem type for mount points that contain parentheses", () => {
    const mounts = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
      "/dev/disk5s1 on /Volumes/Backup (old) (hfs, local, nodev, nosuid, journaled)",
    ].join("\n");
    expect(mountFsType(mounts, "/System/Volumes/Data")).toBe("apfs");
    expect(mountFsType(mounts, "/Volumes/Backup (old)")).toBe("hfs");
    expect(mountFsType(mounts, "/Volumes/Missing")).toBeNull();
  });

  it("skips a live file that is not a SQLite database", async () => {
    const db = await makeDatabase();
    const broken = Path.join(db.root, "broken.sqlite");
    FS.writeFileSync(broken, "ready");
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({ dbPath: broken, directory: db.directory, now: NOW }),
    );
    expect(result).toEqual({ status: "skipped", reason: "invalid-header" });
    expect(listDatabaseSnapshots(db.directory)).toEqual([]);
  });

  it("reports unsupported volumes without leaving partial copies or pruning", async () => {
    const db = await makeDatabase();
    const old = Array.from({ length: 30 }, (_, index) => NOW - (index + 2) * HOUR_MS);
    seedSnapshots(db.directory, old);
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: unsupportedClone,
      }),
    );
    expect(result).toEqual({ status: "unsupported", code: "ENOTSUP" });
    expect(FS.readdirSync(db.directory).filter((name) => name.includes(".partial"))).toEqual([]);
    expect(listDatabaseSnapshots(db.directory)).toHaveLength(30);
  });

  it("prunes beyond 24 hourly and 7 daily copies only after publishing", async () => {
    const db = await makeDatabase();
    const hourly = Array.from({ length: 30 }, (_, index) => NOW - (index + 2) * HOUR_MS);
    const daily = Array.from({ length: 10 }, (_, index) => NOW - (index + 3) * 24 * HOUR_MS);
    seedSnapshots(db.directory, [...hourly, ...daily]);
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
        freeBytes: async () => 64 * GIB,
      }),
    );
    expect(result.status).toBe("published");
    const remaining = listDatabaseSnapshots(db.directory).map((entry) => entry.createdAt);
    expect(remaining.slice(0, 24)).toEqual([NOW, ...hourly.slice(0, 23)]);
    expect(remaining.every((createdAt) => createdAt >= NOW - 7 * 24 * HOUR_MS)).toBe(true);
    expect(remaining).toContain(daily[3]);
    expect(remaining).not.toContain(daily[9]);
  });

  it("thins the history to 6 hourly and 3 daily copies when the volume is low on space", async () => {
    const db = await makeDatabase();
    const hourly = Array.from({ length: 30 }, (_, index) => NOW - (index + 2) * HOUR_MS);
    const daily = Array.from({ length: 10 }, (_, index) => NOW - (index + 3) * 24 * HOUR_MS);
    seedSnapshots(db.directory, [...hourly, ...daily]);
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
        freeBytes: async () => 5 * GIB,
      }),
    );
    expect(result.status).toBe("published");
    const remaining = listDatabaseSnapshots(db.directory).map((entry) => entry.createdAt);
    // NOW is 12:00 UTC: the newest six, then the newest copy of each earlier
    // day inside the three-day window (the day before, and exactly three days ago).
    expect(remaining).toEqual([NOW, ...hourly.slice(0, 5), NOW - 13 * HOUR_MS, daily[0]]);
  });

  it("keeps the full history when free space cannot be read", async () => {
    const db = await makeDatabase();
    const hourly = Array.from({ length: 30 }, (_, index) => NOW - (index + 2) * HOUR_MS);
    seedSnapshots(db.directory, hourly);
    await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
        freeBytes: async () => null,
      }),
    );
    expect(listDatabaseSnapshots(db.directory).length).toBeGreaterThanOrEqual(24);
  });

  it("ignores and removes snapshot directories that cleanup emptied", async () => {
    const db = await makeDatabase();
    const husk = Path.join(db.directory, `snapshot-${NOW - 30 * 60 * 1000}`);
    FS.mkdirSync(husk, { recursive: true });
    // A husk is newer than any real snapshot here, and must not count as "recent".
    expect(listDatabaseSnapshots(db.directory)).toEqual([]);
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
      }),
    );
    expect(result.status).toBe("published");
    expect(FS.existsSync(husk)).toBe(false);
    expect(listDatabaseSnapshots(db.directory).map((entry) => entry.createdAt)).toEqual([NOW]);
  });

  it("leaves a snapshot directory that holds anything other than a database", async () => {
    const db = await makeDatabase();
    const odd = Path.join(db.directory, `snapshot-${NOW - 3 * HOUR_MS}`);
    FS.mkdirSync(odd, { recursive: true });
    FS.writeFileSync(Path.join(odd, "notes.txt"), "kept");
    await db.runtime.runPromise(
      runDatabaseSnapshot({
        dbPath: db.dbPath,
        directory: db.directory,
        now: NOW,
        clone: copyClone,
      }),
    );
    expect(FS.readFileSync(Path.join(odd, "notes.txt"), "utf8")).toBe("kept");
  });

  it("stands down while the database is damaged", async () => {
    const db = await makeDatabase();
    seedSnapshots(
      db.directory,
      Array.from({ length: 30 }, (_, index) => NOW - (index + 2) * HOUR_MS),
    );
    reportDatabaseCorruption(db.dbPath, Object.assign(new Error("malformed"), { errcode: 11 }));
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({ dbPath: db.dbPath, directory: db.directory, now: NOW }),
    );
    expect(result).toEqual({ status: "skipped", reason: "damaged" });
    expect(listDatabaseSnapshots(db.directory)).toHaveLength(30);
  });

  it("skips when a snapshot was published within the hour", async () => {
    const db = await makeDatabase();
    seedSnapshots(db.directory, [NOW - 10 * 60 * 1000]);
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({ dbPath: db.dbPath, directory: db.directory, now: NOW }),
    );
    expect(result).toEqual({ status: "skipped", reason: "recent" });
  });
});

describe("selectRetainedSnapshots", () => {
  it("keeps the newest snapshot of each of the last seven days", () => {
    const entries = Array.from({ length: 10 }, (_, day) =>
      Array.from({ length: 6 }, (_, hour) => NOW - day * 24 * HOUR_MS - (hour + 1) * HOUR_MS),
    )
      .flat()
      .map((createdAt) => ({ name: `snapshot-${createdAt}`, path: "", createdAt }));
    const keep = selectRetainedSnapshots(entries, NOW);
    expect(keep.size).toBeLessThanOrEqual(24 + 7);
    expect(keep.has(`snapshot-${NOW - 6 * 24 * HOUR_MS - HOUR_MS}`)).toBe(true);
    expect(keep.has(`snapshot-${NOW - 9 * 24 * HOUR_MS - HOUR_MS}`)).toBe(false);
  });

  it("keeps only the newest two copies in the critical tier", () => {
    const entries = Array.from({ length: 40 }, (_, hour) => NOW - (hour + 1) * HOUR_MS).map(
      (createdAt) => ({ name: `snapshot-${createdAt}`, path: "", createdAt }),
    );
    expect([...selectRetainedSnapshots(entries, NOW, SNAPSHOT_RETENTION.critical)]).toEqual([
      `snapshot-${NOW - HOUR_MS}`,
      `snapshot-${NOW - 2 * HOUR_MS}`,
    ]);
  });
});

describe("retentionTierForFreeBytes", () => {
  it("switches tiers at the low and critical disk space thresholds", () => {
    expect(retentionTierForFreeBytes(10 * GIB)).toBe(SNAPSHOT_RETENTION.normal);
    expect(retentionTierForFreeBytes(10 * GIB - 1)).toBe(SNAPSHOT_RETENTION.low);
    expect(retentionTierForFreeBytes(2 * GIB)).toBe(SNAPSHOT_RETENTION.low);
    expect(retentionTierForFreeBytes(2 * GIB - 1)).toBe(SNAPSHOT_RETENTION.critical);
    expect(retentionTierForFreeBytes(0)).toBe(SNAPSHOT_RETENTION.critical);
  });

  it("keeps the full history when free space is unknown", () => {
    expect(retentionTierForFreeBytes(null)).toBe(SNAPSHOT_RETENTION.normal);
    expect(retentionTierForFreeBytes(Number.NaN)).toBe(SNAPSHOT_RETENTION.normal);
  });
});
