import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyPendingRestore } from "./backupService.ts";

const tempDirs: string[] = [];

function createDatabase(path: string, value: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'GlobalSearchFts');
    CREATE TABLE restore_marker (value TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO restore_marker (value) VALUES (?)").run(value);
  database.close();
}

function readDatabaseValue(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare("SELECT value FROM restore_marker").get() as { value: string }).value;
  } finally {
    database.close();
  }
}

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "f5-backup-restore-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("applyPendingRestore", () => {
  it("atomically replaces staged state, preserves credentials, and retains rollback data", async () => {
    const stateDir = await tempDir();
    const restoreId = "restore-test";
    const stagingDir = join(stateDir, "restore-staging", restoreId);
    const payloadDir = join(stagingDir, "payload");
    await mkdir(join(payloadDir, "attachments"), { recursive: true });
    await mkdir(join(stateDir, "attachments"), { recursive: true });
    await mkdir(join(stateDir, "secrets"), { recursive: true });
    createDatabase(join(stateDir, "state.sqlite"), "old-state");
    createDatabase(join(payloadDir, "database.sqlite"), "restored-state");
    await writeFile(join(stateDir, "settings.json"), '{"old":true}');
    await writeFile(join(payloadDir, "settings.json"), '{"restored":true}');
    await writeFile(join(stateDir, "attachments/old.txt"), "old attachment");
    await writeFile(join(payloadDir, "attachments/new.txt"), "new attachment");
    await writeFile(join(stateDir, "secrets/token"), "keep me");
    await writeFile(
      join(stateDir, "restore-pending.json"),
      JSON.stringify({
        version: 1,
        restoreId,
        stagedAt: "2026-01-02T00:00:00.000Z",
        sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        stagingDir,
        replaceSecrets: false,
      }),
    );

    const result = await applyPendingRestore({
      stateDir,
      dbPath: join(stateDir, "state.sqlite"),
      settingsPath: join(stateDir, "settings.json"),
      keybindingsConfigPath: join(stateDir, "keybindings.json"),
      attachmentsDir: join(stateDir, "attachments"),
      secretsDir: join(stateDir, "secrets"),
    });

    expect(result.status).toBe("applied");
    expect(readDatabaseValue(join(stateDir, "state.sqlite"))).toBe("restored-state");
    expect(await readFile(join(stateDir, "settings.json"), "utf8")).toContain("restored");
    expect(await readFile(join(stateDir, "attachments/new.txt"), "utf8")).toBe("new attachment");
    expect(await readFile(join(stateDir, "secrets/token"), "utf8")).toBe("keep me");
    expect(readDatabaseValue(join(result.rollbackDir!, "database.sqlite"))).toBe("old-state");
    await expect(readFile(join(stateDir, "restore-pending.json"))).rejects.toThrow();
  });

  it("restores the database and all sidecars when a staged move fails", async () => {
    const stateDir = await tempDir();
    const restoreId = "restore-rollback-test";
    const stagingDir = join(stateDir, "restore-staging", restoreId);
    const payloadDir = join(stagingDir, "payload");
    const sharedActivePath = join(stateDir, "shared-active-item");
    await mkdir(join(payloadDir, "attachments"), { recursive: true });
    await mkdir(sharedActivePath, { recursive: true });
    await writeFile(join(sharedActivePath, "original.txt"), "original active directory");
    createDatabase(join(stateDir, "state.sqlite"), "old-state");
    createDatabase(join(payloadDir, "database.sqlite"), "restored-state");
    await writeFile(join(payloadDir, "keybindings.json"), '{"restored":true}');
    const originalDatabase = await readFile(join(stateDir, "state.sqlite"));
    const sidecars = {
      "-wal": Buffer.from("original wal bytes"),
      "-shm": Buffer.from("original shm bytes"),
      "-journal": Buffer.from("original journal bytes"),
    } as const;
    for (const [suffix, bytes] of Object.entries(sidecars)) {
      await writeFile(join(stateDir, `state.sqlite${suffix}`), bytes);
    }
    await writeFile(
      join(stateDir, "restore-pending.json"),
      JSON.stringify({
        version: 1,
        restoreId,
        stagedAt: "2026-01-02T00:00:00.000Z",
        sourceCreatedAt: "2026-01-01T00:00:00.000Z",
        stagingDir,
        replaceSecrets: false,
      }),
    );

    await expect(
      applyPendingRestore({
        stateDir,
        dbPath: join(stateDir, "state.sqlite"),
        keybindingsConfigPath: sharedActivePath,
        attachmentsDir: join(sharedActivePath, "attachments"),
      }),
    ).rejects.toThrow("active state was rolled back");

    expect(await readFile(join(stateDir, "state.sqlite"))).toEqual(originalDatabase);
    for (const [suffix, bytes] of Object.entries(sidecars)) {
      expect(await readFile(join(stateDir, `state.sqlite${suffix}`))).toEqual(bytes);
    }
    expect(await readFile(join(sharedActivePath, "original.txt"), "utf8")).toBe(
      "original active directory",
    );
    expect(await readFile(join(stateDir, "restore-pending.json"), "utf8")).toContain(restoreId);
  });
});
