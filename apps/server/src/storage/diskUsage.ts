import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as NodeFS from "node:fs/promises";
import { createRequire } from "node:module";
import type { Stats, Dirent } from "node:fs";
import * as Path from "node:path";
import type { StoragePathWarning } from "@t3tools/contracts";
// Electron's fs treats *.asar files as directories and retains archive handles.
// Ordinary filesystem semantics also apply to legacy and per-target measurements.
const FS: typeof NodeFS = process.versions.electron
  ? createRequire(import.meta.url)("original-fs").promises
  : NodeFS;

export interface DiskUsageResult {
  readonly bytes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly errors: ReadonlyArray<StoragePathWarning>;
}
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}
export interface EnumeratedFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly identity?: FileIdentity;
}
export interface DiskUsageFs {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
}
export interface DiskUsageOptions {
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
  readonly fs?: DiskUsageFs;
}

// Every walk shares these permits. A permit covers one syscall, never a subtree.
let activeCalls = 0;
const waiters: Array<() => void> = [];
async function fsCall<A>(call: () => Promise<A>, signal?: AbortSignal): Promise<A> {
  signal?.throwIfAborted();
  if (activeCalls >= 16) await new Promise<void>((resolve) => waiters.push(resolve));
  else activeCalls++;
  try {
    signal?.throwIfAborted();
    return await call();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeCalls--;
  }
}
export const storageLstat = (path: string, signal?: AbortSignal): Promise<Stats> =>
  fsCall(() => FS.lstat(path), signal);
export function storageReadDir(
  path: string,
  options?: undefined,
  signal?: AbortSignal,
): Promise<string[]>;
export function storageReadDir(
  path: string,
  options: { withFileTypes: true },
  signal?: AbortSignal,
): Promise<Dirent[]>;
export function storageReadDir(
  path: string,
  options?: { withFileTypes: true },
  signal?: AbortSignal,
): Promise<string[] | Dirent[]> {
  return options
    ? fsCall(() => FS.readdir(path, options), signal)
    : fsCall(() => FS.readdir(path), signal);
}
export function allocatedBytes(
  stat: Pick<Stats, "blocks" | "size">,
  platform = process.platform,
): number {
  // Windows reports zero for the unsupported st_blocks field, even for
  // non-empty files. POSIX zero blocks remains valid for sparse files.
  return platform !== "win32" && typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
}
export function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}
export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.mode === b.mode
  );
}
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(Path.sep) ? root : `${root}${Path.sep}`);
}
export interface WalkEntry {
  readonly path: string;
  readonly stat: Stats;
  readonly bytes: number;
  /** Only enclosing checkpoints, inherited through the DFS frontier. */
  readonly checkpoints: ReadonlyArray<string>;
}
export async function walkTree(
  roots: ReadonlyArray<string>,
  options: DiskUsageOptions & {
    readonly checkpoints?: ReadonlyArray<string>;
    readonly onEntry: (entry: WalkEntry) => void;
  },
): Promise<ReadonlyArray<StoragePathWarning>> {
  const fs = options.fs ?? FS;
  const checkpoints = new Set((options.checkpoints ?? []).map((path) => Path.resolve(path)));
  const uniqueRoots = [...new Set(roots.map((path) => Path.resolve(path)))].filter(
    (root, _, all) => !all.some((other) => other !== root && within(other, root)),
  );
  const stack = uniqueRoots.map((path) => ({
    path,
    depth: 0,
    checkpoints: [...checkpoints].filter((checkpoint) => within(checkpoint, path)),
  }));
  let processing = 0;
  let stopped = false;
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const resume of waiting) resume();
    waiting.clear();
  };
  const seen = new Set<string>();
  const warnings: StoragePathWarning[] = [];
  const warn = (path: string, error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    if (warnings.length < 201)
      warnings.push({ path, reason: error instanceof Error ? error.message : String(error) });
  };
  async function worker(): Promise<void> {
    for (;;) {
      options.signal?.throwIfAborted();
      if (stopped) return;
      const next = stack.pop();
      if (!next) {
        if (processing === 0) return;
        await new Promise<void>((resolve) => waiting.add(resolve));
        continue;
      }
      processing++;
      try {
        const { path } = next;
        let stat: Stats;
        try {
          stat = await fsCall(() => fs.lstat(path), options.signal);
        } catch (error) {
          options.signal?.throwIfAborted();
          warn(path, error);
          continue;
        }
        let bytes = allocatedBytes(stat);
        if (stat.nlink > 1 && !stat.isDirectory()) {
          const key = `${stat.dev}:${stat.ino}`;
          if (seen.has(key)) bytes = 0;
          else seen.add(key);
        }
        const enclosing =
          checkpoints.has(path) && !next.checkpoints.includes(path)
            ? [...next.checkpoints, path]
            : next.checkpoints;
        options.onEntry({ path, stat, bytes, checkpoints: enclosing });
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const depth = checkpoints.has(path) ? 0 : next.depth;
        if (depth >= (options.maxDepth ?? 32)) {
          warn(path, new Error(`Maximum scan depth ${options.maxDepth ?? 32} reached.`));
          continue;
        }
        try {
          const entries = await fsCall(
            () => fs.readdir(path, { withFileTypes: true }),
            options.signal,
          );
          for (const entry of entries)
            stack.push({
              path: Path.join(path, entry.name),
              depth: depth + 1,
              checkpoints: enclosing,
            });
        } catch (error) {
          options.signal?.throwIfAborted();
          warn(path, error);
        }
      } finally {
        processing--;
        wake();
      }
    }
  }
  // Workers are fixed, avoiding recursive per-directory fan-out.
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(options.signal?.reason ?? new Error("Storage traversal aborted."));
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([Promise.all(Array.from({ length: 16 }, () => worker())), aborted]);
  } finally {
    stopped = true;
    wake();
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
  return warnings;
}
export async function measureTree(
  roots: ReadonlyArray<string>,
  options: DiskUsageOptions & {
    readonly checkpoints: ReadonlyArray<string>;
    readonly onEntry?: (entry: WalkEntry) => void;
    readonly allowPartial?: boolean;
  },
) {
  const byCheckpoint = new Map(
    options.checkpoints.map((path) => [Path.resolve(path), { bytes: 0, latestMtimeMs: 0 }]),
  );
  let totalBytes = 0;
  let entries = 0;
  const warnings = await walkTree(roots, {
    ...options,
    onEntry: (entry) => {
      const { stat, bytes } = entry;
      options.onEntry?.(entry);
      totalBytes += bytes;
      entries++;
      for (const checkpoint of entry.checkpoints) {
        const measurement = byCheckpoint.get(checkpoint);
        if (measurement) {
          measurement.bytes += bytes;
          measurement.latestMtimeMs = Math.max(measurement.latestMtimeMs, stat.mtimeMs);
        }
      }
    },
  }).catch((error: unknown) => {
    if (!options.allowPartial || !options.signal?.aborted) throw error;
    return roots.map((path) => ({
      path,
      reason: "Storage measurement time budget reached; results are partial.",
    }));
  });
  return { totalBytes, entries, byCheckpoint, warnings };
}
export async function recursiveSize(
  rootPath: string,
  options: DiskUsageOptions = {},
): Promise<DiskUsageResult> {
  let bytes = 0,
    fileCount = 0,
    directoryCount = 0;
  const errors = await walkTree([rootPath], {
    ...options,
    onEntry: (entry) => {
      bytes += entry.bytes;
      if (entry.stat.isDirectory()) directoryCount++;
      else fileCount++;
    },
  });
  return { bytes, fileCount, directoryCount, errors };
}
export async function enumerateFiles(rootPath: string, options: DiskUsageOptions = {}) {
  const files: EnumeratedFile[] = [];
  const errors = await walkTree([rootPath], {
    ...options,
    onEntry: ({ path, stat, bytes }) => {
      if (stat.isFile())
        files.push({
          path,
          name: Path.basename(path),
          bytes,
          mtimeMs: stat.mtimeMs,
          identity: fileIdentity(stat),
        });
    },
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, errors };
}
export const sizeIfExists = recursiveSize;

/** A file is attributed only when its segment is unambiguous. */
export function indexFilesBySegment(
  files: ReadonlyArray<EnumeratedFile>,
  segments: ReadonlySet<string>,
  kind: "attachments" | "logs",
) {
  const result = new Map<string, EnumeratedFile[]>();
  for (const file of files) {
    const id = kind === "attachments" ? parseAttachmentIdFromRelativePath(file.name) : null;
    const segment =
      kind === "logs"
        ? /^(.+)\.log(?:\.\d+)?$/.exec(file.name)?.[1]
        : id
          ? parseThreadSegmentFromAttachmentId(id)
          : null;
    if (!segment || !segments.has(segment)) continue;
    const bucket = result.get(segment) ?? [];
    bucket.push(file);
    result.set(segment, bucket);
  }
  return result;
}
