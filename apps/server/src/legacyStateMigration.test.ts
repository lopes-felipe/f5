import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  LEGACY_STATE_MIGRATION_FAILURE_SENTINEL,
  migrateLegacyT3StateIfNeeded,
  shouldMigrateLegacyT3State,
} from "./legacyStateMigration";

function makeTempRoot(): string {
  return FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-legacy-state-"));
}

function writeSqliteDb(dbPath: string, value: string): void {
  FS.mkdirSync(Path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("CREATE TABLE items (value TEXT NOT NULL);");
    database.prepare("INSERT INTO items (value) VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

function readSqliteValue(dbPath: string): string {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM items").get() as { value: string };
    return row.value;
  } finally {
    database.close();
  }
}

describe("migrateLegacyT3StateIfNeeded", () => {
  it("runs only for implicit production userdata state dirs", () => {
    expect(
      shouldMigrateLegacyT3State({
        baseDir: "/tmp/f5-home",
        stateDir: "/tmp/f5-home/userdata",
        hasExplicitStateDir: false,
        devUrl: undefined,
      }),
    ).toBe(true);
    expect(
      shouldMigrateLegacyT3State({
        baseDir: "/tmp/f5-home",
        stateDir: "/tmp/f5-home/userdata",
        hasExplicitStateDir: true,
        devUrl: undefined,
      }),
    ).toBe(false);
    expect(
      shouldMigrateLegacyT3State({
        baseDir: "/tmp/f5-home",
        stateDir: "/tmp/f5-home/dev",
        hasExplicitStateDir: false,
        devUrl: new URL("http://localhost:5173"),
      }),
    ).toBe(false);
  });

  it("copies legacy database and non-database state into the F5 target", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");
      FS.mkdirSync(Path.join(legacyStateDir, "attachments", "thread-1"), { recursive: true });
      FS.writeFileSync(Path.join(legacyStateDir, "attachments", "thread-1", "0.txt"), "attachment");
      FS.writeFileSync(Path.join(legacyStateDir, "keybindings.json"), "{}");
      FS.writeFileSync(Path.join(legacyStateDir, "state.sqlite-wal"), "sidecar");

      const result = await Effect.runPromise(
        migrateLegacyT3StateIfNeeded({ legacyStateDir, targetStateDir }),
      );

      expect(result.status).toBe("migrated");
      expect(readSqliteValue(Path.join(targetStateDir, "state.sqlite"))).toBe("legacy-row");
      expect(
        FS.readFileSync(Path.join(targetStateDir, "attachments", "thread-1", "0.txt"), "utf8"),
      ).toBe("attachment");
      expect(FS.readFileSync(Path.join(targetStateDir, "keybindings.json"), "utf8")).toBe("{}");
      expect(FS.existsSync(Path.join(targetStateDir, "state.sqlite-wal"))).toBe(false);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the legacy directory untouched after migration", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      const legacyDbPath = Path.join(legacyStateDir, "state.sqlite");
      writeSqliteDb(legacyDbPath, "legacy-row");
      FS.writeFileSync(Path.join(legacyStateDir, "keybindings.json"), '{"legacy":true}');

      await Effect.runPromise(migrateLegacyT3StateIfNeeded({ legacyStateDir, targetStateDir }));

      expect(readSqliteValue(legacyDbPath)).toBe("legacy-row");
      expect(FS.readFileSync(Path.join(legacyStateDir, "keybindings.json"), "utf8")).toBe(
        '{"legacy":true}',
      );
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips migration when the F5 database already exists", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");
      writeSqliteDb(Path.join(targetStateDir, "state.sqlite"), "f5-row");

      const result = await Effect.runPromise(
        migrateLegacyT3StateIfNeeded({ legacyStateDir, targetStateDir }),
      );

      expect(result).toEqual({ status: "skipped", reason: "target-db-exists" });
      expect(readSqliteValue(Path.join(targetStateDir, "state.sqlite"))).toBe("f5-row");
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips migration when another process creates the target database during cloning", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      const targetParentDir = Path.dirname(targetStateDir);
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");

      const result = await Effect.runPromise(
        migrateLegacyT3StateIfNeeded({
          legacyStateDir,
          targetStateDir,
          cloneSqliteDatabase: async (_sourceDbPath, tempDbPath) => {
            writeSqliteDb(Path.join(targetStateDir, "state.sqlite"), "other-process-row");
            writeSqliteDb(tempDbPath, "temp-row");
          },
        }),
      );

      expect(result).toEqual({ status: "skipped", reason: "target-db-exists" });
      expect(readSqliteValue(Path.join(targetStateDir, "state.sqlite"))).toBe("other-process-row");
      const leftovers = FS.readdirSync(targetParentDir).filter((name) =>
        name.startsWith(".userdata.legacy-migration-"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates when the target directory only contains ignorable filesystem metadata", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");
      FS.mkdirSync(targetStateDir, { recursive: true });
      FS.writeFileSync(Path.join(targetStateDir, ".DS_Store"), "");

      const result = await Effect.runPromise(
        migrateLegacyT3StateIfNeeded({ legacyStateDir, targetStateDir }),
      );

      expect(result.status).toBe("migrated");
      expect(readSqliteValue(Path.join(targetStateDir, "state.sqlite"))).toBe("legacy-row");
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips migration after a recorded previous failure", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");
      FS.mkdirSync(targetStateDir, { recursive: true });
      FS.writeFileSync(Path.join(targetStateDir, LEGACY_STATE_MIGRATION_FAILURE_SENTINEL), "{}");

      const result = await Effect.runPromise(
        migrateLegacyT3StateIfNeeded({ legacyStateDir, targetStateDir }),
      );

      expect(result).toEqual({ status: "skipped", reason: "previous-failure" });
      expect(FS.existsSync(Path.join(targetStateDir, "state.sqlite"))).toBe(false);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans partial temp output when migration fails", async () => {
    const root = makeTempRoot();
    try {
      const legacyStateDir = Path.join(root, ".t3", "userdata");
      const targetStateDir = Path.join(root, ".f5", "userdata");
      const targetParentDir = Path.dirname(targetStateDir);
      writeSqliteDb(Path.join(legacyStateDir, "state.sqlite"), "legacy-row");
      FS.mkdirSync(Path.join(legacyStateDir, "attachments"), { recursive: true });

      await expect(
        Effect.runPromise(
          migrateLegacyT3StateIfNeeded({
            legacyStateDir,
            targetStateDir,
            cloneSqliteDatabase: async () => {
              throw new Error("clone failed");
            },
          }),
        ),
      ).rejects.toMatchObject({
        _tag: "LegacyStateMigrationError",
      });

      const leftovers = FS.readdirSync(targetParentDir).filter((name) =>
        name.startsWith(".userdata.legacy-migration-"),
      );
      expect(leftovers).toEqual([]);
      expect(FS.existsSync(targetStateDir)).toBe(false);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
});
