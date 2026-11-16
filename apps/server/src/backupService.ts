import { redactBackupSettings } from "./backupSettings.ts";
import { resolveBackupAttachmentPath } from "./backupAttachmentPaths.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { Effect, Schema } from "effect";
import { backupMaintenanceEffect } from "./backupMaintenance.ts";
import { withAttachmentRetentionLease } from "./storage/attachmentRetention.ts";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { validateBackupDatabase } from "./backupDatabase.ts";
export { validateBackupDatabase } from "./backupDatabase.ts";
import { exists, isInside, listRegularFiles } from "./backupFiles.ts";
import { openRuntimeSqliteDatabase } from "./persistence/runtimeSqlite.ts";
import {
  parseBackupArchive,
  resolveBackupRestoreLimits,
  type BackupManifest,
  type BackupRestoreLimits,
} from "./backupArchive.ts";

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
  readonly source?: BackupManifest["source"];
}

export interface BackupRestoreStageResult {
  readonly restoreId: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly includesEncryptedSecrets: boolean;
  readonly restartRequired: true;
  readonly sourceProfileId?: string;
  readonly crossProfile?: boolean;
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

function validateJsonFile(path: string, label: string): Promise<void> {
  return readFile(path, "utf8").then((content) => {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
  });
}

async function validateRestoredPayload(payloadDir: string): Promise<void> {
  const databasePath = resolve(payloadDir, "database.sqlite");
  await validateBackupDatabase(databasePath);
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

export const makeBackupService: Effect.Effect<BackupService, never, ServerConfig> = Effect.gen(
  function* () {
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
              await mkdir(stagingDir, { recursive: true, mode: 0o700 });
              return stagingDir;
            },
            catch: (cause) => new BackupServiceError({ message: String(cause), cause }),
          }),
          (stagingDir) =>
            Effect.gen(function* () {
              const manifest = yield* withAttachmentRetentionLease(
                config.attachmentsDir,
                backupMaintenanceEffect({
                  config,
                  stagingDir,
                  includeSecrets,
                  ...(password ? { password } : {}),
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new BackupServiceError({
                        message: `Backup export failed: ${String(cause)}`,
                        cause,
                      }),
                  ),
                ),
              );
              yield* Effect.tryPromise({
                try: async () => {
                  const archivePath = resolve(stagingDir, "backup.f5backup");
                  onReady?.({ contentLength: (await stat(archivePath)).size, manifest });
                  await pipeline(createReadStream(archivePath), output);
                },
                catch: (cause) =>
                  new BackupServiceError({
                    message: `Backup download failed: ${String(cause)}`,
                    cause,
                  }),
              });
              return manifest;
            }),
          (stagingDir) =>
            Effect.promise(() => rm(stagingDir, { recursive: true, force: true })).pipe(
              Effect.orDie,
            ),
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
              throw new Error(
                "A restore is already staged. Restart F5 before staging another one.",
              );
            }
            const restoreId = randomUUID();
            const stagingDir = resolve(config.stateDir, RESTORE_STAGING_DIRECTORY, restoreId);
            await mkdir(stagingDir, { recursive: true, mode: 0o700 });
            try {
              const parsed = await parseBackupArchive({
                source,
                stagingDir,
                limits: restoreLimits,
                ...(password ? { password } : {}),
              });
              if (!parsed.manifest.source && config.profile?.isDefault === false)
                throw new Error(
                  "Legacy backups without profile identity can only be restored into Default.",
                );
              await validateRestoredPayload(parsed.payloadDir);
              await rebindRestoredAttachmentPaths(parsed.payloadDir, config.attachmentsDir);
              const crossProfile =
                parsed.manifest.source !== undefined &&
                parsed.manifest.source.profileId !== config.profile?.id;
              const replaceSecrets =
                !crossProfile &&
                parsed.manifest.files.some((file) => file.path.startsWith("secrets/"));
              const pending: PendingRestore = {
                version: 1,
                restoreId,
                stagedAt: new Date().toISOString(),
                sourceCreatedAt: parsed.manifest.createdAt,
                stagingDir,
                replaceSecrets,
                ...(parsed.manifest.source ? { source: parsed.manifest.source } : {}),
              };
              await atomicWriteJson(pendingPath, pending);
              return {
                restoreId,
                createdAt: parsed.manifest.createdAt,
                fileCount: parsed.manifest.files.length,
                includesEncryptedSecrets:
                  !crossProfile && parsed.manifest.files.some((file) => file.encrypted),
                restartRequired: true,
                ...(parsed.manifest.source
                  ? {
                      sourceProfileId: parsed.manifest.source.profileId,
                      crossProfile: parsed.manifest.source.profileId !== config.profile?.id,
                    }
                  : {}),
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
  },
);

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
    | "profile"
    | "profilesRoot"
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
  await rebindRestoredAttachmentPaths(payloadDir, config.attachmentsDir);
  if (!pending.source && config.profile?.isDefault === false)
    throw new Error("Legacy backups can only be restored into Default.");
  await rebindRestoredProviderHomes(
    payloadDir,
    config.stateDir,
    config.profilesRoot,
    pending.source?.providerHomesDir,
    pending.source !== undefined && pending.source.profileId !== config.profile?.id,
  );

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
    ...(pending.replaceSecrets &&
    (!pending.source || pending.source.profileId === config.profile?.id) &&
    config.secretsDir
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

/** Rebind only managed homes. Provider credential directories are never archived. */
export async function rebindRestoredProviderHomes(
  payloadDir: string,
  stateDir: string,
  profilesRoot?: string,
  sourceHomesDir?: string,
  crossProfile = false,
): Promise<void> {
  const settingsPath = resolve(payloadDir, "settings.json");
  if (!(await exists(settingsPath))) return;
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const roots = [sourceHomesDir, resolve(stateDir, "provider-homes")].filter(
    (value): value is string => Boolean(value),
  );
  if (profilesRoot) {
    roots.push(resolve(profilesRoot.slice(0, -"-profiles".length), "provider-homes"));
    for (const entry of await readdir(profilesRoot).catch(() => []))
      if (/^[0-9a-f]{32}$/.test(entry)) roots.push(resolve(profilesRoot, entry, "provider-homes"));
  }
  for (const instance of Object.values(settings.providerInstances ?? {}) as {
    config?: Record<string, unknown>;
    environment?: { name: string; value: string; sensitive?: boolean; valueRedacted?: boolean }[];
  }[]) {
    if (crossProfile && instance.environment)
      instance.environment = instance.environment.filter(
        (variable) =>
          !variable.sensitive &&
          !/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN/i.test(variable.name),
      );
    if (!instance.config) continue;
    for (const key of ["homePath", "shadowHomePath"]) {
      const value = instance.config[key];
      if (typeof value !== "string" || !value) continue;
      const root = roots.find((candidate) => isInside(candidate, value));
      if (root) instance.config[key] = resolve(stateDir, "provider-homes", relative(root, value));
    }
  }
  await atomicWriteJson(settingsPath, crossProfile ? redactBackupSettings(settings) : settings);
}

/** The archive owns relative attachment files; registry paths are profile-local. */
export async function rebindRestoredAttachmentPaths(
  payloadDir: string,
  attachmentsDir: string,
): Promise<void> {
  const payloadAttachments = resolve(payloadDir, "attachments");
  const relativePaths = new Set(
    (await listRegularFiles(payloadAttachments)).map((file) =>
      relative(payloadAttachments, file).split("\\").join("/"),
    ),
  );
  const database = await openRuntimeSqliteDatabase(resolve(payloadDir, "database.sqlite"), {
    readOnly: false,
  });
  try {
    if (
      !database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachments'")
        .get()
    )
      return;
    const ownersExist = Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_owners'")
        .get(),
    );
    const rows = database
      .prepare(`SELECT attachment_id, final_path, lifecycle,
      ${ownersExist ? "EXISTS(SELECT 1 FROM attachment_owners WHERE attachment_owners.attachment_id = attachments.attachment_id)" : "0"} AS owned
      FROM attachments`)
      .all() as { attachment_id: string; final_path: string; lifecycle: string; owned: number }[];
    const jobsExist = Boolean(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_cleanup_jobs'",
        )
        .get(),
    );
    const update = database.prepare(
      "UPDATE attachments SET final_path = ? WHERE attachment_id = ? RETURNING attachment_id",
    );
    const updateJob = jobsExist
      ? database.prepare(
          "UPDATE attachment_cleanup_jobs SET path = ? WHERE attachment_id = ? RETURNING attachment_id",
        )
      : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const oldPath = row.final_path.replaceAll("\\", "/");
        const ownsArchivedBytes = row.lifecycle === "ready" && Boolean(row.owned);
        const match = ownsArchivedBytes
          ? resolveBackupAttachmentPath(oldPath, relativePaths)
          : undefined;
        if (match === undefined && ownsArchivedBytes)
          throw new Error(
            `Backup is missing owned attachment '${row.attachment_id}' (${row.final_path}).`,
          );
        // No bytes are exported for unowned/deleting rows. Never let a cleanup
        // job for one adopt another record's archived file through a suffix match.
        const relativePath =
          match ??
          `__restore_unowned__/${createHash("sha256").update(row.attachment_id).digest("hex")}`;
        if (!ownsArchivedBytes && relativePaths.has(relativePath))
          throw new Error("Backup orphan cleanup path collides with archived evidence.");
        const destination = resolve(attachmentsDir, relativePath);
        if (!isInside(attachmentsDir, destination) || destination === resolve(attachmentsDir))
          throw new Error("Backup attachment path is invalid.");
        update.all(destination, row.attachment_id);
        updateJob?.all(destination, row.attachment_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
