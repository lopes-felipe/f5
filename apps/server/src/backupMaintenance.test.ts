import { DatabaseSync } from "node:sqlite";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRuntimeSqliteLayer } from "./persistence/Layers/Sqlite.ts";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConfig } from "./config.ts";
import { parseBackupArchive, resolveBackupRestoreLimits } from "./backupArchive.ts";
import { applyPendingRestore, makeBackupService } from "./backupService.ts";
import { backupMaintenanceEffect, runBackupMaintenance } from "./backupMaintenance.ts";
import { withAttachmentRetentionLease } from "./storage/attachmentRetention.ts";
import {
  listScheduledBackups,
  readScheduledBackupStatus,
  runScheduledBackup,
} from "./storage/scheduledBackups.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "f5-backup-helper-"));
  directories.push(directory);
  const runtime = ManagedRuntime.make(
    ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
  );
  const config = await runtime.runPromise(Effect.service(ServerConfig));
  await runtime.dispose();
  await mkdir(config.attachmentsDir, { recursive: true });
  await mkdir(config.secretsDir!, { recursive: true });
  await writeFile(join(config.attachmentsDir, "owned.txt"), "owned evidence");
  await writeFile(join(config.attachmentsDir, "unowned.txt"), "unowned");
  await writeFile(join(config.secretsDir!, "token"), "private-token");
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE effect_sql_migrations (migration_id INTEGER); INSERT INTO effect_sql_migrations VALUES(55);
    CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('original');
    CREATE TABLE attachments(attachment_id TEXT PRIMARY KEY, final_path TEXT, lifecycle TEXT);
    CREATE TABLE attachment_owners(attachment_id TEXT);
    CREATE TABLE attachment_cleanup_jobs(attachment_id TEXT PRIMARY KEY, path TEXT);
  `);
  db.prepare("INSERT INTO attachments VALUES ('owned', ?, 'ready')").run(
    join(config.attachmentsDir, "owned.txt"),
  );
  db.exec("INSERT INTO attachment_owners VALUES ('owned')");
  // The same basename in an unarchived path must never target owned bytes after restore.
  db.prepare("INSERT INTO attachments VALUES ('unowned', ?, 'deleting')").run(
    join(config.attachmentsDir, "other", "owned.txt"),
  );
  db.prepare("INSERT INTO attachment_cleanup_jobs VALUES ('unowned', ?)").run(
    join(config.attachmentsDir, "other", "owned.txt"),
  );
  db.prepare("INSERT INTO attachments VALUES ('unowned-file', ?, 'deleting')").run(
    join(config.attachmentsDir, "unowned.txt"),
  );
  return { directory, config, db };
}

describe("backup maintenance process", () => {
  it("exports a consistent snapshot with live writes and two open snapshot readers, retaining only owned attachments", async () => {
    const { directory, config, db } = await fixture();
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    const readers = Array.from({ length: 2 }, () =>
      ManagedRuntime.make(makeRuntimeSqliteLayer({ filename: config.dbPath, readonly: true })),
    );
    for (const reader of readers)
      await reader.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA query_only = ON`;
          yield* sql`SELECT * FROM marker`;
        }),
      );
    let writes = 0;
    const timer = setInterval(() => {
      db.prepare("INSERT INTO marker VALUES (?)").run(`write-${writes++}`);
    }, 5);
    try {
      const manifest = await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
      expect(writes).toBeGreaterThan(0);
      expect(manifest.files.map((file) => file.path)).toContain("attachments/owned.txt");
      expect(manifest.files.map((file) => file.path)).not.toContain("attachments/unowned.txt");
      expect(manifest.files.some((file) => file.path.startsWith("secrets/"))).toBe(false);
      const restored = await parseBackupArchive({
        source: createReadStream(join(stagingDir, "backup.f5backup")),
        stagingDir: join(directory, "restored"),
        limits: resolveBackupRestoreLimits(),
      });
      const snapshot = new DatabaseSync(join(restored.payloadDir, "database.sqlite"), {
        readOnly: true,
      });
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(snapshot.prepare("SELECT count(*) AS count FROM marker").get()).toMatchObject({
        count: expect.any(Number),
      });
      snapshot.close();
    } finally {
      clearInterval(timer);
      await Promise.all(readers.map((reader) => reader.dispose()));
      db.close();
    }
  });

  it("restores attachment ownership into another state directory and can export it again", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const firstStaging = join(directory, "first-export");
    await mkdir(firstStaging);
    const original = await runBackupMaintenance({
      config,
      stagingDir: firstStaging,
      includeSecrets: false,
    });
    const restoredDir = join(directory, "new-profile");
    await mkdir(restoredDir);
    const restored = {
      ...config,
      stateDir: restoredDir,
      dbPath: join(restoredDir, "state.sqlite"),
      attachmentsDir: join(restoredDir, "attachments"),
      settingsPath: join(restoredDir, "settings.json"),
      keybindingsConfigPath: join(restoredDir, "keybindings.json"),
      secretsDir: join(restoredDir, "secrets"),
    };
    const service = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, restored)),
    );
    await Effect.runPromise(
      service.stageRestore({ source: createReadStream(join(firstStaging, "backup.f5backup")) }),
    );
    await applyPendingRestore(restored);
    const registry = new DatabaseSync(restored.dbPath, { readOnly: true });
    try {
      expect(
        registry.prepare("SELECT final_path FROM attachments WHERE attachment_id='owned'").get(),
      ).toEqual({ final_path: join(restored.attachmentsDir, "owned.txt") });
      expect(registry.prepare("SELECT * FROM attachment_owners").all()).toEqual([
        { attachment_id: "owned" },
      ]);
      const cleanup = registry
        .prepare("SELECT path FROM attachment_cleanup_jobs WHERE attachment_id='unowned'")
        .get() as { path: string };
      expect(cleanup.path).toContain(join(restored.attachmentsDir, "__restore_unowned__"));
      expect(cleanup.path).not.toBe(join(restored.attachmentsDir, "owned.txt"));
    } finally {
      registry.close();
    }
    const secondStaging = join(directory, "second-export");
    await mkdir(secondStaging);
    const exported = await runBackupMaintenance({
      config: restored,
      stagingDir: secondStaging,
      includeSecrets: false,
    });
    expect(exported.files.find((file) => file.path === "attachments/owned.txt")?.sha256).toBe(
      original.files.find((file) => file.path === "attachments/owned.txt")?.sha256,
    );
  });

  it("fails export when owned evidence is missing and propagates helper startup errors", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    await rm(join(config.attachmentsDir, "owned.txt"));
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    await expect(
      runBackupMaintenance({ config, stagingDir, includeSecrets: false }),
    ).rejects.toThrow();
    await expect(
      runBackupMaintenance({
        config: { ...config, dbPath: join(directory, "missing.sqlite") },
        stagingDir,
        includeSecrets: false,
      }),
    ).rejects.toThrow();
  });

  it("waits for child termination before a cancelled export releases attachment retention", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const stagingDir = join(directory, "export");
    await mkdir(stagingDir);
    const fiber = Effect.runFork(
      withAttachmentRetentionLease(
        config.attachmentsDir,
        backupMaintenanceEffect({ config, stagingDir, includeSecrets: false }),
      ),
    );
    const { Fiber } = await import("effect");
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(withAttachmentRetentionLease(config.attachmentsDir, Effect.void));
    // Reusing the snapshot destination proves no old child can still install it.
    await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
  });

  it("keeps successful backups when the export exhausts its storage budget", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const backups = join(directory, "backups");
    await mkdir(backups);
    const previous = `daily-${Date.now() - 2 * 86400000}-00000000-0000-0000-0000-000000000000.f5backup`;
    await writeFile(join(backups, previous), "previous success");
    vi.stubEnv("F5_BACKUP_MAX_COMPRESSED_BYTES", "1");
    const backup = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
    );
    await expect(Effect.runPromise(runScheduledBackup(backup, backups))).rejects.toBeDefined();
    expect(await readdir(backups)).toEqual(expect.arrayContaining([previous, "status.json"]));
    expect(await readScheduledBackupStatus(backups)).toMatchObject({
      lastSuccessAt: new Date(Number(previous.split("-")[1])).toISOString(),
      lastError: expect.any(String),
    });
  });

  it("daily retention keeps seven successful exports and ignores unrelated files", async () => {
    const { directory, config, db } = await fixture();
    db.close();
    const backups = join(directory, "backups");
    await mkdir(backups);
    const now = Date.now();
    for (let day = 1; day <= 8; day++)
      await writeFile(
        join(
          backups,
          `daily-${now - day * 86400000}-00000000-0000-0000-0000-000000000000.f5backup`,
        ),
        "previous success",
      );
    await writeFile(join(backups, "manual.f5backup"), "keep");
    const backup = await Effect.runPromise(
      makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
    );
    await Effect.runPromise(runScheduledBackup(backup, backups, now));
    expect(await listScheduledBackups(backups)).toHaveLength(7);
    const names = await readdir(backups);
    expect(names).toContain("manual.f5backup");
    expect(names.some((name) => name.endsWith(".partial"))).toBe(false);
    const before = [...names];
    await Effect.runPromise(runScheduledBackup(backup, backups, now + 1000));
    expect(await readdir(backups)).toEqual(before);
  });
});

it("preserves pre-registry attachment files referenced by an upgraded snapshot", async () => {
  const { directory, config, db } = await fixture();
  await writeFile(join(config.attachmentsDir, "legacy.txt"), "legacy evidence");
  db.exec("CREATE TABLE projection_thread_messages(attachments_json TEXT)");
  db.prepare("INSERT INTO projection_thread_messages VALUES (?)").run(
    JSON.stringify([{ id: "legacy", name: "legacy.txt" }]),
  );
  db.close();
  const stagingDir = join(directory, "legacy-export");
  await mkdir(stagingDir);
  const manifest = await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
  expect(manifest.files.map((entry) => entry.path)).toContain("attachments/legacy.txt");
  const parsed = await parseBackupArchive({
    source: createReadStream(join(stagingDir, "backup.f5backup")),
    stagingDir: join(directory, "legacy-read"),
    limits: resolveBackupRestoreLimits(),
  });
  expect(await readFile(join(parsed.payloadDir, "attachments/legacy.txt"), "utf8")).toBe(
    "legacy evidence",
  );
});

it("repairs stale cross-directory registry paths only in the exported snapshot", async () => {
  const { directory, config, db } = await fixture();
  const foreign = join(directory, "old-profile", "attachments", "owned.txt");
  db.prepare("UPDATE attachments SET final_path=? WHERE attachment_id='owned'").run(foreign);
  const stagingDir = join(directory, "rebound-export");
  await mkdir(stagingDir);
  try {
    await runBackupMaintenance({ config, stagingDir, includeSecrets: false });
    const snapshot = new DatabaseSync(join(stagingDir, "database.sqlite"), { readOnly: true });
    try {
      expect(
        snapshot.prepare("SELECT final_path FROM attachments WHERE attachment_id='owned'").get(),
      ).toEqual({ final_path: join(config.attachmentsDir, "owned.txt") });
    } finally {
      snapshot.close();
    }
    expect(
      db.prepare("SELECT final_path FROM attachments WHERE attachment_id='owned'").get(),
    ).toEqual({ final_path: foreign });
  } finally {
    db.close();
  }
});

it.each([false, true])(
  "redacts settings credentials or encrypts the settings entry (includeSecrets=%s)",
  async (includeSecrets) => {
    const { directory, config, db } = await fixture();
    db.close();
    const credentials = {
      providers: { opencode: { serverPassword: "global-private-password" } },
      providerInstances: {
        instance: {
          driver: "opencode",
          config: { serverPassword: "instance-private-password" },
          environment: [
            { name: "API_KEY", value: "environment-private-key", sensitive: true },
            { name: "REGION", value: "eu" },
          ],
        },
      },
    };
    await writeFile(config.settingsPath!, JSON.stringify(credentials));
    const stagingDir = join(directory, "credential-export");
    await mkdir(stagingDir);
    const password = "a-strong-backup-password";
    const manifest = await runBackupMaintenance({
      config,
      stagingDir,
      includeSecrets,
      ...(includeSecrets ? { password } : {}),
    });
    expect(manifest.files.find((entry) => entry.path === "settings.json")?.encrypted).toBe(
      includeSecrets,
    );
    const parsed = await parseBackupArchive({
      source: createReadStream(join(stagingDir, "backup.f5backup")),
      stagingDir: join(directory, "credentials-read"),
      limits: resolveBackupRestoreLimits(),
      ...(includeSecrets ? { password } : {}),
    });
    const text = await readFile(join(parsed.payloadDir, "settings.json"), "utf8");
    for (const secret of [
      "global-private-password",
      "instance-private-password",
      "environment-private-key",
    ])
      expect(text.includes(secret)).toBe(includeSecrets);
    expect(text).toContain('"eu"');
  },
);

it("persists an actionable scheduled failure and keeps the last successful backup", async () => {
  const { directory, config, db } = await fixture();
  db.close();
  const backups = join(directory, "daily-failure");
  const service = await Effect.runPromise(
    makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
  );
  const now = Date.now();
  await Effect.runPromise(runScheduledBackup(service, backups, now));
  await rm(join(config.attachmentsDir, "owned.txt"));
  await expect(
    Effect.runPromise(runScheduledBackup(service, backups, now + 86400001)),
  ).rejects.toThrow("owned");
  expect(await listScheduledBackups(backups)).toHaveLength(1);
  expect(await readScheduledBackupStatus(backups)).toMatchObject({
    lastSuccessAt: new Date(now).toISOString(),
    lastAttemptAt: new Date(now + 86400001).toISOString(),
    lastError: expect.stringContaining("owned"),
  });
});

it("sweeps interrupted partials, restores directory permissions, and handles clock rollback", async () => {
  const { directory, config, db } = await fixture();
  db.close();
  const backups = join(directory, "daily-recovery");
  await mkdir(backups);
  await chmod(backups, 0o755);
  const now = Date.now(),
    future = now + 86400000;
  const suffix = "00000000-0000-0000-0000-000000000000";
  for (let i = 0; i < 8; i++)
    await writeFile(join(backups, `daily-${future + i}-${suffix}.f5backup`), "future backup");
  const partial = `daily-${now}-${suffix}.f5backup.partial`;
  await writeFile(join(backups, partial), "interrupted export");
  await writeFile(join(backups, "manual.partial"), "keep");
  const service = await Effect.runPromise(
    makeBackupService.pipe(Effect.provideService(ServerConfig, config)),
  );
  await Effect.runPromise(runScheduledBackup(service, backups, now));
  const names = await readdir(backups);
  expect(names).not.toContain(partial);
  expect(names).toContain("manual.partial");
  expect((await listScheduledBackups(backups)).some((entry) => entry.createdAt === now)).toBe(true);
  expect(await listScheduledBackups(backups)).toHaveLength(7);
  if (process.platform !== "win32") expect((await stat(backups)).mode & 0o777).toBe(0o700);
  await Effect.runPromise(runScheduledBackup(service, backups, now + 1000));
  expect(await readdir(backups)).toEqual(names);
});
