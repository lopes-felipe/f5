import { userFacingCauseMessage } from "../causeMessage.ts";
import { ScheduledBackupStatus } from "@t3tools/contracts";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit, Schedule, Schema, Semaphore } from "effect";
import type { BackupService } from "../backupService.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const schedulerGate = Semaphore.makeUnsafe(1);
const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCESSFUL_BACKUP = /^daily-(\d{13})-([a-f0-9-]{36})\.f5backup$/;

export async function listScheduledBackups(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile() && SUCCESSFUL_BACKUP.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      createdAt: Number(SUCCESSFUL_BACKUP.exec(entry.name)![1]),
    }))
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

export async function readScheduledBackupStatus(directory: string): Promise<ScheduledBackupStatus> {
  const previous = await listScheduledBackups(directory);
  try {
    return Schema.decodeUnknownSync(ScheduledBackupStatus)(
      JSON.parse(await readFile(resolve(directory, "status.json"), "utf8")),
    );
  } catch (error) {
    return {
      lastAttemptAt: null,
      lastSuccessAt: previous[0] ? new Date(previous[0].createdAt).toISOString() : null,
      lastError:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? null
          : "Could not read the last scheduled backup result.",
    };
  }
}

async function writeStatus(directory: string, status: ScheduledBackupStatus) {
  const temporary = resolve(directory, `status-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(status), { flag: "wx", mode: 0o600 });
    await rename(temporary, resolve(directory, "status.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A failed or interrupted export never publishes a success or prunes older backups. */
export function runScheduledBackup(backup: BackupService, directory: string, now = Date.now()) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      // Only this profile backend schedules exports, and the gate prevents a
      // second invocation from removing an active producer's temporary file.
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (entry.isFile() && /^daily-\d{13}-[a-f0-9-]{36}\.f5backup\.partial$/.test(entry.name))
          await rm(resolve(directory, entry.name));
    });
    const previous = yield* Effect.tryPromise(() => listScheduledBackups(directory));
    const latestPast = previous.find((backup) => backup.createdAt <= now);
    if (latestPast && now - latestPast.createdAt < DAY_MS) return;
    const previousStatus = yield* Effect.tryPromise(() => readScheduledBackupStatus(directory));
    const name = `daily-${now}-${randomUUID()}.f5backup`;
    const temporary = resolve(directory, `${name}.partial`);
    let published = false;
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
        // Opening the destination can fail while the helper is still preparing
        // the archive. pipeline() later observes the stream's recorded error.
        output.on("error", () => {});
        return output;
      }),
      (output) =>
        Effect.gen(function* () {
          // Scheduled exports never persist a password or copy credentials.
          yield* backup.exportArchive({ output, includeSecrets: false });
          yield* Effect.tryPromise(() => rename(temporary, resolve(directory, name)));
          published = true;
          const completed = yield* Effect.tryPromise(() => listScheduledBackups(directory));
          const retention = [
            completed.find((entry) => entry.name === name)!,
            ...completed.filter((entry) => entry.name !== name),
          ];
          for (const stale of retention.slice(7)) {
            yield* Effect.tryPromise(() => rm(resolve(directory, stale.name)));
          }
        }),
      (output) =>
        Effect.promise(async () => {
          output.destroy();
          await finished(output).catch(() => {});
          await rm(temporary, { force: true });
        }),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.tryPromise(() =>
          writeStatus(directory, {
            lastAttemptAt: new Date(now).toISOString(),
            lastSuccessAt: published ? new Date(now).toISOString() : previousStatus.lastSuccessAt,
            lastError: Exit.isFailure(exit)
              ? userFacingCauseMessage(exit.cause, "Backup failed.", { maxLength: 300 })
              : null,
          }),
        ).pipe(
          Effect.tap(() =>
            Exit.isFailure(exit)
              ? Effect.logWarning("Scheduled backup failed", { cause: Cause.pretty(exit.cause) })
              : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("could not persist scheduled backup result", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    );
  }).pipe(schedulerGate.withPermit);
}

export const startScheduledBackups = (backup: BackupService) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const tick = Effect.gen(function* () {
      if (!(yield* settings.getSettings).scheduledBackupsEnabled) return;
      yield* runScheduledBackup(backup, resolve(config.stateDir, "backups"));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("scheduled backup failed", { cause: String(cause) }),
      ),
    );
    yield* tick.pipe(
      Effect.repeat(Schedule.spaced("1 hour")),
      Effect.delay("1 minute"),
      Effect.forkScoped,
    );
  });
