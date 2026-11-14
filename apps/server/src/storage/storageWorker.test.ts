import { afterEach, expect, it } from "vitest";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import {
  executeStorageTask as executeRealStorageTask,
  runStorageTask,
  type StorageFileInspection,
  type StorageMeasurement,
} from "./storageWorker.ts";
import type { StorageWorkerTask } from "./storageWorker.ts";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { runProcess } from "../processRunner.ts";
import { discoverProviderCandidates } from "./cleanupProviders.ts";
import { fileIdentity, storageLstat } from "./diskUsage.ts";

// Filesystem unit fixtures supply their own activity snapshot; native process
// and file-sharing behavior is exercised independently in storageActivity.test.
const executeStorageTask = (task: StorageWorkerTask, snapshot: [] = []) =>
  executeRealStorageTask(task, snapshot, true);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-worker-"));
  roots.push(root);
  const path = Path.join(root, "cache");
  await FS.mkdir(path);
  await FS.writeFile(Path.join(path, "item"), "downloaded package");
  const review = (await executeStorageTask({ kind: "inspect", path }, [])) as StorageFileInspection;
  return {
    root,
    path,
    task: {
      kind: "remove" as const,
      path,
      allowedRoot: root,
      identity: review.identity!,
      fingerprint: review.fingerprint!,
    },
  };
}
it("removes reviewed cache files and preserves the cache directory", async () => {
  const f = await fixture();
  const result = (await executeStorageTask(f.task, [])) as StorageFileInspection;
  expect(result.removedBytes).toBeGreaterThanOrEqual(0);
  expect(await FS.readdir(f.path)).toEqual([]);
});
it("refuses changed cache contents before deleting anything", async () => {
  const f = await fixture();
  await FS.writeFile(Path.join(f.path, "item"), "a different package was written after the review");
  await expect(executeStorageTask(f.task, [])).rejects.toThrow("changed since review");
  expect(await FS.readFile(Path.join(f.path, "item"), "utf8")).toContain("different package");
});
it("quarantines complete Bun cache entries and a real install remains healthy after partial cleanup", async () => {
  const f = await fixture();
  const source = Path.join(f.root, "source", "package");
  await FS.mkdir(source, { recursive: true });
  await FS.writeFile(
    Path.join(source, "package.json"),
    JSON.stringify({ name: "f5-cache-fixture", version: "1.0.0", main: "index.js" }),
  );
  await FS.writeFile(Path.join(source, "index.js"), "module.exports = 'healthy';");
  // Protected contents deliberately leave a partial quarantine behind.
  await FS.writeFile(Path.join(source, ".env"), "retained fixture");
  const archive = Path.join(f.root, "fixture.tgz");
  // Relative archive names also work with GNU tar on Windows, where C: is
  // otherwise interpreted as a remote archive host.
  execFileSync("tar", ["-czf", Path.basename(archive), "-C", "source", "package"], {
    cwd: f.root,
  });
  const contents = await FS.readFile(archive);
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end(contents);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const install = async (name: string) => {
      const project = Path.join(f.root, name);
      await FS.mkdir(project);
      await FS.writeFile(
        Path.join(project, "package.json"),
        JSON.stringify({
          name,
          dependencies: { "f5-cache-fixture": "http://127.0.0.1:" + port + "/fixture.tgz" },
        }),
      );
      await runProcess("bun", ["install", "--ignore-scripts"], {
        cwd: project,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: f.path, HOME: f.root, USERPROFILE: f.root },
        timeoutMs: 30_000,
      });
      expect(
        await FS.readFile(
          Path.join(project, "node_modules", "f5-cache-fixture", "index.js"),
          "utf8",
        ),
      ).toContain("healthy");
    };
    await install("first-project");
    await FS.writeFile(Path.join(f.path, ".env"), "retained fixture");
    const downloaded = requests;
    const review = (await executeStorageTask({
      kind: "inspect",
      path: f.path,
    })) as StorageFileInspection;
    await executeStorageTask({
      ...f.task,
      providerId: "bunDownloadCache",
      identity: review.identity!,
      fingerprint: review.fingerprint!,
    });
    expect(await FS.readdir(f.path)).toEqual([]);
    const leftovers = (await discoverProviderCandidates("bunDownloadCache", f.path)).filter(
      (p) => p !== f.path,
    );
    expect(leftovers).toHaveLength(1);
    await install("second-project");
    expect(requests).toBeGreaterThan(downloaded);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60_000);
it("retains databases, credentials, browser identity files and Terraform state inside caches", async () => {
  const f = await fixture();
  const names = [
    "state.sqlite",
    "state.sqlite-wal",
    ".env",
    "credentials.json",
    "terraform.tfstate",
    "Cookies",
  ];
  for (const name of names) await FS.writeFile(Path.join(f.path, name), "retain");
  const review = (await executeStorageTask(
    { kind: "inspect", path: f.path },
    [],
  )) as StorageFileInspection;
  const result = (await executeStorageTask(
    {
      ...f.task,
      identity: review.identity!,
      fingerprint: review.fingerprint!,
    },
    [],
  )) as StorageFileInspection;
  expect(result.warnings).toHaveLength(names.length);
  expect((await FS.readdir(f.path)).sort()).toEqual(names.sort());
});
it("refuses a replaced target directory even if its files match the review", async () => {
  const f = await fixture();
  await FS.rename(f.path, f.path + "-original");
  await FS.mkdir(f.path);
  await FS.writeFile(Path.join(f.path, "new"), "keep");
  await expect(executeStorageTask(f.task, [])).rejects.toThrow();
  expect(await FS.readFile(Path.join(f.path, "new"), "utf8")).toBe("keep");
});
it("never follows a symlink to remove files outside the reviewed tree", async () => {
  if (process.platform === "win32") return; // Symlink creation requires host developer-mode privileges.
  const f = await fixture();
  const outside = Path.join(f.root, "outside");
  await FS.writeFile(outside, "retain");
  await FS.symlink(outside, Path.join(f.path, "link"));
  const review = (await executeStorageTask(
    { kind: "inspect", path: f.path },
    [],
  )) as StorageFileInspection;
  await executeStorageTask(
    { ...f.task, identity: review.identity!, fingerprint: review.fingerprint! },
    [],
  );
  expect(await FS.readFile(outside, "utf8")).toBe("retain");
  expect((await FS.lstat(Path.join(f.path, "link"))).isSymbolicLink()).toBe(true);
});
it("measures real ASAR-named files in an isolated maintenance process", async () => {
  const f = await fixture();
  await FS.writeFile(Path.join(f.path, "sample.asar"), "ordinary file, not an Electron archive");
  const measurement = await runStorageTask<StorageMeasurement>({
    kind: "measure",
    roots: [f.path],
    checkpoints: [f.path],
    fileRoots: [f.path],
  });
  expect(measurement.warnings).toEqual([]);
  expect(measurement.files.map((file) => file.name).sort()).toEqual(["item", "sample.asar"]);
  expect(measurement.totalBytes).toBeGreaterThan(0);
  for (const file of measurement.files)
    expect(file.identity).toEqual(fileIdentity(await storageLstat(file.path)));
}, 15_000);
it("cancels an isolated scanner without deleting fixture data", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runStorageTask({ kind: "repositories", roots: [f.root] }, controller.signal),
  ).rejects.toThrow("cancelled");
  expect(await FS.readFile(Path.join(f.path, "item"), "utf8")).toBe("downloaded package");
});

async function snapshotFixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-worker-"));
  roots.push(root);
  const path = Path.join(root, "snapshot-1790000000000");
  await FS.mkdir(path);
  await FS.writeFile(Path.join(path, "state.sqlite"), "database");
  await FS.writeFile(Path.join(path, "state.sqlite-wal"), "log");
  return { root, path };
}
async function snapshotRemoval(path: string, root: string) {
  const review = (await executeStorageTask({ kind: "inspect", path }, [])) as StorageFileInspection;
  return {
    kind: "remove" as const,
    providerId: "f5Backups" as const,
    path,
    allowedRoot: root,
    identity: review.identity!,
    fingerprint: review.fingerprint!,
  };
}
it("removes a reclaimed database snapshot together with its directory", async () => {
  const f = await snapshotFixture();
  const result = (await executeStorageTask(
    await snapshotRemoval(f.path, f.root),
    [],
  )) as StorageFileInspection;
  expect(result.warnings).toEqual([]);
  expect(await FS.readdir(f.root)).toEqual([]);
});
it("removes a snapshot directory that an earlier cleanup left empty", async () => {
  const f = await snapshotFixture();
  await FS.rm(Path.join(f.path, "state.sqlite"));
  await FS.rm(Path.join(f.path, "state.sqlite-wal"));
  const result = (await executeStorageTask(
    await snapshotRemoval(f.path, f.root),
    [],
  )) as StorageFileInspection;
  // Nothing to free, but the caller has to know the target is gone.
  expect(result).toMatchObject({ removedBytes: 0, removedDirectory: true });
  expect(await FS.readdir(f.root)).toEqual([]);
});
it("reports what removing a snapshot frees while the snapshots next to it are kept", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-worker-"));
  roots.push(root);
  const backups = Path.join(root, "backups");
  // Whole chunks on every platform's copy-on-write unit.
  const block = 16 * 1024;
  const pages = (rewritten: ReadonlyArray<number>) => {
    const data = Buffer.alloc(16 * block, "page");
    for (const index of rewritten) data.fill("old!", index * block, (index + 1) * block);
    return data;
  };
  // Oldest first. The oldest and the middle one share block 5, which the
  // newest no longer has; only the oldest still has block 9.
  const versions = [pages([5, 9]), pages([5]), pages([])];
  const snapshots: string[] = [];
  for (const [index, data] of versions.entries()) {
    const path = Path.join(backups, `snapshot-${1_790_000_000_000 + index * 3_600_000}`);
    await FS.mkdir(path, { recursive: true });
    await FS.writeFile(Path.join(path, "state.sqlite"), data);
    snapshots.push(path);
  }
  await FS.writeFile(Path.join(root, "state.sqlite"), pages([]));

  const middle = (await executeStorageTask(
    await snapshotRemoval(snapshots[1]!, backups),
    [],
  )) as StorageFileInspection;
  expect(middle.removedBytes).toBeGreaterThanOrEqual(16 * block);
  expect(middle).toMatchObject({ reclaimedBytes: 0, removedDirectory: true });

  // With the middle one gone, the oldest is the last holder of both blocks.
  const oldest = (await executeStorageTask(
    await snapshotRemoval(snapshots[0]!, backups),
    [],
  )) as StorageFileInspection;
  expect(oldest).toMatchObject({ reclaimedBytes: 2 * block, removedDirectory: true });
  expect(await FS.readdir(backups)).toEqual([Path.basename(snapshots[2]!)]);
});
it("leaves a snapshot directory in place while it still holds something", async () => {
  const f = await snapshotFixture();
  // Not a file, so not part of the reviewed deletion.
  await FS.mkdir(Path.join(f.path, "unexpected"));
  const result = (await executeStorageTask(
    await snapshotRemoval(f.path, f.root),
    [],
  )) as StorageFileInspection;
  expect(result.warnings).toEqual([]);
  expect(await FS.readdir(f.path)).toEqual(["unexpected"]);
});
it("keeps the directory of a backups target that is not a database snapshot", async () => {
  const f = await fixture();
  await executeStorageTask({ ...f.task, providerId: "f5Backups" }, []);
  expect(await FS.readdir(f.path)).toEqual([]);
});
