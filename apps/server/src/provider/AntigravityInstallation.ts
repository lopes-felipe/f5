import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

export interface AntigravityExecutable {
  executablePath: string;
  harnessPath: string;
  version: string;
}

/** Only explicitly invoked setup may download. Probes and turns only resolve a complete release. */
export class AntigravityInstallation {
  readonly directory: string;
  private pending: Promise<AntigravityExecutable> | undefined;
  constructor(
    stateDir: string,
    private readonly asset = resolveAntigravityReleaseAsset(process.platform, process.arch),
  ) {
    this.directory = path.join(stateDir, "providers", "antigravity", "releases");
  }
  async resolve(): Promise<AntigravityExecutable> {
    const asset = this.asset;
    if (!asset) throw new Error("Antigravity does not support this platform and architecture.");
    const directory = path.join(this.directory, asset.sha256);
    const record = await fs.readFile(path.join(directory, "complete.json"), "utf8").catch(() => "");
    if (record !== JSON.stringify({ sha256: asset.sha256, version: asset.version }))
      throw new Error("Install Antigravity in Settings before using it.");
    for (const file of [asset.executable, asset.harness]) {
      const stat = await fs.lstat(path.join(directory, file.name));
      if (!stat.isFile() || stat.size !== file.bytes)
        throw new Error(
          "Antigravity installation is incomplete. Inspect the managed release directory before reinstalling.",
        );
    }
    return {
      executablePath: path.join(directory, asset.executable.name),
      harnessPath: path.join(directory, asset.harness.name),
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
  private async installRelease(signal?: AbortSignal): Promise<AntigravityExecutable> {
    const asset = this.asset;
    if (!asset) throw new Error("Antigravity does not support this platform and architecture.");
    try {
      return await this.resolve();
    } catch {
      // A complete release is immutable. Do not overwrite an invalid existing directory.
      const destination = path.join(this.directory, asset.sha256);
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
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const disk = await fs.statfs(this.directory);
    const requiredBytes =
      asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + 64 * 1024 * 1024;
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
      const hash = createHash("sha256");
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
      if (bytes !== asset.archiveBytes || hash.digest("hex") !== asset.sha256)
        throw new Error("Antigravity archive integrity check failed.");
      await extractPinnedExecutables(archive, staging, asset, combined);
      await fs.unlink(archive);
      const record = await fs.open(path.join(staging, "complete.json"), "wx", 0o600);
      try {
        await record.writeFile(JSON.stringify({ sha256: asset.sha256, version: asset.version }));
        await record.sync();
      } finally {
        await record.close();
      }
      combined.throwIfAborted();
      const destination = path.join(this.directory, asset.sha256);
      try {
        await fs.rename(staging, destination);
      } catch (error) {
        // Another installer may have published first; never replace its complete release.
        try {
          return await this.resolve();
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
      return await this.resolve();
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
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
    [asset.executable, asset.harness].map((entry) => [entry.name, entry.bytes]),
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
