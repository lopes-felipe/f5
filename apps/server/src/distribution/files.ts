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
