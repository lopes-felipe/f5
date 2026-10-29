import { afterEach, expect, it } from "vitest";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import {
  executeStorageTask,
  runStorageTask,
  type StorageFileInspection,
  type StorageMeasurement,
} from "./storageWorker.ts";

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
