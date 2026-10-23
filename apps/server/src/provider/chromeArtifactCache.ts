import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "./chromeNativeHost";
import { readChromeArtifact } from "./chromeNativeHostStorage";

export interface ChromeArtifactCacheIo {
  /** lstat fingerprint; null means positively absent. */
  readonly fingerprint: (path: string) => Promise<string | null>;
  readonly read: (path: string) => Promise<string | null>;
  readonly hash: (bytes: string) => string;
  /** Optional invalidation; stat checks remain because watchers can drop events. */
  readonly watch?: (directory: string, changed: () => void) => (() => void) | undefined;
}

const statFingerprint = async (path: string): Promise<string | null> => {
  try {
    const info = await lstat(path);
    return `${info.ino}:${info.size}:${info.mtimeMs}:${info.mode}:${info.isSymbolicLink() ? "l" : "f"}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const defaultChromeArtifactCacheIo: ChromeArtifactCacheIo = {
  fingerprint: statFingerprint,
  read: async (path) => (await readChromeArtifact(path)).bytes,
  hash: sha256,
  watch: (directory, changed) => {
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(directory, { persistent: false }, changed);
      watcher.on("error", changed);
    } catch {
      return undefined;
    }
    return () => watcher?.close();
  },
};

interface Entry {
  key: string;
  bytes: string | null;
  sha256: string | null;
}

/**
 * Stat-keyed cache of native-host artifacts for per-call admission. A fingerprint covers
 * the file (inode, size, mtime, mode, kind or absence) and its parent directory's
 * identity, so an unchanged invocation reads and hashes nothing.
 */
export class ChromeArtifactCache {
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private readonly watchers = new Map<string, () => void>();
  /** Counters for the hot-path budget tests. */
  reads = 0;
  hashes = 0;
  constructor(private readonly io: ChromeArtifactCacheIo = defaultChromeArtifactCacheIo) {}

  private watchDirectory(path: string): void {
    const directory = dirname(path);
    if (this.watchers.has(directory) || !this.io.watch) return;
    const stop = this.io.watch(directory, () => {
      for (const location of this.entries.keys())
        if (dirname(location) === directory) this.dirty.add(location);
    });
    if (stop) this.watchers.set(directory, stop);
  }

  async read(path: string): Promise<{ bytes: string | null; sha256: string | null }> {
    const [file, parent] = await Promise.all([
      this.io.fingerprint(path),
      this.io.fingerprint(dirname(path)).catch(() => "unreadable"),
    ]);
    const key = `${file ?? "absent"}|${parent ?? "absent"}`;
    const cached = this.entries.get(path);
    if (cached && cached.key === key && !this.dirty.has(path))
      return { bytes: cached.bytes, sha256: cached.sha256 };
    this.dirty.delete(path);
    let bytes: string | null = null;
    if (file !== null) {
      this.reads += 1;
      bytes = await this.io.read(path);
    }
    let digest: string | null = null;
    if (bytes !== null) {
      this.hashes += 1;
      digest = this.io.hash(bytes);
    }
    this.entries.set(path, { key, bytes, sha256: digest });
    this.watchDirectory(path);
    return { bytes, sha256: digest };
  }

  invalidate(): void {
    for (const location of this.entries.keys()) this.dirty.add(location);
  }

  dispose(): void {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    this.entries.clear();
  }
}
