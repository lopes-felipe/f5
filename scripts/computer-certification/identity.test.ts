import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree } from "./identity";

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "f5-payload-hash-test-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("pins framework and DLL contents outside Resources as part of the full bundle", async () => {
  const directory = await root();
  await mkdir(join(directory, "Contents/Resources/native"), { recursive: true });
  await mkdir(join(directory, "Contents/Frameworks"));
  await writeFile(join(directory, "Contents/Resources/native/helper"), "helper");
  await writeFile(join(directory, "Contents/Frameworks/runtime"), "runtime-v1");
  await writeFile(join(directory, "runtime.dll"), "dll-v1");
  const original = await hashTree(directory, true);
  expect(await hashTree(directory, true)).toBe(original);
  await writeFile(join(directory, "Contents/Frameworks/runtime"), "runtime-v2");
  const frameworkChanged = await hashTree(directory, true);
  expect(frameworkChanged).not.toBe(original);
  await writeFile(join(directory, "runtime.dll"), "dll-v2");
  expect(await hashTree(directory, true)).not.toBe(frameworkChanged);
});

it("separates file names, content hashes and entry types unambiguously", async () => {
  const first = await root(),
    second = await root();
  await writeFile(join(first, "a"), "bc");
  await writeFile(join(second, "ab"), "c");
  expect(await hashTree(first)).not.toBe(await hashTree(second));
});

it("records safe framework aliases without traversing directory cycles", async () => {
  const directory = await root();
  await mkdir(join(directory, "Versions/A"), { recursive: true });
  await writeFile(join(directory, "Versions/A/runtime"), "runtime-v1");
  await symlink(join(directory, "Versions/A"), join(directory, "Versions/Current"), "junction");
  await expect(hashTree(directory)).rejects.toThrow("symbolic link");
  const original = await hashTree(directory, true);
  await writeFile(join(directory, "Versions/A/runtime"), "runtime-v2");
  expect(await hashTree(directory, true)).not.toBe(original);
});

it("refuses a bundle alias resolving outside the installed payload", async () => {
  const directory = await root(),
    outside = await root();
  await symlink(outside, join(directory, "escaped"), "junction");
  await expect(hashTree(directory, true)).rejects.toThrow("escaped");
});
