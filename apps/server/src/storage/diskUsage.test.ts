import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  allocatedBytes,
  fileIdentity,
  sameFileIdentity,
  normalizeStorageStat,
  readStorageStat,
  enumerateFiles,
  measureTree,
  recursiveSize,
  type DiskUsageFs,
} from "./diskUsage.ts";

const roots: string[] = [];
test("uses apparent bytes when Windows does not supply allocated block counts", () => {
  expect(allocatedBytes({ blocks: 0, size: 1024 }, "win32")).toBe(1024);
  expect(allocatedBytes({ blocks: 0, size: 1024 }, "linux")).toBe(0);
  expect(allocatedBytes({ blocks: 8, size: 1024 }, "darwin")).toBe(4096);
});
async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-disk-usage-"));
  roots.push(root);
  return root;
}
test("preserves fractional timestamp identity across Node and Bun maintenance children", async () => {
  const root = await fixture();
  const path = Path.join(root, "precise");
  await FS.writeFile(path, "cache");
  const stat = await FS.lstat(path, { bigint: true });
  // Reproduce Bun 1.3.9's numeric truncation while retaining the exact ns value.
  const precise = normalizeStorageStat(
    Object.assign(await FS.lstat(path, { bigint: true }), {
      mtimeMs: 1_793_302_815_000n,
      mtimeNs: 1_793_302_815_000_700_221n,
    }),
  );
  expect(precise.mtimeMs).toBe(1_793_302_815_000.7002);
  expect(precise.isFile()).toBe(true);
  const numeric = await FS.lstat(path);
  expect(fileIdentity(normalizeStorageStat(stat))).toEqual({
    dev: numeric.dev,
    ino: String(stat.ino),
    size: numeric.size,
    mtimeMs: numeric.mtimeMs,
    mode: numeric.mode,
  });
  expect(
    sameFileIdentity(fileIdentity(precise), {
      ...fileIdentity(precise),
      mtimeMs: 1_793_302_815_000.7004,
    }),
  ).toBe(false);
});
test("tells apart two inodes that round to the same number", async () => {
  const root = await fixture();
  // NTFS file ids look like this: a reuse count in the top 16 bits puts them
  // above 2^53, where neighbouring records share one double.
  const first = (64n << 48n) | 1_000n;
  const second = first + 1n;
  expect(Number(first)).toBe(Number(second));
  const withInode = async (ino: bigint) =>
    normalizeStorageStat(Object.assign(await FS.lstat(root, { bigint: true }), { ino }));
  const [a, b] = await Promise.all([withInode(first), withInode(second)]);
  expect(a.ino).toBe(b.ino);
  expect(fileIdentity(a).ino).toBe(String(first));
  expect(sameFileIdentity(fileIdentity(a), fileIdentity(b))).toBe(false);
  expect(sameFileIdentity(fileIdentity(a), fileIdentity(await withInode(first)))).toBe(true);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => FS.rm(path, { recursive: true, force: true })));
});
test("concurrent wide walks share at most 16 filesystem calls", async () => {
  const root = await fixture();
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      FS.writeFile(Path.join(root, `${index}.txt`), "data"),
    ),
  );
  let active = 0,
    maximum = 0;
  const tracked = async <A>(call: () => Promise<A>) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await call();
    } finally {
      active--;
    }
  };
  const fs: DiskUsageFs = {
    lstat: (path) => tracked(() => readStorageStat(path)),
    readdir: (path, options) => tracked(() => FS.readdir(path, options)),
  };
  const [first, second] = await Promise.all([
    recursiveSize(root, { fs }),
    recursiveSize(root, { fs }),
  ]);
  expect(first.fileCount).toBe(100);
  expect(second.fileCount).toBe(100);
  expect(maximum).toBe(16);
});
test("inspects a cache fixture with more than 100,000 files using bounded traversal", async () => {
  const root = await fixture();
  const sample = Path.join(root, "sample");
  await FS.writeFile(sample, "cached data");
  const [directoryStat, fileStat] = await Promise.all([
    readStorageStat(root),
    readStorageStat(sample),
  ]);
  const count = 100_001;
  const fs: DiskUsageFs = {
    lstat: async (path) => (path === root ? directoryStat : fileStat),
    readdir: async () =>
      Array.from({ length: count }, (_, index) => ({
        name: "package-" + index,
      })) as Awaited<ReturnType<DiskUsageFs["readdir"]>>,
  };
  const result = await enumerateFiles(root, { fs });
  expect(result.errors).toEqual([]);
  expect(result.files).toHaveLength(count);
}, 30_000);
test("attributes nested checkpoints and counts hard links once without following symlinks", async () => {
  const root = await fixture(),
    child = Path.join(root, "child");
  await FS.mkdir(child);
  const file = Path.join(child, "file");
  await FS.writeFile(file, "content");
  await FS.link(file, Path.join(child, "hardlink"));
  await FS.symlink(root, Path.join(child, "loop"));
  const measurement = await measureTree([root, child], { checkpoints: [root, child] });
  const expected = (
    await Promise.all([root, child, file, Path.join(child, "loop")].map((path) => FS.lstat(path)))
  ).reduce((sum, stat) => sum + allocatedBytes(stat), 0);
  expect(measurement.totalBytes).toBe(expected);
  expect(measurement.entries).toBe(5);
  expect(measurement.byCheckpoint.get(root)?.bytes).toBe(expected);
  expect(measurement.byCheckpoint.get(child)?.bytes).toBe(
    expected - allocatedBytes(await FS.lstat(root)),
  );
});
test("resets the depth limit at the innermost checkpoint", async () => {
  const root = await fixture(),
    checkpoint = Path.join(root, "child"),
    file = Path.join(checkpoint, "leaf");
  await FS.mkdir(checkpoint);
  await FS.writeFile(file, "content");
  const measurement = await measureTree([root], { checkpoints: [checkpoint], maxDepth: 1 });
  expect(measurement.entries).toBe(3);
  expect(measurement.warnings).toEqual([]);
});
test("only ENOENT means empty; unreadable roots retain a warning", async () => {
  const root = await fixture();
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const fs: DiskUsageFs = {
    lstat: async () => {
      throw error;
    },
    readdir: FS.readdir,
  };
  expect((await recursiveSize(root, { fs })).errors).toHaveLength(1);
  expect((await recursiveSize(Path.join(root, "absent"))).errors).toEqual([]);
});
test("abort returns promptly while a syscall is blocked and schedules no more calls", async () => {
  const root = await fixture(),
    controller = new AbortController();
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fs: DiskUsageFs = {
    lstat: async (path) => {
      calls++;
      entered();
      await blocked;
      return readStorageStat(path);
    },
    readdir: FS.readdir,
  };
  const result = recursiveSize(root, { signal: controller.signal, fs });
  await started;
  controller.abort();
  await expect(result).rejects.toThrow();
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toBe(1);
});
test("enumeration retains review identities and never follows symlinks", async () => {
  const root = await fixture();
  await FS.writeFile(Path.join(root, "file"), "content");
  await FS.symlink(root, Path.join(root, "link"));
  const listing = await enumerateFiles(root);
  expect(listing.files).toHaveLength(1);
  expect(listing.files[0]?.identity?.ino).toMatch(/^[1-9]\d*$/);
});
