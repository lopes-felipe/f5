import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { version as appVersion } from "../package.json" with { type: "json" };
import { ServerConfig, type ServerConfigShape } from "./config.ts";
import {
  backupTemporaryStorageBudget,
  parseBackupArchive,
  resolveBackupRestoreLimits,
  writeBackupArchive,
  type BackupArchiveEntry,
  type BackupManifest,
  type BackupRestoreLimits,
} from "./backupArchive.ts";
import { LATEST_MIGRATION_ID } from "./persistence/Migrations.ts";

const PENDING_RESTORE_FILE = "restore-pending.json";
const RESTORE_STAGING_DIRECTORY = "restore-staging";
const RESTORE_ROLLBACK_DIRECTORY = "restore-rollbacks";

interface PendingRestore {
  readonly version: 1;
  readonly restoreId: string;
  readonly stagedAt: string;
  readonly sourceCreatedAt: string;
  readonly stagingDir: string;
  readonly replaceSecrets: boolean;
}

export interface BackupRestoreStageResult {
  readonly restoreId: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly includesEncryptedSecrets: boolean;
  readonly restartRequired: true;
}

export interface PendingRestoreApplyResult {
  readonly status: "none" | "applied";
  readonly restoreId?: string;
  readonly rollbackDir?: string;
}

export class BackupServiceError extends Schema.TaggedErrorClass<BackupServiceError>()(
  "BackupServiceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(
      normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`,
    )
  );
}

async function listRegularFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return result;
}

function archivePathForFile(prefix: string, root: string, file: string): string {
  const relativePath = relative(root, file).split(sep).join("/");
  return `${prefix}/${relativePath}`;
}

function validateJsonFile(path: string, label: string): Promise<void> {
  return readFile(path, "utf8").then((content) => {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
  });
}

export function validateBackupDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("Backup database integrity check failed.");
    }
    const migrationTable = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get() as { present?: number } | undefined;
    if (!migrationTable?.present) throw new Error("Backup database migration metadata is missing.");
    const latest = database
      .prepare("SELECT max(migration_id) AS version FROM effect_sql_migrations")
      .get() as { version?: number | null };
    if ((latest.version ?? 0) > LATEST_MIGRATION_ID) {
      throw new Error(
        `Backup schema version ${latest.version} is newer than supported version ${LATEST_MIGRATION_ID}.`,
      );
    }
  } finally {
    database.close();
  }
}

async function validateRestoredPayload(payloadDir: string): Promise<void> {
  const databasePath = resolve(payloadDir, "database.sqlite");
  validateBackupDatabase(databasePath);
  const settingsPath = resolve(payloadDir, "settings.json");
  if (await exists(settingsPath)) await validateJsonFile(settingsPath, "Backup settings");
  const keybindingsPath = resolve(payloadDir, "keybindings.json");
  if (await exists(keybindingsPath)) {
    await validateJsonFile(keybindingsPath, "Backup keybindings");
  }
  await mkdir(resolve(payloadDir, "attachments"), { recursive: true });
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

export interface BackupService {
  readonly restoreLimits: BackupRestoreLimits;
  readonly exportArchive: (input: {
    readonly output: Writable;
    readonly includeSecrets: boolean;
    readonly password?: string;
    readonly onReady?: (details: {
      readonly contentLength: number;
      readonly manifest: BackupManifest;
    }) => void;
  }) => Effect.Effect<BackupManifest, BackupServiceError>;
  readonly stageRestore: (input: {
    readonly source: Readable;
    readonly password?: string;
    readonly contentLength?: number;
  }) => Effect.Effect<BackupRestoreStageResult, BackupServiceError>;
}

export const makeBackupService: Effect.Effect<
  BackupService,
  never,
  SqlClient.SqlClient | ServerConfig
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const restoreLimits = resolveBackupRestoreLimits();

  return {
    restoreLimits,
    exportArchive: ({ output, includeSecrets, password, onReady }) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            if (includeSecrets && (!password || password.length < 12)) {
              throw new Error(
                "Encrypted secret export requires a password of at least 12 characters.",
              );
            }
            const stagingDir = resolve(config.stateDir, "backup-staging", randomUUID());
            await mkdir(stagingDir, { recursive: true });
            return stagingDir;
          },
          catch: (cause) => new BackupServiceError({ message: String(cause), cause }),
        }),
        (stagingDir) =>
          Effect.gen(function* () {
            const databaseSnapshot = resolve(stagingDir, "database.sqlite");
            const escapedSnapshotPath = databaseSnapshot.replaceAll("'", "''");
            yield* sql.unsafe(`VACUUM INTO '${escapedSnapshotPath}'`).pipe(
              Effect.mapError(
                (cause) =>
                  new BackupServiceError({
                    message: "Failed to create a consistent database snapshot.",
                    cause,
                  }),
              ),
            );
            const manifest = yield* Effect.tryPromise({
              try: async () => {
                const archivePath = resolve(stagingDir, "backup.f5backup");
                const snapshotBytes = (await stat(databaseSnapshot)).size;
                const availableTemporaryBytes = await backupTemporaryStorageBudget(
                  stagingDir,
                  restoreLimits,
                );
                const maxArchiveBytes = Math.min(
                  restoreLimits.maxCompressedBytes,
                  availableTemporaryBytes,
                  Math.max(0, restoreLimits.maxTemporaryBytes - snapshotBytes),
                );
                if (maxArchiveBytes <= 0) {
                  throw new Error("Not enough free disk space to create a backup safely.");
                }
                const entries: BackupArchiveEntry[] = [
                  { archivePath: "database.sqlite", sourcePath: databaseSnapshot, encrypt: false },
                ];
                if (config.settingsPath && (await exists(config.settingsPath))) {
                  entries.push({
                    archivePath: "settings.json",
                    sourcePath: config.settingsPath,
                    encrypt: false,
                  });
                }
                if (await exists(config.keybindingsConfigPath)) {
                  entries.push({
                    archivePath: "keybindings.json",
                    sourcePath: config.keybindingsConfigPath,
                    encrypt: false,
                  });
                }
                for (const file of await listRegularFiles(config.attachmentsDir)) {
                  entries.push({
                    archivePath: archivePathForFile("attachments", config.attachmentsDir, file),
                    sourcePath: file,
                    encrypt: false,
                  });
                }
                if (includeSecrets && config.secretsDir) {
                  for (const file of await listRegularFiles(config.secretsDir)) {
                    entries.push({
                      archivePath: archivePathForFile("secrets", config.secretsDir, file),
                      sourcePath: file,
                      encrypt: true,
                    });
                  }
                }
                const writtenManifest = await writeBackupArchive({
                  output: createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
                  entries,
                  appVersion,
                  maxArchiveBytes,
                  ...(password ? { password } : {}),
                });
                const archiveInfo = await stat(archivePath);
                onReady?.({ contentLength: archiveInfo.size, manifest: writtenManifest });
                await pipeline(createReadStream(archivePath), output);
                return writtenManifest;
              },
              catch: (cause) =>
                new BackupServiceError({
                  message: `Backup export failed: ${String(cause)}`,
                  cause,
                }),
            });
            return manifest;
          }),
        (stagingDir) =>
          Effect.promise(() => rm(stagingDir, { recursive: true, force: true })).pipe(Effect.orDie),
      ),
    stageRestore: ({ source, password, contentLength }) =>
      Effect.tryPromise({
        try: async () => {
          if (
            contentLength !== undefined &&
            (!Number.isSafeInteger(contentLength) || contentLength < 0)
          ) {
            throw new Error("Backup upload has an invalid Content-Length header.");
          }
          if (contentLength !== undefined && contentLength > restoreLimits.maxCompressedBytes) {
            throw new Error("Backup upload exceeds the compressed restore size limit.");
          }
          const pendingPath = resolve(config.stateDir, PENDING_RESTORE_FILE);
          if (await exists(pendingPath)) {
            throw new Error("A restore is already staged. Restart F5 before staging another one.");
          }
          const restoreId = randomUUID();
          const stagingDir = resolve(config.stateDir, RESTORE_STAGING_DIRECTORY, restoreId);
          await mkdir(stagingDir, { recursive: true });
          try {
            const parsed = await parseBackupArchive({
              source,
              stagingDir,
              limits: restoreLimits,
              ...(password ? { password } : {}),
            });
            await validateRestoredPayload(parsed.payloadDir);
            const replaceSecrets = parsed.manifest.files.some((file) =>
              file.path.startsWith("secrets/"),
            );
            const pending: PendingRestore = {
              version: 1,
              restoreId,
              stagedAt: new Date().toISOString(),
              sourceCreatedAt: parsed.manifest.createdAt,
              stagingDir,
              replaceSecrets,
            };
            await atomicWriteJson(pendingPath, pending);
            return {
              restoreId,
              createdAt: parsed.manifest.createdAt,
              fileCount: parsed.manifest.files.length,
              includesEncryptedSecrets: replaceSecrets,
              restartRequired: true,
            };
          } catch (error) {
            await rm(stagingDir, { recursive: true, force: true });
            throw error;
          }
        },
        catch: (cause) =>
          new BackupServiceError({ message: `Backup restore failed: ${String(cause)}`, cause }),
      }),
  };
});

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return true;
}

async function parsePendingRestore(path: string): Promise<PendingRestore> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PendingRestore>;
  if (
    parsed.version !== 1 ||
    typeof parsed.restoreId !== "string" ||
    typeof parsed.stagingDir !== "string" ||
    typeof parsed.sourceCreatedAt !== "string" ||
    typeof parsed.stagedAt !== "string" ||
    typeof parsed.replaceSecrets !== "boolean"
  ) {
    throw new Error("Pending restore metadata is invalid.");
  }
  return parsed as PendingRestore;
}

export async function applyPendingRestore(
  config: Pick<
    ServerConfigShape,
    | "stateDir"
    | "dbPath"
    | "settingsPath"
    | "keybindingsConfigPath"
    | "attachmentsDir"
    | "secretsDir"
  >,
): Promise<PendingRestoreApplyResult> {
  const pendingPath = resolve(config.stateDir, PENDING_RESTORE_FILE);
  if (!(await exists(pendingPath))) return { status: "none" };
  const pending = await parsePendingRestore(pendingPath);
  const stagingRoot = resolve(config.stateDir, RESTORE_STAGING_DIRECTORY);
  if (!isInside(stagingRoot, pending.stagingDir)) {
    throw new Error("Pending restore points outside the restore staging directory.");
  }
  const payloadDir = resolve(pending.stagingDir, "payload");
  await validateRestoredPayload(payloadDir);

  const rollbackDir = resolve(
    config.stateDir,
    RESTORE_ROLLBACK_DIRECTORY,
    `${new Date().toISOString().replaceAll(":", "-")}-${pending.restoreId}`,
  );
  await mkdir(rollbackDir, { recursive: true });

  const activeItems = [
    {
      name: "database.sqlite",
      active: config.dbPath,
      staged: resolve(payloadDir, "database.sqlite"),
    },
    ...(config.settingsPath
      ? [
          {
            name: "settings.json",
            active: config.settingsPath,
            staged: resolve(payloadDir, "settings.json"),
          },
        ]
      : []),
    {
      name: "keybindings.json",
      active: config.keybindingsConfigPath,
      staged: resolve(payloadDir, "keybindings.json"),
    },
    {
      name: "attachments",
      active: config.attachmentsDir,
      staged: resolve(payloadDir, "attachments"),
    },
    ...(pending.replaceSecrets && config.secretsDir
      ? [{ name: "secrets", active: config.secretsDir, staged: resolve(payloadDir, "secrets") }]
      : []),
  ];
  const movedActive: typeof activeItems = [];
  const movedStaged: typeof activeItems = [];
  const databaseSidecars = (["-wal", "-shm", "-journal"] as const).map((suffix) => ({
    active: `${config.dbPath}${suffix}`,
    rollback: resolve(rollbackDir, `database.sqlite${suffix}`),
  }));
  const movedActiveSidecars: typeof databaseSidecars = [];
  try {
    for (const sidecar of databaseSidecars) {
      if (await moveIfPresent(sidecar.active, sidecar.rollback)) {
        movedActiveSidecars.push(sidecar);
      }
    }
    for (const item of activeItems) {
      if (await moveIfPresent(item.active, resolve(rollbackDir, item.name))) movedActive.push(item);
    }
    for (const item of activeItems) {
      if (await moveIfPresent(item.staged, item.active)) movedStaged.push(item);
    }
    await rm(pendingPath, { force: true });
    await rm(pending.stagingDir, { recursive: true, force: true });
    return { status: "applied", restoreId: pending.restoreId, rollbackDir };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    const attemptRollback = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    };
    for (const item of [...movedStaged].reverse()) {
      await attemptRollback(() => rm(item.active, { recursive: true, force: true }));
    }
    for (const item of [...movedActive].reverse()) {
      await attemptRollback(() => moveIfPresent(resolve(rollbackDir, item.name), item.active));
    }
    for (const sidecar of [...movedActiveSidecars].reverse()) {
      await attemptRollback(() => moveIfPresent(sidecar.rollback, sidecar.active));
    }
    throw new Error(
      rollbackErrors.length > 0
        ? "Failed to apply staged restore; rollback was incomplete and its recovery copy was retained."
        : "Failed to apply staged restore; active state was rolled back.",
      {
        cause:
          rollbackErrors.length > 0
            ? new AggregateError([error, ...rollbackErrors], "Restore rollback was incomplete.")
            : error,
      },
    );
  }
}
