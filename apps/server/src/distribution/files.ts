// @effect-diagnostics nodeBuiltinImport:off
// The installation journal must work without the server's Effect runtime.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function syncDirectory(directory: string): Promise<void> {
  // NTFS journals renames; Windows does not support directory fsync.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}
export async function readJson(file: string): Promise<unknown> {
  if ((await fs.stat(file)).size > 1024 * 1024)
    throw new Error("Installation metadata is too large.");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function copyDurable(source: string, destination: string): Promise<void> {
  await fs.copyFile(source, destination);
  const handle = await fs.open(destination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const RENAME_LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameRetryOptions {
  readonly platform?: NodeJS.Platform;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
  readonly delayMs?: number;
}

/**
 * Rename, retrying while Windows reports the source or target as in use. Antivirus and the
 * search indexer briefly open freshly extracted files, which makes a directory rename fail
 * with EPERM/EBUSY/EACCES. A denial that outlasts the attempts (10 s by default) is rethrown.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts =
    (options.platform ?? process.platform) === "win32" ? (options.attempts ?? 50) : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !RENAME_LOCK_CODES.has(code)) throw error;
      await sleep(options.delayMs ?? 200);
    }
  }
}

/** Publish fully synced metadata without exposing an empty file or replacing another writer. */
export async function exclusiveJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.unlink(temporary);
  }
}
