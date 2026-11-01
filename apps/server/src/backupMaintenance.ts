import { watchMaintenanceOwner } from "./maintenanceOwner.ts";
import { Data, Effect } from "effect";
import { MAX_MANIFEST_BYTES } from "./backupArchive.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfigShape } from "./config.ts";
import type { BackupManifest } from "./backupArchive.ts";

export class BackupMaintenanceError extends Data.TaggedError("BackupMaintenanceError")<{
  message: string;
  cause: unknown;
}> {}

export const BACKUP_MAINTENANCE_MODE = "--internal-backup-export";
export type BackupExportConfig = Pick<
  ServerConfigShape,
  | "dbPath"
  | "stateDir"
  | "attachmentsDir"
  | "settingsPath"
  | "keybindingsConfigPath"
  | "secretsDir"
  | "profile"
  | "profilesRoot"
>;
interface BackupMaintenanceInput {
  readonly config: BackupExportConfig;
  readonly stagingDir: string;
  readonly includeSecrets: boolean;
  readonly password?: string;
}

/** Passwords travel only over the private pipe, never argv or the environment. */
export function runBackupMaintenance(
  input: BackupMaintenanceInput,
  signal?: AbortSignal,
): Promise<BackupManifest> {
  const source = import.meta.url.endsWith(".ts");
  const entry = source
    ? fileURLToPath(new URL("./backupMaintenanceEntry.ts", import.meta.url))
    : fileURLToPath(
        new URL(
          `./maintenance/backup-maintenance.${import.meta.url.endsWith(".cjs") ? "cjs" : "mjs"}`,
          import.meta.url,
        ),
      );
  const standalone = process.env.F5_STANDALONE === "1";
  const args = standalone ? [BACKUP_MAINTENANCE_MODE] : [entry, BACKUP_MAINTENANCE_MODE];
  return new Promise((resolve, reject) => {
    const child = spawn(
      source && process.versions.bun === undefined ? "bun" : process.execPath,
      args,
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let result = "";
    let resultBytes = 0;
    let failure: Error | undefined;
    // Stderr may contain runtime warnings. Bound all retained IPC data.
    child.stderr.on("data", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      result += chunk;
      resultBytes += Buffer.byteLength(chunk);
      if (resultBytes > MAX_MANIFEST_BYTES + 1024) {
        failure = new Error("Backup maintenance response exceeded its size limit.");
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    const abort = () => {
      failure = new Error("Backup export was cancelled.");
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code, exitSignal) => {
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try {
        const response = JSON.parse(result) as { manifest?: BackupManifest; error?: string };
        if (code !== 0 || !response.manifest)
          throw new Error(
            response.error ??
              `Backup maintenance process failed (exit ${code}, signal ${exitSignal ?? "none"}).`,
          );
        resolve(response.manifest);
      } catch (error) {
        reject(error);
      }
    });
    if (signal?.aborted) abort();
    else {
      const {
        dbPath,
        stateDir,
        attachmentsDir,
        settingsPath,
        keybindingsConfigPath,
        secretsDir,
        profile,
        profilesRoot,
      } = input.config;
      child.stdin.end(
        JSON.stringify({
          ...input,
          config: {
            dbPath,
            stateDir,
            attachmentsDir,
            settingsPath,
            keybindingsConfigPath,
            secretsDir,
            profile,
            profilesRoot,
          },
        }),
      );
    }
  });
}

export async function runBackupMaintenanceMode(): Promise<void> {
  // A separate lifetime pipe stays open after the request has been read.
  // Parent death closes it, terminating work before a new backend can clean files.
  const stopWatchingOwner = await watchMaintenanceOwner();
  const input: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) throw new Error("Backup request exceeded its size limit.");
      input.push(Buffer.from(chunk));
    }
    const request = JSON.parse(Buffer.concat(input).toString("utf8")) as
      | BackupMaintenanceInput
      | { kind: "compact-database"; dbPath: string }
      | { kind: "storage"; task: import("./storage/storageWorker.ts").StorageWorkerTask };
    if ("kind" in request && request.kind === "storage") {
      const { executeStorageTask } = await import("./storage/storageWorker.ts");
      const storage = await executeStorageTask(request.task);
      // A timed-out read-only traversal may still have an OS syscall outstanding.
      // Exit the owned helper after flushing its partial response.
      if (request.task.kind !== "remove")
        process.stdout.write(JSON.stringify({ storage }), () => process.exit(0));
      else process.stdout.write(JSON.stringify({ storage }));
      return;
    }
    if ("kind" in request && request.kind === "compact-database") {
      const { compactDatabaseFile } = await import("./storage/databaseMaintenance.ts");
      await compactDatabaseFile(request.dbPath);
      process.stdout.write(JSON.stringify({ compacted: true }));
      return;
    }
    const { buildBackupArchive } = await import("./backupExport.ts");
    const manifest = await buildBackupArchive(request as BackupMaintenanceInput);
    process.stdout.write(JSON.stringify({ manifest }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ error: error instanceof Error ? error.message : "Backup export failed." }),
    );
    process.exitCode = 1;
  } finally {
    await stopWatchingOwner();
  }
}

/** Interruption waits for confirmed child exit before releasing retention/staging. */
export function backupMaintenanceEffect(
  input: BackupMaintenanceInput,
): Effect.Effect<BackupManifest, BackupMaintenanceError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      return { controller, result: runBackupMaintenance(input, controller.signal) };
    }),
    ({ result }) =>
      Effect.tryPromise({
        try: () => result,
        catch: (cause) => new BackupMaintenanceError({ message: String(cause), cause }),
      }),
    ({ controller, result }) =>
      Effect.promise(async () => {
        controller.abort();
        await result.catch(() => {});
      }),
  );
}
