import { resolveBackupAttachmentPath } from "./backupAttachmentPaths.ts";
import { redactBackupSettings } from "./backupSettings.ts";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, readFile, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  decryptSecretValue,
  isEncryptedSecretName,
  isEncryptedSecretValue,
  SECRET_STORE_KEY_FILE,
} from "./auth/secretStoreKey.ts";
import { version as appVersion } from "../package.json" with { type: "json" };
import { openRuntimeSqliteDatabase } from "./persistence/runtimeSqlite.ts";
import { clearBackedUpMobileDevices } from "./backupDatabase.ts";
import { MOBILE_APNS_KEY_SECRET, MOBILE_ID_SECRET } from "./mobileAccess/apnsClient.ts";
import { validateBackupDatabase } from "./backupDatabase.ts";
import { exists, isInside, listRegularFiles, archivePathForFile } from "./backupFiles.ts";
import {
  backupTemporaryStorageBudget,
  resolveBackupRestoreLimits,
  writeBackupArchive,
  type BackupArchiveEntry,
  type BackupManifest,
} from "./backupArchive.ts";
import type { BackupExportConfig } from "./backupMaintenance.ts";

/** Runs only in the maintenance child; never uses the application's SQL connection. */
export async function buildBackupArchive(input: {
  config: BackupExportConfig;
  stagingDir: string;
  includeSecrets: boolean;
  password?: string;
  /** The profile's at-rest key (base64), so encrypted secrets export as plain values. */
  secretStoreKey?: string;
}): Promise<BackupManifest> {
  const { config, stagingDir, includeSecrets, password } = input;
  const restoreLimits = resolveBackupRestoreLimits();
  const databaseSnapshot = resolve(stagingDir, "database.sqlite");
  if (!(await lstat(config.dbPath)).isFile())
    throw new Error("Backup source database is not a regular file.");
  // A WAL reader may need to create sidecars when the application connection
  // has just closed. Only snapshot reads run on this dedicated handle.
  const database = await openRuntimeSqliteDatabase(config.dbPath, { readOnly: false });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`VACUUM INTO '${databaseSnapshot.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  await validateBackupDatabase(databaseSnapshot);
  const archivePath = resolve(stagingDir, "backup.f5backup");
  const snapshotBytes = (await stat(databaseSnapshot)).size;
  const availableTemporaryBytes = await backupTemporaryStorageBudget(stagingDir, restoreLimits);
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
    const settingsSnapshot = resolve(stagingDir, "settings.json");
    const settings = JSON.parse(await readFile(config.settingsPath, "utf8"));
    await writeFile(
      settingsSnapshot,
      JSON.stringify(includeSecrets ? settings : redactBackupSettings(settings)),
      { mode: 0o600 },
    );
    entries.push({
      archivePath: "settings.json",
      sourcePath: settingsSnapshot,
      encrypt: includeSecrets,
    });
  }
  if (await exists(config.keybindingsConfigPath)) {
    const keybindingsSnapshot = resolve(stagingDir, "keybindings.json");
    await copyFile(config.keybindingsConfigPath, keybindingsSnapshot);
    entries.push({
      archivePath: "keybindings.json",
      sourcePath: keybindingsSnapshot,
      encrypt: false,
    });
  }
  // Keep unregistered files: profiles upgraded from before the registry still
  // reference them in historical projections/events. Registered unowned files
  // remain excluded. Retention covers both kinds while the snapshot is copied.
  const localFiles = await listRegularFiles(config.attachmentsDir);
  const relativePaths = new Set(
    localFiles.map((file) => relative(config.attachmentsDir, file).split(sep).join("/")),
  );
  const localPaths = new Set(localFiles);
  const snapshot = await openRuntimeSqliteDatabase(databaseSnapshot, { readOnly: false });
  const attachmentFiles = new Set<string>();
  try {
    clearBackedUpMobileDevices(snapshot);
    const hasRegistry = snapshot
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_owners'")
      .get();
    const registered = new Set<string>();
    if (hasRegistry) {
      const rows = snapshot
        .prepare(
          "SELECT attachment_id, final_path, lifecycle, EXISTS(SELECT 1 FROM attachment_owners WHERE attachment_owners.attachment_id = attachments.attachment_id) AS owned FROM attachments",
        )
        .all() as { attachment_id: string; final_path: string; lifecycle: string; owned: number }[];
      const update = snapshot.prepare(
        "UPDATE attachments SET final_path = ? WHERE attachment_id = ? RETURNING attachment_id",
      );
      for (const row of rows) {
        const inside = isInside(config.attachmentsDir, row.final_path);
        const relativePath = inside
          ? undefined
          : resolveBackupAttachmentPath(row.final_path, relativePaths);
        const file = inside
          ? resolve(row.final_path)
          : relativePath
            ? resolve(config.attachmentsDir, relativePath)
            : undefined;
        if (file) registered.add(file);
        if (row.lifecycle !== "ready" || !row.owned) continue;
        if (!file || !localPaths.has(file))
          throw new Error(
            `Owned attachment '${row.attachment_id}' is missing or is not a regular file: ${row.final_path}`,
          );
        attachmentFiles.add(file);
        // Repair only the disposable snapshot, including old cross-directory
        // restores. Do not modify application state while exporting.
        if (file !== row.final_path) update.all(file, row.attachment_id);
      }
    }
    for (const file of localFiles) if (!registered.has(file)) attachmentFiles.add(file);
  } finally {
    snapshot.close();
  }
  for (const file of attachmentFiles)
    entries.push({
      archivePath: archivePathForFile("attachments", config.attachmentsDir, file),
      sourcePath: file,
      encrypt: false,
    });
  if (includeSecrets && config.secretsDir) {
    const plainSecrets = await exportableSecrets(
      config.secretsDir,
      stagingDir,
      input.secretStoreKey,
    );
    for (const file of await listRegularFiles(config.secretsDir)) {
      if (isMobileSecretFile(file)) continue;
      entries.push({
        archivePath: archivePathForFile("secrets", config.secretsDir, file),
        sourcePath: plainSecrets.get(file) ?? file,
        encrypt: true,
      });
    }
  }
  const writtenManifest = await writeBackupArchive({
    output: createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    entries,
    ...(config.profile && config.profilesRoot
      ? {
          source: {
            installationId: (
              await readFile(resolve(config.profilesRoot, "installation-id"), "utf8").catch(
                () => `unverified-${randomUUID()}`,
              )
            ).trim(),
            profileId: config.profile.id,
            providerHomesDir: resolve(config.stateDir, "provider-homes"),
          },
        }
      : {}),
    appVersion,
    maxArchiveBytes,
    ...(password ? { password } : {}),
  });
  return writtenManifest;
}

/**
 * Values encrypted at rest are tied to this profile's key, which never leaves the
 * machine. Export them decrypted (the archive encrypts them with the backup
 * password); restore re-encrypts plain values with the destination's key on first
 * read. Returns staging copies by source path; a value that cannot be decrypted is
 * exported as stored.
 */
export async function exportableSecrets(
  secretsDir: string,
  stagingDir: string,
  configuredKey: string | undefined,
): Promise<Map<string, string>> {
  const keys: Uint8Array[] = [];
  if (configuredKey) keys.push(Buffer.from(configuredKey, "base64"));
  const fileKey = await readFile(resolve(secretsDir, `${SECRET_STORE_KEY_FILE}.bin`)).catch(
    () => undefined,
  );
  if (fileKey?.length === 32) keys.push(fileKey);
  const copies = new Map<string, string>();
  for (const file of await listRegularFiles(secretsDir)) {
    if (isMobileSecretFile(file)) continue;
    const filename = basename(file);
    if (!filename.endsWith(".bin")) continue;
    const name = filename.slice(0, -".bin".length);
    if (!isEncryptedSecretName(name)) continue;
    const bytes = await readFile(file);
    if (!isEncryptedSecretValue(bytes)) continue;
    for (const key of keys) {
      const plain = decryptSecretValue(key, name, bytes);
      if (plain === null) continue;
      const copy = resolve(stagingDir, `secret-${copies.size}.bin`);
      await writeFile(copy, plain, { mode: 0o600 });
      copies.set(file, copy);
      break;
    }
  }
  return copies;
}

function isMobileSecretFile(path: string) {
  const filename = basename(path);
  return filename === MOBILE_APNS_KEY_SECRET + ".bin" || filename === MOBILE_ID_SECRET + ".bin";
}
