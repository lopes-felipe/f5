import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { StoragePathWarning } from "@t3tools/contracts";

export interface DiskUsageResult {
  readonly bytes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly errors: ReadonlyArray<StoragePathWarning>;
}

export interface EnumeratedFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface DiskUsageOptions {
  readonly maxDepth?: number;
  readonly perDirConcurrency?: number;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_PER_DIR_CONCURRENCY = 8;

async function lstatOrWarning(
  targetPath: string,
): Promise<
  { ok: true; stat: import("node:fs").Stats } | { ok: false; warning: StoragePathWarning }
> {
  try {
    return { ok: true, stat: await FS.lstat(targetPath) };
  } catch (error) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function recursiveSize(
  rootPath: string,
  options: DiskUsageOptions = {},
): Promise<DiskUsageResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const perDirConcurrency = Math.max(1, options.perDirConcurrency ?? DEFAULT_PER_DIR_CONCURRENCY);
  const errors: StoragePathWarning[] = [];
  let bytes = 0;
  let fileCount = 0;
  let directoryCount = 0;

  async function visit(targetPath: string, depth: number): Promise<void> {
    const statResult = await lstatOrWarning(targetPath);
    if (!statResult.ok) {
      errors.push(statResult.warning);
      return;
    }

    const stat = statResult.stat;
    bytes += stat.size;
    if (stat.isDirectory()) {
      directoryCount += 1;
    } else {
      fileCount += 1;
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }

    if (depth >= maxDepth) {
      errors.push({
        path: targetPath,
        reason: `Maximum scan depth ${maxDepth} reached.`,
      });
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await FS.readdir(targetPath, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: targetPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (let index = 0; index < entries.length; index += perDirConcurrency) {
      const batch = entries.slice(index, index + perDirConcurrency);
      await Promise.all(batch.map((entry) => visit(Path.join(targetPath, entry.name), depth + 1)));
    }
  }

  await visit(rootPath, 0);
  return { bytes, fileCount, directoryCount, errors };
}

export async function enumerateFiles(
  rootPath: string,
  options: DiskUsageOptions = {},
): Promise<{ files: ReadonlyArray<EnumeratedFile>; errors: ReadonlyArray<StoragePathWarning> }> {
  const files: EnumeratedFile[] = [];
  const errors: StoragePathWarning[] = [];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const perDirConcurrency = Math.max(1, options.perDirConcurrency ?? DEFAULT_PER_DIR_CONCURRENCY);

  async function visit(targetPath: string, depth: number): Promise<void> {
    const statResult = await lstatOrWarning(targetPath);
    if (!statResult.ok) {
      errors.push(statResult.warning);
      return;
    }
    const stat = statResult.stat;
    if (stat.isFile()) {
      files.push({
        path: targetPath,
        name: Path.basename(targetPath),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return;
    }
    if (depth >= maxDepth) {
      errors.push({
        path: targetPath,
        reason: `Maximum scan depth ${maxDepth} reached.`,
      });
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await FS.readdir(targetPath, { withFileTypes: true });
    } catch (error) {
      errors.push({
        path: targetPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (let index = 0; index < entries.length; index += perDirConcurrency) {
      const batch = entries.slice(index, index + perDirConcurrency);
      await Promise.all(batch.map((entry) => visit(Path.join(targetPath, entry.name), depth + 1)));
    }
  }

  await visit(rootPath, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, errors };
}

export async function sizeIfExists(path: string): Promise<DiskUsageResult> {
  try {
    await FS.lstat(path);
  } catch {
    return { bytes: 0, fileCount: 0, directoryCount: 0, errors: [] };
  }
  return recursiveSize(path);
}
