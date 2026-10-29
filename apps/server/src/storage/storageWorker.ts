import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FileIdentity, EnumeratedFile } from "./diskUsage.ts";
import { fileIdentity, measureTree, enumerateFiles, storageLstat } from "./diskUsage.ts";
import { discoverRepositories } from "./storageDiscovery.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import {
  readStorageProcesses,
  activityForTarget,
  inspectWindowsFileUse,
} from "./storageActivity.ts";
import { removeFileIfSafe, validateDeletablePath } from "./storagePathSafety.ts";
import { createHash, randomUUID } from "node:crypto";

export type StorageWorkerTask =
  | {
      kind: "providerCandidates";
      providerId: import("@t3tools/contracts").StorageCleanupCategoryId;
      root: string;
    }
  | { kind: "measure"; roots: string[]; checkpoints: string[]; fileRoots?: string[] }
  | { kind: "repositories"; roots: string[] }
  | { kind: "inspectBatch"; items: Array<{ path: string; application?: "chrome" | "bambu" }> }
  | { kind: "inspect"; path: string; application?: "chrome" | "bambu" }
  | {
      kind: "remove";
      providerId?: import("@t3tools/contracts").StorageCleanupCategoryId;
      path: string;
      allowedRoot: string;
      identity: FileIdentity;
      fingerprint: string;
      application?: "chrome" | "bambu";
    };
export interface StorageFileInspection {
  activity: import("./storageActivity.ts").StorageActivity;
  identity?: FileIdentity;
  fingerprint?: string;
  bytes?: number;
  removedBytes?: number;
  warnings?: Array<{ path: string; reason: string }>;
}
export interface StorageMeasurement {
  totalBytes: number;
  entries: number;
  byCheckpoint: Array<[string, { bytes: number; latestMtimeMs: number }]>;
  files: EnumeratedFile[];
  checkpointEntries: Array<{ path: string; identity: FileIdentity; bytes: number }>;
  warnings: Array<{ path: string; reason: string }>;
}
/** Cache configuration must never turn credentials, profiles or state into disposable data. */
export function isProtectedCleanupFile(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  return (
    parts.some((part) =>
      [".ssh", ".aws", ".kube", ".terraform", "secrets", "volumes"].includes(part),
    ) ||
    /(?:\.(?:sqlite3?|db|vscdb)(?:-(?:wal|shm|journal))?$|^terraform\.tfstate(?:\..*)?$)/.test(
      name,
    ) ||
    /^(?:\.env(?:\..*)?|\.npmrc|\.git-credentials|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|cookies|history|login data|web data|local state|preferences)(?:-(?:wal|shm|journal))?$/.test(
      name,
    )
  );
}
export async function executeStorageTask(
  task: StorageWorkerTask,
  snapshot?: Awaited<ReturnType<typeof readStorageProcesses>>,
  skipWindowsProbe = false,
): Promise<unknown> {
  if (task.kind === "providerCandidates") {
    const { discoverProviderCandidates } = await import("./cleanupProviders.ts");
    return discoverProviderCandidates(task.providerId, task.root);
  }
  if (task.kind === "repositories") return discoverRepositories(task.roots);
  if (task.kind === "measure") {
    const files: EnumeratedFile[] = [],
      checkpointEntries: StorageMeasurement["checkpointEntries"] = [];
    const checkpoints = new Set(task.checkpoints);
    const result = await measureTree(task.roots, {
      checkpoints: task.checkpoints,
      allowPartial: true,
      signal: AbortSignal.timeout(25_000),
      onEntry: ({ path, stat, bytes }) => {
        if (checkpoints.has(path))
          checkpointEntries.push({ path, identity: fileIdentity(stat), bytes });
        if (
          stat.isFile() &&
          task.fileRoots?.some(
            (root) =>
              path === root ||
              path.startsWith(root + (root.endsWith("/") ? "" : "/")) ||
              path.startsWith(root + "\\"),
          )
        )
          files.push({
            path,
            name: path.split(/[\\/]/).pop()!,
            bytes,
            mtimeMs: stat.mtimeMs,
            identity: fileIdentity(stat),
          });
      },
    });
    return { ...result, byCheckpoint: [...result.byCheckpoint], files, checkpointEntries };
  }
  if (task.kind === "inspectBatch") {
    const processes = await readStorageProcesses();
    const results: Array<{ path: string; inspection?: StorageFileInspection; error?: string }> = [];
    for (const item of task.items) {
      try {
        results.push({
          path: item.path,
          inspection: (await executeStorageTask(
            { kind: "inspect", ...item },
            processes,
            true,
          )) as StorageFileInspection,
        });
      } catch (error) {
        results.push({ path: item.path, error: String(error) });
      }
    }
    if (process.platform === "win32") {
      const files = (
        await Promise.all(task.items.map((item) => enumerateFiles(item.path)))
      ).flatMap((entry) => entry.files.map((file) => file.path));
      const activity = await inspectWindowsFileUse(files);
      if (activity.state !== "idle")
        for (const result of results) if (result.inspection) result.inspection.activity = activity;
    }
    return results;
  }
  const processes = snapshot ?? (await readStorageProcesses());
  let activity = activityForTarget(await FS.realpath(task.path), processes, task.application);
  const stat = await storageLstat(task.path);
  const enumerated = await enumerateFiles(task.path, { maxDepth: 32 });
  if (enumerated.errors.length) throw new Error("Could not completely inspect the cleanup target.");
  if (process.platform === "win32" && !skipWindowsProbe && activity.state === "idle")
    activity = await inspectWindowsFileUse(enumerated.files.map((file) => file.path));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        enumerated.files
          .toSorted((a, b) => a.path.localeCompare(b.path))
          .map((f) => [f.path, f.identity]),
      ),
    )
    .digest("hex");
  const result: StorageFileInspection = {
    activity,
    identity: fileIdentity(stat),
    fingerprint,
    bytes: enumerated.files.reduce((n, f) => n + f.bytes, 0),
  };
  if (task.kind === "inspect" || activity.state !== "idle") return result;
  if (fingerprint !== task.fingerprint)
    throw new Error("Files changed since review. Rescan before deletion.");
  const validation = await validateDeletablePath({
    path: task.path,
    allowedRoot: task.allowedRoot,
    expectedIdentity: task.identity,
  });
  if (validation.kind !== "validated")
    throw new Error(validation.kind === "refused" ? validation.reason : "Cleanup target changed.");
  // Enumeration may take time. Recheck application activity after the reviewed
  // fingerprint/identity check and immediately before starting mutations.
  if (!snapshot) {
    activity = activityForTarget(
      await FS.realpath(task.path),
      await readStorageProcesses(),
      task.application,
    );
    if (process.platform === "win32" && activity.state === "idle")
      activity = await inspectWindowsFileUse(enumerated.files.map((file) => file.path));
    if (activity.state !== "idle") return { ...result, activity };
  }
  let removedBytes = 0;
  const warnings: Array<{ path: string; reason: string }> = [];
  let deletionRoot = task.path;
  let allowedRoot = task.allowedRoot;
  if (task.providerId === "bunDownloadCache") {
    // Bun treats a package directory's existence as a cache hit. Atomically
    // detach the complete reviewed cache before touching any package contents.
    // Cancellation, partial cleanup and protected files then cannot leave a
    // half-populated package in the live cache. Leftovers are discoverable.
    deletionRoot = Path.join(Path.dirname(task.path), ".f5-bun-cache-trash-" + randomUUID());
    await FS.rename(task.path, deletionRoot);
    const moved = await storageLstat(deletionRoot);
    if (moved.dev !== stat.dev || moved.ino !== stat.ino)
      throw new Error("Bun cache identity changed before quarantine. Files retained.");
    if (!Path.basename(task.path).startsWith(".f5-bun-cache-trash-"))
      await FS.mkdir(task.path, { mode: stat.mode & 0o777 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    allowedRoot = Path.dirname(deletionRoot);
  }
  for (const file of enumerated.files) {
    if (task.providerId !== "f5Backups" && isProtectedCleanupFile(file.path)) {
      warnings.push({ path: file.path, reason: "Protected state or credentials retained." });
      continue;
    }
    const outcome = await removeFileIfSafe({
      path:
        deletionRoot === task.path
          ? file.path
          : Path.join(deletionRoot, Path.relative(task.path, file.path)),
      allowedRoot,
      expectedIdentity: file.identity,
    });
    if (outcome.kind === "removed") removedBytes += outcome.bytes;
    else if (outcome.warning) warnings.push(outcome.warning);
  }
  if (deletionRoot !== task.path) {
    // Prune only ancestors of reviewed files, deepest first. Do not discover
    // or traverse new directories while deleting the quarantine.
    const directories = new Set([deletionRoot]);
    for (const file of enumerated.files) {
      let directory = Path.dirname(Path.join(deletionRoot, Path.relative(task.path, file.path)));
      while (directory !== deletionRoot) {
        directories.add(directory);
        directory = Path.dirname(directory);
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      const validated = await validateDeletablePath({
        path: directory,
        allowedRoot,
        ...(directory === deletionRoot
          ? { expectedIdentity: task.identity, directoryIdentityOnly: true }
          : {}),
      });
      if (validated.kind !== "validated" || !validated.stat.isDirectory()) continue;
      await FS.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code ?? ""))
          warnings.push({
            path: directory,
            reason: "Retained quarantine directory: " + String(error),
          });
      });
    }
    if (warnings.length)
      warnings.push({
        path: deletionRoot,
        reason:
          "Retained Bun cache files are outside the live cache and remain available for review.",
      });
  }
  // Preserve directories and files created during cleanup; never recursively remove a cache.
  return { ...result, removedBytes, warnings };
}

export async function measureStorageRoots(
  roots: string[],
  checkpoints: string[],
  fileRoots: string[],
  signal?: AbortSignal,
  progress?: (entries: number) => void,
) {
  const uniqueRoots = [...new Set(roots.map((root) => Path.resolve(root)))].filter(
    (root, _, all) =>
      !all.some(
        (other) =>
          other !== root &&
          !Path.relative(other, root).startsWith("..") &&
          !Path.isAbsolute(Path.relative(other, root)),
      ),
  );
  const combined: StorageMeasurement = {
    totalBytes: 0,
    entries: 0,
    byCheckpoint: [],
    files: [],
    checkpointEntries: [],
    warnings: [],
  };
  const byCheckpoint = new Map<string, { bytes: number; latestMtimeMs: number }>();
  for (const root of uniqueRoots) {
    signal?.throwIfAborted();
    try {
      const result = await runStorageTask<StorageMeasurement>(
        { kind: "measure", roots: [root], checkpoints, fileRoots },
        signal,
      );
      combined.totalBytes += result.totalBytes;
      combined.entries += result.entries;
      combined.files.push(...result.files);
      combined.checkpointEntries.push(...result.checkpointEntries);
      combined.warnings.push(...result.warnings);
      for (const [path, usage] of result.byCheckpoint) {
        const previous = byCheckpoint.get(path);
        byCheckpoint.set(path, {
          bytes: (previous?.bytes ?? 0) + usage.bytes,
          latestMtimeMs: Math.max(previous?.latestMtimeMs ?? 0, usage.latestMtimeMs),
        });
      }
    } catch (error) {
      signal?.throwIfAborted();
      combined.warnings.push({
        path: root,
        reason: "Could not complete this root's storage measurement: " + String(error),
      });
    }
    progress?.(combined.entries);
  }
  combined.byCheckpoint = [...byCheckpoint];
  return combined;
}

/** Runs through the independently bundled maintenance entry, without Electron ASAR semantics. */
export function runStorageTask<A>(
  task: StorageWorkerTask,
  signal?: AbortSignal,
  // Cache inspection/removal can involve millions of files. Their lifetime is
  // controlled by cancellation and the owner pipe, not an absolute 30s cutoff.
  timeoutMs: number | undefined = ["inspectBatch", "inspect", "remove"].includes(task.kind)
    ? undefined
    : 30_000,
): Promise<A> {
  const source = import.meta.url.endsWith(".ts");
  const entry = source
    ? fileURLToPath(new URL("../backupMaintenanceEntry.ts", import.meta.url))
    : fileURLToPath(
        new URL(
          "./maintenance/backup-maintenance." + (import.meta.url.endsWith(".cjs") ? "cjs" : "mjs"),
          import.meta.url,
        ),
      );
  return new Promise((resolve, reject) => {
    const child = spawn(
      source && !process.versions.bun ? "bun" : process.execPath,
      process.env.F5_STANDALONE === "1"
        ? ["--internal-backup-export"]
        : [entry, "--internal-backup-export"],
      {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    let output = "",
      failure: Error | undefined;
    const abort = () => {
      failure ??= new Error("Storage discovery cancelled or timed out.");
      child.kill("SIGKILL");
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 16 * 1024 * 1024) abort();
    });
    child.stderr.on("data", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try {
        const response = JSON.parse(output);
        if (code !== 0 || response.error || !("storage" in response))
          throw new Error(response.error ?? "Storage worker failed.");
        resolve(response.storage as A);
      } catch (error) {
        reject(error);
      }
    });
    if (signal?.aborted) abort();
    else child.stdin.end(JSON.stringify({ kind: "storage", task }));
  });
}
