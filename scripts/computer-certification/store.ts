import { mkdir, open, readFile, readdir, lstat, unlink, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeManifest, decodeResult, type Manifest, type ScenarioResult } from "./model";

const MAX_BYTES = 1024 * 1024;
export async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
    throw new Error("Unsafe or oversized evidence file");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function writeExclusive(path: string, value: unknown): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close();
    // Publish atomically without replacing an existing attempt. Readers never
    // encounter a partially written result.
    await link(temporary, path);
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary);
  }
}
export async function initialize(directory: string, manifest: Manifest): Promise<void> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Suite directory cannot be a symbolic link");
  await writeExclusive(join(root, "manifest.json"), decodeManifest(manifest));
}
export const loadManifest = async (directory: string) =>
  decodeManifest(await readJson(join(directory, "manifest.json")));
export async function loadResults(
  directory: string,
  manifest: Manifest,
): Promise<ScenarioResult[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".result.json")).sort();
  if (names.length > 10000) throw new Error("Too many certification attempts");
  return Promise.all(
    names.map(async (name) => decodeResult(await readJson(join(directory, name)), manifest)),
  );
}
export const attemptName = (scenario: string, attempt: number) =>
  scenario + "." + String(attempt).padStart(3, "0");
export async function saveResult(directory: string, manifest: Manifest, result: ScenarioResult) {
  const safe = decodeResult(result, manifest);
  await writeExclusive(
    join(directory, attemptName(safe.scenario, safe.attempt) + ".result.json"),
    safe,
  );
}

/** Exclusive suite admission also protects against two foreground-input runners. */
export async function lockSuite(directory: string, recover: boolean): Promise<() => Promise<void>> {
  const path = join(directory, "runner.lock");
  const nonce = randomUUID();
  try {
    await writeExclusive(path, { pid: process.pid, nonce });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !recover)
      throw new Error("Suite runner is already admitted");
    const previous = (await readJson(path)) as { pid?: unknown; nonce?: unknown };
    if (!Number.isInteger(previous.pid) || Number(previous.pid) <= 0)
      throw new Error("Invalid runner lock");
    let alive = true;
    try {
      process.kill(Number(previous.pid), 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("Previous runner may still be active; refusing recovery");
    await unlink(path);
    await writeExclusive(path, { pid: process.pid, nonce });
  }
  return async () => {
    const current = (await readJson(path)) as { nonce?: unknown };
    if (current.nonce !== nonce) throw new Error("Runner lock ownership changed");
    await unlink(path);
  };
}
