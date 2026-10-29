import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  allocatedBytes,
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
    lstat: (path) => tracked(() => FS.lstat(path)),
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
  const [directoryStat, fileStat] = await Promise.all([FS.lstat(root), FS.lstat(sample)]);
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
      return FS.lstat(path);
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
  expect(listing.files[0]?.identity?.ino).toBeGreaterThan(0);
});
