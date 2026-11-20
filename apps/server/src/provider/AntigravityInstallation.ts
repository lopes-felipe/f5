import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compareCliVersions } from "./cliVersion";
import { lookupAntigravityCliRelease, parseAntigravityCliRelease } from "./antigravityCliRelease";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

export interface AntigravityExecutable {
  executablePath: string;
  harnessPath?: string;
  version: string;
}

export class AntigravityUpdateRequiredError extends Error {
  constructor(
    readonly installedVersion: string,
    requiredVersion: string,
  ) {
    super(
      `Antigravity ${installedVersion} is installed. Update to ${requiredVersion} using Install Antigravity in Settings before starting a new session.`,
    );
  }
}

/** Only explicitly invoked setup may download. Probes and turns only resolve a complete release. */
export class AntigravityInstallation {
  readonly directory: string;
  private pending: Promise<AntigravityExecutable> | undefined;
  constructor(
    stateDir: string,
    private readonly asset = resolveAntigravityReleaseAsset(process.platform, process.arch),
    private readonly lookupUpdate = asset ===
    resolveAntigravityReleaseAsset(process.platform, process.arch)
      ? lookupAntigravityCliRelease
      : undefined,
  ) {
    this.directory = path.join(stateDir, "providers", "antigravity", "releases");
  }
  async resolve(): Promise<AntigravityExecutable> {
    const active = await this.activeAsset();
    return this.resolveRelease(active ?? this.asset);
  }
  private async activeAsset(): Promise<AntigravityReleaseAsset | null> {
    if (!this.lookupUpdate) return null;
    try {
      const pointer = path.join(this.directory, "active.json");
      const stat = await fs.lstat(pointer);
      if (!stat.isFile() || stat.size > 4096) return null;
      const active = parseAntigravityCliRelease(
        JSON.parse(await fs.readFile(pointer, "utf8")),
        process.platform,
        process.arch,
      );
      return active && (!this.asset || compareCliVersions(active.version, this.asset.version) > 0)
        ? active
        : null;
    } catch {
      return null;
    }
  }
  private async resolveRelease(
    asset: AntigravityReleaseAsset | null,
  ): Promise<AntigravityExecutable> {
    if (!asset) throw new Error("Antigravity does not support this platform and architecture.");
    const directory = path.join(this.directory, asset.sha512);
    const record = await fs.readFile(path.join(directory, "complete.json"), "utf8").catch(() => "");
    if (record !== JSON.stringify({ sha512: asset.sha512, version: asset.version })) {
      const installedVersion = await this.previousInstalledVersion();
      if (installedVersion)
        throw new AntigravityUpdateRequiredError(installedVersion, asset.version);
      throw new Error("Install Antigravity in Settings before using it.");
    }
    for (const file of [asset.executable, ...(asset.harness ? [asset.harness] : [])]) {
      const stat = await fs.lstat(path.join(directory, file.name));
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > 1024 * 1024 * 1024 ||
        (file.bytes !== undefined && stat.size !== file.bytes)
      )
        throw new Error(
          "Antigravity installation is incomplete. Inspect the managed release directory before reinstalling.",
        );
    }
    return {
      executablePath: path.join(directory, asset.executable.name),
      ...(asset.harness ? { harnessPath: path.join(directory, asset.harness.name) } : {}),
      version: asset.version,
    };
  }
  install(signal?: AbortSignal): Promise<AntigravityExecutable> {
    if (this.pending) return this.pending;
    const pending = this.installRelease(signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
  private async previousInstalledVersion(): Promise<string | undefined> {
    const directories = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of directories) {
      if (
        !entry.isDirectory() ||
        !/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(entry.name) ||
        entry.name === this.asset?.sha512
      )
        continue;
      const recordPath = path.join(this.directory, entry.name, "complete.json");
      const stat = await fs.lstat(recordPath).catch(() => undefined);
      if (!stat?.isFile() || stat.size > 512) continue;
      try {
        const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
        if (
          (record.sha512 ?? record.sha256) === entry.name &&
          /^\d+\.\d+\.\d+$/.test(record.version)
        )
          return record.version;
      } catch {
        // Incomplete releases do not establish an installed version.
      }
    }
    return undefined;
  }
  private async installRelease(signal?: AbortSignal): Promise<AntigravityExecutable> {
    let asset = this.asset;
    if (!asset) throw new Error("Antigravity does not support this platform and architecture.");
    let current: AntigravityExecutable | undefined;
    try {
      current = await this.resolve();
    } catch {
      // A complete release is immutable. Do not overwrite an invalid existing directory.
      const destination = path.join(this.directory, asset.sha512);
      const exists = await fs.lstat(destination).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists)
        throw new Error(
          `Antigravity installation is incomplete. Inspect ${destination} before reinstalling.`,
        );
    }
    if (current) {
      const update = await this.lookupUpdate?.(signal);
      if (!update || compareCliVersions(update.version, current.version) <= 0) return current;
      asset = update;
      const existing = await fs.lstat(path.join(this.directory, asset.sha512)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) return this.activate(asset);
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const disk = await fs.statfs(this.directory);
    const requiredBytes =
      asset.archiveBytes +
      (asset.executable.bytes ?? 1024 * 1024 * 1024) +
      (asset.harness?.bytes ?? 0) +
      64 * 1024 * 1024;
    if (disk.bavail * disk.bsize < requiredBytes)
      throw new Error("Not enough free disk space to stage and verify Antigravity.");
    const staging = await fs.mkdtemp(path.join(this.directory, ".install-"));
    const archive = path.join(staging, "release.zip");
    const combined = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(45 * 60 * 1000),
    ]);
    try {
      const response = await fetch(asset.url, { signal: combined, redirect: "error" });
      if (!response.ok || !response.body)
        throw new Error(`Antigravity download failed (${response.status}).`);
      const hash = createHash("sha512");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body as never),
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > asset.archiveBytes)
              return done(new Error("Antigravity archive exceeds its pinned byte limit."));
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal: combined },
      );
      if (
        (!asset.archiveSizeUnknown && bytes !== asset.archiveBytes) ||
        bytes === 0 ||
        hash.digest("hex") !== asset.sha512
      )
        throw new Error("Antigravity archive integrity check failed.");
      if (asset.format === "executable") {
        await fs.rename(archive, path.join(staging, asset.executable.name));
        await fs.chmod(path.join(staging, asset.executable.name), 0o700);
      } else {
        if (asset.format === "tar.gz")
          await extractCliExecutable(archive, staging, asset.executable.name, combined);
        else await extractPinnedExecutables(archive, staging, asset, combined);
        await fs.unlink(archive);
      }
      const record = await fs.open(path.join(staging, "complete.json"), "wx", 0o600);
      try {
        await record.writeFile(JSON.stringify({ sha512: asset.sha512, version: asset.version }));
        await record.sync();
      } finally {
        await record.close();
      }
      // Retain earlier immutable releases: another process can still be running
      // their agent or harness. Cleanup needs cross-process runtime ownership.
      combined.throwIfAborted();
      const destination = path.join(this.directory, asset.sha512);
      try {
        await fs.rename(staging, destination);
      } catch (error) {
        // Another installer may have published first; never replace its complete release.
        try {
          return await this.activate(asset);
        } catch {
          throw error;
        }
      }
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return await this.activate(asset);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  private async activate(asset: AntigravityReleaseAsset) {
    const executable = await this.resolveRelease(asset);
    const active = await this.activeAsset();
    if (active && compareCliVersions(active.version, asset.version) > 0)
      return this.resolveRelease(active);
    if (asset !== this.asset) {
      const temporary = path.join(this.directory, ".active-" + randomUUID());
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(asset));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, path.join(this.directory, "active.json"));
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    return executable;
  }
}

/** Extract exactly the pinned CLI member to stdout; archive paths and links never write to disk. */
async function extractCliExecutable(
  archive: string,
  directory: string,
  name: string,
  signal: AbortSignal,
) {
  const child = spawn("tar", ["-xzOf", archive, name], {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-1000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      code === 0 && !failure
        ? resolve()
        : reject(failure ?? new Error("Could not extract Antigravity CLI: " + diagnostic)),
    );
  });
  // Attach rejection immediately, even if streaming fails first.
  void exited.catch(() => {});
  let bytes = 0;
  try {
    await pipeline(
      child.stdout,
      new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(
            bytes > 1024 * 1024 * 1024
              ? new Error("Antigravity CLI exceeds its extraction limit.")
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(path.join(directory, name), { flags: "wx", mode: 0o700 }),
      { signal },
    );
    await exited;
    if (!bytes) throw new Error("Antigravity CLI archive contains no executable.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
  }
}

async function extractPinnedExecutables(
  archive: string,
  directory: string,
  asset: AntigravityReleaseAsset,
  signal: AbortSignal,
): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true, autoClose: false }, (error, file) =>
      error ? reject(error) : resolve(file!),
    ),
  );
  const expected = new Map(
    [asset.executable, ...(asset.harness ? [asset.harness] : [])].map((entry) => [
      entry.name,
      entry.bytes,
    ]),
  );
  const found = new Set<string>();
  try {
    // Only one read/extract operation runs at a time. Cancellation waits for its
    // pipeline to close before the staging directory is removed.
    while (true) {
      signal.throwIfAborted();
      const entry = await new Promise<yauzl.Entry | undefined>((resolve, reject) => {
        const cleanup = () => {
          zip.off("entry", onEntry);
          zip.off("end", onEnd);
          zip.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const onEntry = (entry: yauzl.Entry) => {
          cleanup();
          resolve(entry);
        };
        const onEnd = () => {
          cleanup();
          resolve(undefined);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          cleanup();
          reject(signal.reason);
        };
        zip.once("entry", onEntry);
        zip.once("end", onEnd);
        zip.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        zip.readEntry();
      });
      if (!entry) break;
      const name = path.posix.basename(entry.fileName);
      const size = expected.get(name);
      if (size === undefined) continue;
      const mode = entry.externalFileAttributes >>> 16;
      if (found.has(name) || entry.uncompressedSize !== size || (mode & 0o170000) === 0o120000)
        throw new Error("Unexpected Antigravity archive entry.");
      found.add(name);
      const stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!))),
      );
      let bytes = 0;
      const target = path.join(directory, name);
      await pipeline(
        stream,
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            done(bytes > size ? new Error("Executable exceeds pinned size.") : null, chunk);
          },
        }),
        createWriteStream(target, { flags: "wx", mode: 0o700 }),
        { signal },
      );
      if (bytes !== size) throw new Error("Executable size does not match pinned release.");
      const handle = await fs.open(target, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (found.size !== expected.size)
      throw new Error("Antigravity archive is missing its executables.");
  } finally {
    zip.close();
  }
}
