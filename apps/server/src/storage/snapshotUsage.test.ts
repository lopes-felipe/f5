import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { allocatedBytes } from "./diskUsage.ts";
import {
  estimateUnsharedBytes,
  measureSnapshotUsage,
  readSnapshotUsageCache,
  snapshotChunkBytes,
  writeSnapshotUsageCache,
} from "./snapshotUsage.ts";

const CHUNK = 64;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-snapshot-usage-"));
  roots.push(root);
  return root;
}

/** `chunks` chunks of deterministic, pairwise different content. */
function content(chunks: number, chunkBytes = CHUNK) {
  const buffer = Buffer.alloc(chunks * chunkBytes);
  for (let index = 0; index < chunks; index++) buffer.writeUInt32LE(index + 1, index * chunkBytes);
  return buffer;
}

function rewriteChunks(buffer: Buffer, indexes: ReadonlyArray<number>, chunkBytes = CHUNK) {
  const changed = Buffer.from(buffer);
  for (const index of indexes) changed.writeUInt32LE(0xffff_ffff, index * chunkBytes + 4);
  return changed;
}

function writePair(older: Buffer, newer: Buffer) {
  const root = makeRoot();
  const olderFile = Path.join(root, "older");
  const newerFile = Path.join(root, "newer");
  FS.writeFileSync(olderFile, older);
  FS.writeFileSync(newerFile, newer);
  return { olderFile, newerFile };
}

describe("estimateUnsharedBytes", () => {
  it("reports nothing for identical files", async () => {
    const data = content(100);
    const { olderFile, newerFile } = writePair(data, data);
    expect(await estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK })).toBe(0);
  });

  it("counts each rewritten chunk once when the file is compared in full", async () => {
    const data = content(100);
    const { olderFile, newerFile } = writePair(data, rewriteChunks(data, [0, 17, 18, 99]));
    expect(await estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK })).toBe(
      4 * CHUNK,
    );
  });

  it("counts the part of the older file that lies past the end of the newer one", async () => {
    const data = content(100);
    // The newer file ends mid-chunk: that chunk and the 39 after it have no counterpart.
    const { olderFile, newerFile } = writePair(data, data.subarray(0, 60 * CHUNK + 10));
    expect(await estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK })).toBe(
      40 * CHUNK,
    );
  });

  it("ignores data the newer file gained", async () => {
    const data = content(100);
    const { olderFile, newerFile } = writePair(data, Buffer.concat([data, content(50)]));
    expect(await estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK })).toBe(0);
  });

  it("counts a short last chunk at its own length", async () => {
    const data = content(10).subarray(0, 9 * CHUNK + 5);
    const changed = Buffer.from(data);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 0xff, changed.length - 1);
    const { olderFile, newerFile } = writePair(data, changed);
    expect(await estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK })).toBe(5);
  });

  it("estimates a large file from a sample, and gives the same answer every time", async () => {
    const chunks = 20_000;
    const data = content(chunks);
    // Every tenth chunk, plus one solid run: 2000 + 900 of 20000 chunks.
    const rewritten = [
      ...Array.from({ length: 2000 }, (_, index) => index * 10),
      ...Array.from({ length: 1000 }, (_, index) => 5001 + index).filter(
        (index) => index % 10 !== 0,
      ),
    ];
    const { olderFile, newerFile } = writePair(data, rewriteChunks(data, rewritten));
    const options = { chunkBytes: CHUNK, sampleChunks: 4000 };
    const estimate = await estimateUnsharedBytes(olderFile, newerFile, options);
    const actual = rewritten.length * CHUNK;
    expect(Math.abs(estimate - actual) / actual).toBeLessThan(0.15);
    expect(await estimateUnsharedBytes(olderFile, newerFile, options)).toBe(estimate);
  });

  it("uses the 16 KiB copy-on-write unit of Apple Silicon and 4 KiB elsewhere", () => {
    expect(snapshotChunkBytes("darwin", "arm64")).toBe(16 * 1024);
    expect(snapshotChunkBytes("darwin", "x64")).toBe(4 * 1024);
    expect(snapshotChunkBytes("linux", "arm64")).toBe(4 * 1024);
  });
});

describe("measureSnapshotUsage", () => {
  const T0 = 1_790_000_000_000;
  const HOUR = 3_600_000;

  /** A state dir with a live database and one snapshot per entry of `versions`, oldest first. */
  function makeStateDir(versions: ReadonlyArray<Buffer>, live: Buffer | null) {
    const root = makeRoot();
    const backupsDir = Path.join(root, "backups");
    const snapshots = versions.map((data, index) => {
      const path = Path.join(backupsDir, `snapshot-${T0 + index * HOUR}`);
      FS.mkdirSync(path, { recursive: true });
      FS.writeFileSync(Path.join(path, "state.sqlite"), data);
      FS.writeFileSync(Path.join(path, "state.sqlite-wal"), "write-ahead log");
      return path;
    });
    const liveDbPath = Path.join(root, "state.sqlite");
    if (live) FS.writeFileSync(liveDbPath, live);
    return { backupsDir, liveDbPath, snapshots };
  }

  const allocated = (snapshot: string) =>
    allocatedBytes(FS.statSync(Path.join(snapshot, "state.sqlite")));

  it("charges each snapshot what the next newer copy no longer shares", async () => {
    const first = content(200);
    const second = rewriteChunks(first, [1, 2, 3]);
    const third = rewriteChunks(second, [10]);
    const live = rewriteChunks(third, [20, 21]);
    const dir = makeStateDir([first, second, third], live);
    const result = await measureSnapshotUsage({ ...dir, chunkBytes: CHUNK });
    expect(result.failed).toEqual([]);
    expect(result.entries).toEqual([
      { path: dir.snapshots[0], sharedBytes: allocated(dir.snapshots[0]!) - 3 * CHUNK },
      { path: dir.snapshots[1], sharedBytes: allocated(dir.snapshots[1]!) - 1 * CHUNK },
      { path: dir.snapshots[2], sharedBytes: allocated(dir.snapshots[2]!) - 2 * CHUNK },
    ]);
    // Only snapshot-to-snapshot results are worth keeping: the live file keeps changing.
    expect(result.cache.map((entry) => [entry.older, entry.newer, entry.unsharedBytes])).toEqual([
      [
        Path.join(dir.snapshots[0]!, "state.sqlite"),
        Path.join(dir.snapshots[1]!, "state.sqlite"),
        3 * CHUNK,
      ],
      [
        Path.join(dir.snapshots[1]!, "state.sqlite"),
        Path.join(dir.snapshots[2]!, "state.sqlite"),
        1 * CHUNK,
      ],
    ]);
  });

  it("reuses cached snapshot pairs and always compares the newest with the live database", async () => {
    const data = content(50);
    const dir = makeStateDir([data, data, data], data);
    const first = await measureSnapshotUsage({ ...dir, chunkBytes: CHUNK });
    const compared: string[] = [];
    const second = await measureSnapshotUsage({
      ...dir,
      cache: first.cache,
      compare: async (older) => {
        compared.push(older);
        return 0;
      },
    });
    expect(compared).toEqual([Path.join(dir.snapshots[2]!, "state.sqlite")]);
    expect(second.entries).toEqual(first.entries);
    expect(second.cache).toEqual(first.cache);
  });

  it("compares again when a cached file is no longer the same file", async () => {
    const data = content(50);
    const dir = makeStateDir([data, data], data);
    const first = await measureSnapshotUsage({ ...dir, chunkBytes: CHUNK });
    // Same path, different file: a snapshot directory was replaced.
    const replaced = Path.join(dir.snapshots[1]!, "state.sqlite");
    FS.rmSync(replaced);
    FS.writeFileSync(replaced, rewriteChunks(data, [4, 5]));
    FS.utimesSync(replaced, new Date(T0), new Date(T0));
    const second = await measureSnapshotUsage({ ...dir, cache: first.cache, chunkBytes: CHUNK });
    expect(second.cache.map((entry) => entry.unsharedBytes)).toEqual([2 * CHUNK]);
  });

  it("treats a snapshot with nothing newer to share with as entirely its own", async () => {
    const dir = makeStateDir([content(50)], null);
    const result = await measureSnapshotUsage({ ...dir, chunkBytes: CHUNK });
    expect(result.entries).toEqual([
      {
        path: dir.snapshots[0],
        sharedBytes: Math.max(0, allocated(dir.snapshots[0]!) - 50 * CHUNK),
      },
    ]);
  });

  it("reports a snapshot it could not compare instead of guessing", async () => {
    const data = content(50);
    const dir = makeStateDir([data, data], data);
    const result = await measureSnapshotUsage({
      ...dir,
      compare: async (older) => {
        if (older.startsWith(dir.snapshots[0]!)) throw new Error("unreadable");
        return 0;
      },
    });
    expect(result.failed).toEqual([dir.snapshots[0]]);
    expect(result.entries.map((entry) => entry.path)).toEqual([dir.snapshots[1]]);
  });

  it("ignores snapshot directories without a database", async () => {
    const dir = makeStateDir([content(10)], content(10));
    FS.mkdirSync(Path.join(dir.backupsDir, `snapshot-${T0 - HOUR}`));
    const result = await measureSnapshotUsage({ ...dir, chunkBytes: CHUNK });
    expect(result.entries.map((entry) => entry.path)).toEqual(dir.snapshots);
  });
});

describe("snapshot usage cache file", () => {
  it("round-trips entries and treats a missing or foreign file as empty", async () => {
    const root = makeRoot();
    const path = Path.join(root, "snapshot-usage-cache.json");
    expect(await readSnapshotUsageCache(path)).toEqual([]);
    const identity = { dev: 1, ino: 2, size: 3, mtimeMs: 4, mode: 0o100644 };
    const entries = [
      {
        older: "/a/state.sqlite",
        olderIdentity: identity,
        newer: "/b/state.sqlite",
        newerIdentity: { ...identity, ino: 5 },
        unsharedBytes: 4096,
      },
    ];
    await writeSnapshotUsageCache(path, entries);
    expect(await readSnapshotUsageCache(path)).toEqual(entries);
    expect(FS.readdirSync(root)).toEqual(["snapshot-usage-cache.json"]);
    FS.writeFileSync(path, JSON.stringify({ version: 99, entries }));
    expect(await readSnapshotUsageCache(path)).toEqual([]);
    FS.writeFileSync(path, "not json");
    expect(await readSnapshotUsageCache(path)).toEqual([]);
  });
});
