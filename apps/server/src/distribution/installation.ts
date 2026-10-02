// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { exists, atomicJson, readJson } from "./files";
import {
  cliTarget,
  parseRelease,
  selectArtifact,
  sha256File,
  versionToken,
  type CliRelease,
} from "@t3tools/shared/cliRelease";
const exec = promisify(execFile);
export interface InstalledRuntime {
  schemaVersion: 1;
  version: string;
  target: string;
}
export function runtimePaths(root: string, version: string) {
  const directory = path.join(root, "versions", versionToken(version));
  return {
    directory,
    executable: path.join(directory, process.platform === "win32" ? "f5.exe" : "f5"),
    node: path.join(directory, "runtime", process.platform === "win32" ? "node.exe" : "node"),
  };
}
export async function readInstalled(root: string): Promise<InstalledRuntime> {
  const value = await readJson(path.join(root, "current.json"));
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("version" in value) ||
    !("target" in value) ||
    value.target !== cliTarget()
  )
    throw new Error("Installation belongs to another architecture or is corrupt.");
  return { schemaVersion: 1, version: versionToken(value.version), target: cliTarget() };
}
export async function acquireInstallLock(root: string): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, ".install-lock");
  const handle = await fs.open(file, "wx", 0o600).catch(() => {
    throw new Error(
      "Another installation is active. If interrupted, remove .install-lock after confirming no installer is running.",
    );
  });
  await handle.writeFile(String(process.pid));
  await handle.close();
  return () => fs.unlink(file);
}
export async function fetchRelease(url: string): Promise<CliRelease> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Release manifests require HTTPS.");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("Could not fetch F5 release manifest.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("Release manifest is too large.");
    chunks.push(chunk);
  }
  return parseRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
/** Reject links and traversal before the tar process can write anything. */
export function validateArchiveListing(listing: string, verbose: string, stem: string): void {
  const entries = listing.trimEnd().split("\n");
  if (!entries.length || entries.length > 100_000) throw new Error("Invalid archive size.");
  for (const entry of entries) {
    if (
      !entry ||
      entry.includes("\\") ||
      entry.includes(":") ||
      [...entry].some((character) => character.charCodeAt(0) < 32) ||
      entry.split("/").some((part) => part.endsWith(".") || part.endsWith(" ")) ||
      entry.startsWith("/") ||
      entry.split("/").some((part) => part === ".." || part === ".") ||
      !(entry === stem || entry === stem + "/" || entry.startsWith(stem + "/"))
    )
      throw new Error("Unsafe archive path.");
  }
  const rows = verbose.trimEnd().split("\n");
  if (rows.length !== entries.length || rows.some((row) => row[0] !== "-" && row[0] !== "d"))
    throw new Error("Archives may contain only regular files and directories.");
  let expanded = 0;
  for (const row of rows) {
    // bsdtar has separate owner/group columns; GNU tar uses owner/group.
    const match =
      /^[d-]\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(row) ?? /^[d-]\S+\s+\S+\/\S+\s+(\d+)\s/.exec(row);
    if (!match) throw new Error("Unsupported archive listing format.");
    const size = Number(match[1]);
    expanded += size;
    if (
      !Number.isSafeInteger(size) ||
      size > 768 * 1024 * 1024 ||
      expanded > 2 * 1024 * 1024 * 1024
    )
      throw new Error("Expanded archive exceeds its size limit.");
  }
}
export async function preflightRuntime(root: string, version: string): Promise<void> {
  const paths = runtimePaths(root, version);
  await discoverNode([paths.node]);
  const result = await exec(paths.executable, ["runtime-preflight"], {
    cwd: paths.directory,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  const info: unknown = JSON.parse(result.stdout.trim());
  if (
    !info ||
    typeof info !== "object" ||
    !("version" in info) ||
    info.version !== version ||
    !("target" in info) ||
    info.target !== cliTarget() ||
    !("launcherProtocol" in info) ||
    info.launcherProtocol !== 1
  )
    throw new Error("Runtime failed launcher/architecture preflight.");
}
export async function stageRelease(
  root: string,
  release: CliRelease,
  progress: (message: string) => void = () => {},
): Promise<string> {
  const artifact = selectArtifact(release);
  const paths = runtimePaths(root, release.version);
  if (await exists(paths.directory)) {
    const sentinel = await readJson(path.join(paths.directory, ".install-complete"));
    if (
      !sentinel ||
      typeof sentinel !== "object" ||
      !("sha256" in sentinel) ||
      sentinel.sha256 !== artifact.sha256
    )
      throw new Error("An existing version has different immutable contents.");
    await preflightRuntime(root, release.version);
    return release.version;
  }
  const staging = path.join(root, `.stage-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const archive = path.join(staging, "archive.tar.gz");
  try {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error("Release download failed.");
    const handle = await fs.open(archive, "wx", 0o600);
    let received = 0;
    let lastPercent = -1;
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > artifact.size)
          throw new Error("Release download exceeds its declared size.");
        await handle.writeFile(chunk);
        const percent = Math.floor((received / artifact.size) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          progress(`Downloading ${percent}%`);
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (received !== artifact.size || (await sha256File(archive)) !== artifact.sha256)
      throw new Error("Release integrity verification failed.");
    const stem = `f5-${release.version}-${artifact.target}`;
    const listing = await exec("tar", ["-tzf", archive], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const verbose = await exec("tar", ["-tvzf", archive], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    validateArchiveListing(listing.stdout, verbose.stdout, stem);
    await exec("tar", ["-xzf", archive, "-C", staging], { timeout: 120_000, maxBuffer: 64 * 1024 });
    const content = path.join(staging, stem);
    const metadata = await readJson(path.join(content, "runtime.json"));
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("version" in metadata) ||
      metadata.version !== release.version ||
      !("target" in metadata) ||
      metadata.target !== cliTarget()
    )
      throw new Error("Archive architecture/version mismatch.");
    await atomicJson(path.join(content, ".install-complete"), {
      sha256: artifact.sha256,
      version: release.version,
      target: artifact.target,
    });
    await fs.mkdir(path.dirname(paths.directory), { recursive: true });
    await fs.rename(content, paths.directory);
    try {
      await preflightRuntime(root, release.version);
    } catch (error) {
      await fs.rename(paths.directory, path.join(root, `.rejected-${randomUUID()}`));
      throw error;
    }
    progress("Verified and prepared immutable runtime.");
    return release.version;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
/** Prefer the bundled Node, then validate an explicitly supplied/PATH runtime. */
export async function discoverNode(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const result = await exec(
        candidate,
        [
          "-p",
          "JSON.stringify({node:process.versions.node,arch:process.arch,platform:process.platform})",
        ],
        { timeout: 5000, maxBuffer: 1024 },
      );
      const value = JSON.parse(result.stdout) as { node: string; arch: string; platform: string };
      if (
        Number(value.node.split(".")[0]) >= 26 &&
        `${value.platform}-${value.arch}` === cliTarget()
      )
        return candidate;
    } catch {
      /* Try the next candidate. */
    }
  }
  throw new Error("No compatible Node 26 runtime was found.");
}
export function spawnRuntime(root: string, version: string, args: readonly string[]) {
  const paths = runtimePaths(root, version);
  return spawn(paths.executable, [...args], { cwd: process.cwd(), stdio: "inherit" });
}
