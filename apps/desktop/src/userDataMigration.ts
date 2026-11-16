import * as FS from "node:fs";
import { join, basename } from "node:path";
import { uptime } from "node:os";
import { randomUUID } from "node:crypto";

const excluded = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
  "CacheStorage",
  "ScriptCache",
  "blob_storage",
]);
export type UserDataMigrationResult =
  | { kind: "ready"; path: string; migratedFrom: string | null }
  | { kind: "blocked"; title: string; message: string };

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function migrateUserData(options: {
  appDataBase: string;
  targetName: string;
  legacyNames: readonly string[];
  skipImport: boolean;
  platform: NodeJS.Platform;
  hostname: string;
  statfs?: typeof FS.statfsSync;
  copy?: typeof FS.cpSync;
  now?: () => number;
  uptimeSeconds?: () => number;
  lockWaitMs?: number;
}): UserDataMigrationResult {
  const target = join(options.appDataBase, options.targetName);
  const ready = (migratedFrom: string | null): UserDataMigrationResult => ({
    kind: "ready",
    path: target,
    migratedFrom,
  });
  const blocked = (message: string): UserDataMigrationResult => ({
    kind: "blocked",
    title: "F5 could not import your settings",
    message,
  });
  const lock = `${target}.migration.lock`;
  const now = options.now ?? Date.now;
  const bootTimeMs = now() - (options.uptimeSeconds ?? uptime)() * 1000;
  const osMetadata = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
  const targetHasData = () =>
    FS.existsSync(target) &&
    FS.readdirSync(target, { withFileTypes: true }).some(
      (entry) => !osMetadata.has(entry.name) || !entry.isFile(),
    );
  let owned = false;
  let candidate: string | undefined;
  let temp: string | undefined;
  try {
    FS.mkdirSync(options.appDataBase, { recursive: true });
    if (targetHasData()) return ready(null);
    const deadline = now() + (options.lockWaitMs ?? 60_000);
    // Publish a fully written record atomically: a crash before link leaves only
    // an inert candidate, never an empty lock that blocks subsequent launches.
    candidate = `${lock}.candidate-${process.pid}-${randomUUID()}`;
    FS.writeFileSync(
      candidate,
      JSON.stringify({ pid: process.pid, hostname: options.hostname, bootTimeMs }),
      { flag: "wx", mode: 0o600 },
    );
    while (!owned) {
      try {
        FS.linkSync(candidate, lock);
        owned = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = FS.statSync(lock);
          const text = FS.readFileSync(lock, "utf8").trim();
          let pid: number | null = /^\d+$/.test(text) ? Number(text) : null;
          let host: string | undefined;
          let ownerBoot: number | undefined;
          if (pid === null) {
            try {
              const record = JSON.parse(text) as {
                pid?: unknown;
                hostname?: unknown;
                bootTimeMs?: unknown;
              };
              if (
                record &&
                Number.isSafeInteger(record.pid) &&
                Number(record.pid) > 0 &&
                typeof record.hostname === "string" &&
                typeof record.bootTimeMs === "number" &&
                Number.isFinite(record.bootTimeMs)
              ) {
                pid = Number(record.pid);
                host = record.hostname;
                ownerBoot = record.bootTimeMs;
              }
            } catch {
              /* Legacy interrupted lock: allow a short publication grace period. */
            }
          }
          const validPid = pid !== null && Number.isSafeInteger(pid) && pid > 0;
          const localHost = host === undefined || host === options.hostname;
          const fromPreviousBoot =
            stat.mtimeMs < bootTimeMs - 5_000 ||
            (ownerBoot !== undefined && ownerBoot < bootTimeMs - 5_000);
          const stale =
            localHost &&
            (validPid ? fromPreviousBoot || !alive(pid!) : now() - stat.mtimeMs >= 5_000);
          if (stale) {
            // Recheck identity before removing a stale record; contenders may have
            // already published a different, fully initialized owner.
            const current = FS.statSync(lock);
            if (
              current.ino === stat.ino &&
              current.dev === stat.dev &&
              current.mtimeMs === stat.mtimeMs
            )
              FS.unlinkSync(lock);
            continue;
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }
        if (targetHasData()) return ready(null);
        if (now() >= deadline)
          return blocked(
            "Another F5 process is importing settings. Try opening F5 again in a minute.",
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
    if (targetHasData()) return ready(null);
    // Electron may create an empty F5 directory (the same as f5 on macOS and
    // Windows) before setPath. Never use a missing marker to overwrite real data.
    if (FS.existsSync(target)) {
      for (const name of FS.readdirSync(target)) FS.unlinkSync(join(target, name));
      FS.rmdirSync(target);
    }
    for (const name of FS.readdirSync(options.appDataBase)) {
      if (name.startsWith(`${options.targetName}.migrating-`))
        FS.rmSync(join(options.appDataBase, name), { recursive: true, force: true });
    }
    const source = options.legacyNames
      .map((name) => join(options.appDataBase, name))
      .find((path) => FS.existsSync(path) && FS.statSync(path).isDirectory());
    if (!source || options.skipImport) {
      FS.mkdirSync(target);
      if (options.skipImport) FS.writeFileSync(join(target, ".f5-migrated-from"), "skipped");
      return ready(null);
    }
    let inUse = false;
    if (options.platform === "win32") {
      try {
        const fd = FS.openSync(join(source, "lockfile"), "r+");
        FS.closeSync(fd);
      } catch (error) {
        inUse = ["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
      }
    } else {
      try {
        const link = FS.readlinkSync(join(source, "SingletonLock"));
        const match = /^(.*)-(\d+)$/.exec(link);
        inUse = !!match && match[1] === options.hostname && alive(Number(match[2]));
      } catch (error) {
        if (!["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
    if (inUse) return blocked("Quit F5 (Alpha) or T3 Code, then open F5 again.");
    const size = (path: string): number => {
      if (excluded.has(basename(path))) return 0;
      const stat = FS.lstatSync(path);
      return stat.isDirectory()
        ? FS.readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0)
        : stat.size;
    };
    const bytes = size(source);
    const disk = (options.statfs ?? FS.statfsSync)(options.appDataBase);
    if (Number(disk.bavail) * Number(disk.bsize) < bytes + 64 * 1024 * 1024)
      return blocked("Free up disk space before importing F5 settings.");
    temp = `${target}.migrating-${process.pid}-${randomUUID()}`;
    (options.copy ?? FS.cpSync)(source, temp, {
      recursive: true,
      filter: (path) => !excluded.has(basename(path)),
    });
    FS.writeFileSync(join(temp, ".f5-migrated-from"), source);
    FS.renameSync(temp, target);
    return ready(source);
  } catch (error) {
    return blocked(
      `Your original settings are unchanged. Try opening F5 again. ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      if (candidate) FS.unlinkSync(candidate);
    } catch {
      /* A candidate never owns the migration lock. */
    }
    // Preserve the original result if cleanup itself fails; the next launch retries leftovers.
    try {
      if (temp) FS.rmSync(temp, { recursive: true, force: true });
    } catch {
      /* Retry next launch. */
    }
    try {
      if (owned) FS.unlinkSync(lock);
    } catch {
      /* Target existence or dead-PID reclamation makes retry safe. */
    }
  }
}
