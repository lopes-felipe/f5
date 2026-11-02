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
  runDatabaseSnapshot,
  selectRetainedSnapshots,
  type CloneFile,
} from "./databaseSnapshots.ts";

const HOUR_MS = 60 * 60 * 1000;
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

describe("runDatabaseSnapshot", () => {
  it("publishes a clone that opens with the committed rows", async () => {
    const db = await makeDatabase();
    const result = await db.runtime.runPromise(
      runDatabaseSnapshot({ dbPath: db.dbPath, directory: db.directory, now: NOW }),
    );
    expect(result.status).toBe("published");
    const snapshot = Path.join(db.directory, `snapshot-${NOW}`);
    const reopened = new DatabaseSync(Path.join(snapshot, "state.sqlite"));
    try {
      expect(reopened.prepare("SELECT body FROM notes").all()).toEqual([
        { body: "kept in the WAL" },
      ]);
      expect(
        (reopened.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
          .integrity_check,
      ).toBe("ok");
    } finally {
      reopened.close();
    }
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
      runDatabaseSnapshot({ dbPath: db.dbPath, directory: db.directory, now: NOW }),
    );
    expect(result.status).toBe("published");
    const remaining = listDatabaseSnapshots(db.directory).map((entry) => entry.createdAt);
    expect(remaining.slice(0, 24)).toEqual([NOW, ...hourly.slice(0, 23)]);
    expect(remaining.every((createdAt) => createdAt >= NOW - 7 * 24 * HOUR_MS)).toBe(true);
    expect(remaining).toContain(daily[3]);
    expect(remaining).not.toContain(daily[9]);
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
});
