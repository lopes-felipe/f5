/**
 * snapshotUsage - How much disk space the automatic database snapshots hold.
 *
 * A snapshot is a copy-on-write clone of `state.sqlite` (see
 * `databaseSnapshots.ts`). `stat` reports every clone at its full size, so
 * nine snapshots of a 6 GB database read as 57 GB while holding about 2.5 GB
 * that the live database does not. Node cannot ask the filesystem which blocks
 * are shared, so this estimates it from content: a block that still reads the
 * same in the next newer copy has not been rewritten since the clone, and is
 * therefore still shared with it.
 *
 * Each snapshot is compared with the next newer snapshot, and the newest with
 * the live database. Whatever differs is charged to the older file. Blocks
 * are replaced one way only, so a block shared with any newer copy is also
 * shared with the next one; the per-snapshot figures therefore add up to the
 * cost of the whole set, and the figures of the oldest N add up to what
 * deleting those N frees.
 *
 * The comparison works on chunks of the filesystem's copy-on-write unit and
 * samples large files, so the result is an estimate. It cannot see sharing
 * lost without a content change, such as a snapshot restored by a plain copy.
 *
 * @module snapshotUsage
 */
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import { listDatabaseSnapshots } from "../persistence/databaseFiles.ts";
import {
  allocatedBytes,
  fileIdentity,
  sameFileIdentity,
  storageLstat,
  type FileIdentity,
} from "./diskUsage.ts";

/** Chunks compared per file pair; smaller files are compared in full. */
export const SNAPSHOT_SAMPLE_CHUNKS = 8192;
const COMPARISON_READERS = 16;

/**
 * The unit in which a clone stops sharing data. APFS copies whole VM pages,
 * which are 16 KiB on Apple Silicon: one rewritten 4 KiB SQLite page costs
 * 16 KiB there.
 */
export function snapshotChunkBytes(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): number {
  return platform === "darwin" && arch === "arm64" ? 16 * 1024 : 4 * 1024;
}

export interface SnapshotComparisonOptions {
  readonly chunkBytes?: number;
  readonly sampleChunks?: number;
}

/** A snapshot-to-snapshot result. Both files are immutable, so it stays valid while they exist. */
export interface SnapshotUsageCacheEntry {
  readonly older: string;
  readonly olderIdentity: FileIdentity;
  readonly newer: string;
  readonly newerIdentity: FileIdentity;
  readonly unsharedBytes: number;
}

export interface SnapshotUsageEntry {
  /** The snapshot directory. */
  readonly path: string;
  /** Bytes of its `state.sqlite` that the next newer copy still shares. */
  readonly sharedBytes: number;
}

export interface SnapshotUsageResult {
  readonly entries: ReadonlyArray<SnapshotUsageEntry>;
  /** Snapshot directories that could not be compared. */
  readonly failed: ReadonlyArray<string>;
  /** Every snapshot-to-snapshot result that is still current for this directory. */
  readonly cache: ReadonlyArray<SnapshotUsageCacheEntry>;
}

/** mulberry32: a fixed sequence, so the same files always give the same estimate. */
function sampleSequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One chunk index from each of `samples` equal strata of `[0, chunks)`. */
function sampledChunkIndexes(chunks: number, samples: number): number[] {
  const next = sampleSequence(0x5eed_f5);
  return Array.from({ length: samples }, (_, stratum) => {
    const low = Math.floor((stratum * chunks) / samples);
    const high = Math.floor(((stratum + 1) * chunks) / samples);
    return low + Math.floor(next() * (high - low));
  });
}

async function readChunk(
  file: FS.FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/**
 * Estimated bytes of `olderFile` whose content differs from `newerFile` at the
 * same offset, in whole chunks. A chunk that reaches past the end of the newer
 * file counts as different.
 */
export async function estimateUnsharedBytes(
  olderFile: string,
  newerFile: string,
  options: SnapshotComparisonOptions = {},
): Promise<number> {
  const chunkBytes = options.chunkBytes ?? snapshotChunkBytes();
  const sampleChunks = options.sampleChunks ?? SNAPSHOT_SAMPLE_CHUNKS;
  const older = await FS.open(olderFile, "r");
  try {
    const newer = await FS.open(newerFile, "r");
    try {
      const olderSize = (await older.stat()).size;
      const newerSize = (await newer.stat()).size;
      const chunks = Math.ceil(olderSize / chunkBytes);
      if (chunks === 0) return 0;
      const sampled = chunks > sampleChunks;
      const indexes = sampled
        ? sampledChunkIndexes(chunks, sampleChunks)
        : Array.from({ length: chunks }, (_, index) => index);
      let differingChunks = 0;
      let differingBytes = 0;
      let cursor = 0;
      // Scattered reads are far faster with several in flight than one at a time.
      const reader = async () => {
        const left = Buffer.allocUnsafe(chunkBytes);
        const right = Buffer.allocUnsafe(chunkBytes);
        while (cursor < indexes.length) {
          const position = indexes[cursor++]! * chunkBytes;
          const length = Math.min(chunkBytes, olderSize - position);
          let same = position + length <= newerSize;
          if (same) {
            const [leftRead, rightRead] = await Promise.all([
              readChunk(older, left, length, position),
              readChunk(newer, right, length, position),
            ]);
            same =
              leftRead === length &&
              rightRead === length &&
              left.subarray(0, length).equals(right.subarray(0, length));
          }
          if (!same) {
            differingChunks += 1;
            differingBytes += length;
          }
        }
      };
      await Promise.all(Array.from({ length: COMPARISON_READERS }, reader));
      return sampled ? Math.round((differingChunks / indexes.length) * olderSize) : differingBytes;
    } finally {
      await newer.close();
    }
  } finally {
    await older.close();
  }
}

async function identityOf(path: string): Promise<FileIdentity | null> {
  try {
    return fileIdentity(await storageLstat(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Compares every snapshot in `backupsDir` with its successor. Results for
 * snapshot pairs found in `cache` are reused; the newest snapshot is always
 * compared with the live database again, because that file keeps changing.
 */
export async function measureSnapshotUsage(
  input: {
    readonly backupsDir: string;
    readonly liveDbPath: string;
    readonly cache?: ReadonlyArray<SnapshotUsageCacheEntry>;
    /** Replaces the file comparison in tests. */
    readonly compare?: (olderFile: string, newerFile: string) => Promise<number>;
  } & SnapshotComparisonOptions,
): Promise<SnapshotUsageResult> {
  const compare =
    input.compare ??
    ((olderFile: string, newerFile: string) => estimateUnsharedBytes(olderFile, newerFile, input));
  const oldestFirst = listDatabaseSnapshots(input.backupsDir).toReversed();
  const entries: SnapshotUsageEntry[] = [];
  const failed: string[] = [];
  const cache: SnapshotUsageCacheEntry[] = [];
  for (const [index, snapshot] of oldestFirst.entries()) {
    try {
      const older = Path.join(snapshot.path, "state.sqlite");
      const successor = oldestFirst[index + 1];
      const newer = successor ? Path.join(successor.path, "state.sqlite") : input.liveDbPath;
      const olderStat = await storageLstat(older);
      const olderIdentity = fileIdentity(olderStat);
      const newerIdentity = await identityOf(newer);
      let unsharedBytes: number;
      if (newerIdentity === null) {
        // Nothing newer to share with: the whole file is this snapshot's own.
        unsharedBytes = olderStat.size;
      } else {
        const known = successor
          ? input.cache?.find(
              (entry) =>
                entry.older === older &&
                entry.newer === newer &&
                sameFileIdentity(entry.olderIdentity, olderIdentity) &&
                sameFileIdentity(entry.newerIdentity, newerIdentity),
            )
          : undefined;
        unsharedBytes = known?.unsharedBytes ?? (await compare(older, newer));
        if (successor) cache.push({ older, olderIdentity, newer, newerIdentity, unsharedBytes });
      }
      entries.push({
        path: snapshot.path,
        sharedBytes: Math.max(0, allocatedBytes(olderStat) - unsharedBytes),
      });
    } catch {
      failed.push(snapshot.path);
    }
  }
  return { entries, failed, cache };
}

const CACHE_VERSION = 1;

function isIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return ["dev", "ino", "size", "mtimeMs", "mode"].every(
    (key) => typeof identity[key] === "number",
  );
}

function isCacheEntry(value: unknown): value is SnapshotUsageCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.older === "string" &&
    typeof entry.newer === "string" &&
    typeof entry.unsharedBytes === "number" &&
    entry.unsharedBytes >= 0 &&
    isIdentity(entry.olderIdentity) &&
    isIdentity(entry.newerIdentity)
  );
}

/** A missing or unreadable cache only costs a recomparison. */
export async function readSnapshotUsageCache(path: string): Promise<SnapshotUsageCacheEntry[]> {
  try {
    const parsed = JSON.parse(await FS.readFile(path, "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isCacheEntry);
  } catch {
    return [];
  }
}

export async function writeSnapshotUsageCache(
  path: string,
  entries: ReadonlyArray<SnapshotUsageCacheEntry>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await FS.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, entries }), {
      mode: 0o600,
    });
    await FS.rename(temporary, path);
  } finally {
    await FS.rm(temporary, { force: true });
  }
}
