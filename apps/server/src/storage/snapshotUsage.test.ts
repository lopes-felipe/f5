import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { allocatedBytes } from "./diskUsage.ts";
import {
  estimateUnsharedBytes,
  measureSnapshotRemoval,
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

  it("keeps the comparisons it finished when the time budget runs out", async () => {
    const data = content(50);
    const dir = makeStateDir([data, data, data, data], data);
    const compared: string[] = [];
    const slow = async (older: string) => {
      compared.push(Path.basename(Path.dirname(older)));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return CHUNK;
    };
    // Time for the first comparison only.
    const first = await measureSnapshotUsage({ ...dir, budgetMs: 250, compare: slow });
    expect(compared).toEqual([Path.basename(dir.snapshots[0]!)]);
    expect(first.entries.map((entry) => entry.path)).toEqual([dir.snapshots[0]]);
    expect(first.failed).toEqual(dir.snapshots.slice(1));
    expect(first.cache).toHaveLength(1);

    // The next scan starts from the cached pair instead of from the beginning.
    compared.length = 0;
    const second = await measureSnapshotUsage({
      ...dir,
      cache: first.cache,
      budgetMs: 250,
      compare: slow,
    });
    expect(compared).toEqual([Path.basename(dir.snapshots[1]!)]);
    expect(second.entries.map((entry) => entry.path)).toEqual(dir.snapshots.slice(0, 2));
    expect(second.cache).toHaveLength(2);
  });

  it("stops a comparison that is still reading when the deadline passes", async () => {
    const data = content(200);
    const { olderFile, newerFile } = writePair(data, data);
    await expect(
      estimateUnsharedBytes(olderFile, newerFile, { chunkBytes: CHUNK, deadlineAt: Date.now() }),
    ).rejects.toThrow("ran out of time");
  });
});

describe("estimateUnsharedBytes against several files", () => {
  it("counts only the chunks that none of the other files holds", async () => {
    const root = makeRoot();
    const base = content(100);
    const write = (name: string, data: Buffer) => {
      const path = Path.join(root, name);
      FS.writeFileSync(path, data);
      return path;
    };
    const file = write("file", base);
    // Chunks 1 and 2 are gone from the first file, 2 and 3 from the second.
    const first = write("first", rewriteChunks(base, [1, 2]));
    const second = write("second", rewriteChunks(base, [2, 3]));
    expect(await estimateUnsharedBytes(file, [first, second], { chunkBytes: CHUNK })).toBe(CHUNK);
    expect(await estimateUnsharedBytes(file, [first], { chunkBytes: CHUNK })).toBe(2 * CHUNK);
    expect(await estimateUnsharedBytes(file, [], { chunkBytes: CHUNK })).toBe(100 * CHUNK);
  });
});

describe("measureSnapshotRemoval", () => {
  const T0 = 1_790_000_000_000;

  /** Snapshots A, B, C (oldest first) and a live database, as chunk rewrites of one base. */
  function makeChain() {
    const root = makeRoot();
    const a = content(100);
    // Chunk 5 changes between B and C: A and B share it, C does not have it.
    // Chunk 9 changes between A and B, and chunk 20 after C.
    const b = rewriteChunks(a, [9]);
    const c = rewriteChunks(b, [5]);
    const live = rewriteChunks(c, [20]);
    const snapshots = [a, b, c].map((data, index) => {
      const path = Path.join(root, "backups", `snapshot-${T0 + index * 3_600_000}`);
      FS.mkdirSync(path, { recursive: true });
      FS.writeFileSync(Path.join(path, "state.sqlite"), data);
      return path;
    });
    const liveDbPath = Path.join(root, "state.sqlite");
    FS.writeFileSync(liveDbPath, live);
    const removal = (snapshotPath: string) =>
      measureSnapshotRemoval({ snapshotPath, liveDbPath, chunkBytes: CHUNK });
    return { backupsDir: Path.join(root, "backups"), liveDbPath, snapshots, removal };
  }

  it("frees nothing for a middle snapshot whose changed block an older snapshot still holds", async () => {
    const chain = makeChain();
    // The scan charges B one chunk (chunk 5, which C lacks), but A still holds it.
    const usage = await measureSnapshotUsage({ ...chain, chunkBytes: CHUNK });
    const allocated = allocatedBytes(FS.statSync(Path.join(chain.snapshots[1]!, "state.sqlite")));
    expect(usage.entries[1]).toEqual({ path: chain.snapshots[1], sharedBytes: allocated - CHUNK });
    expect(await chain.removal(chain.snapshots[1]!)).toBe(0);
  });

  it("adds up to the same total whichever order snapshots are removed in", async () => {
    // A holds chunk 9 alone; A and B hold chunk 5 between them.
    const oldestFirst = makeChain();
    const freedOldestFirst: number[] = [];
    for (const snapshot of oldestFirst.snapshots.slice(0, 2)) {
      freedOldestFirst.push((await oldestFirst.removal(snapshot))!);
      FS.rmSync(snapshot, { recursive: true });
    }
    expect(freedOldestFirst).toEqual([CHUNK, CHUNK]);

    const middleFirst = makeChain();
    const freedMiddleFirst: number[] = [];
    for (const snapshot of [middleFirst.snapshots[1]!, middleFirst.snapshots[0]!]) {
      freedMiddleFirst.push((await middleFirst.removal(snapshot))!);
      FS.rmSync(snapshot, { recursive: true });
    }
    expect(freedMiddleFirst).toEqual([0, 2 * CHUNK]);
  });

  it("measures the newest snapshot against the live database", async () => {
    const chain = makeChain();
    // C differs from B in chunk 5 and from the live database in chunk 20.
    expect(await chain.removal(chain.snapshots[2]!)).toBe(0);
    FS.rmSync(chain.snapshots[1]!, { recursive: true });
    FS.rmSync(chain.snapshots[0]!, { recursive: true });
    expect(await chain.removal(chain.snapshots[2]!)).toBe(CHUNK);
  });

  it("returns null for a directory that is not a listed snapshot", async () => {
    const chain = makeChain();
    expect(await chain.removal(Path.join(chain.backupsDir, "snapshot-1790009999999"))).toBeNull();
  });
});

describe("snapshot usage cache file", () => {
  it("round-trips entries and treats a missing or foreign file as empty", async () => {
    const root = makeRoot();
    const path = Path.join(root, "snapshot-usage-cache.json");
    expect(await readSnapshotUsageCache(path)).toEqual([]);
    const identity = { dev: 1, ino: "2", size: 3, mtimeMs: 4, mode: 0o100644 };
    const entries = [
      {
        older: "/a/state.sqlite",
        olderIdentity: identity,
        newer: "/b/state.sqlite",
        newerIdentity: { ...identity, ino: "5" },
        unsharedBytes: 4096,
      },
    ];
    await writeSnapshotUsageCache(path, entries);
    expect(await readSnapshotUsageCache(path)).toEqual(entries);
    expect(FS.readdirSync(root)).toEqual(["snapshot-usage-cache.json"]);
    // A cache written when inodes were numbers: kept when the number is
    // exact, dropped when it may have been rounded.
    const numbered = (older: number, newer: number) => ({
      ...entries[0],
      olderIdentity: { ...identity, ino: older },
      newerIdentity: { ...identity, ino: newer },
    });
    FS.writeFileSync(
      path,
      JSON.stringify({ version: 1, entries: [numbered(2, 5), numbered(2, 2 ** 53)] }),
    );
    expect(await readSnapshotUsageCache(path)).toEqual(entries);
    FS.writeFileSync(path, JSON.stringify({ version: 99, entries }));
    expect(await readSnapshotUsageCache(path)).toEqual([]);
    FS.writeFileSync(path, "not json");
    expect(await readSnapshotUsageCache(path)).toEqual([]);
  });
});
