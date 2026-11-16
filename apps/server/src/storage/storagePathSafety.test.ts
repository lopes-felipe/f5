import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, expect, test } from "vitest";
import { fileIdentity, storageLstat } from "./diskUsage.ts";
import { removeFileIfSafe, removeTreeIfSafe, validateDeletablePath } from "./storagePathSafety.ts";
const roots: string[] = [];
async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-path-safety-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => FS.rm(path, { recursive: true, force: true })));
});
test("worktree directory identity tolerates content timestamps but refuses replacement", async () => {
  const root = await fixture(),
    path = Path.join(root, "worktree");
  await FS.mkdir(path);
  const expectedIdentity = fileIdentity(await storageLstat(path));
  await FS.writeFile(Path.join(path, ".DS_Store"), "new contents");
  const input = { path, allowedRoot: root, expectedIdentity, directoryIdentityOnly: true };
  expect((await validateDeletablePath(input)).kind).toBe("validated");
  await FS.rename(path, Path.join(root, "old"));
  await FS.mkdir(path);
  expect((await validateDeletablePath(input)).kind).toBe("refused");
});
test("cancellation during async validation prevents file and tree removal", async () => {
  const root = await fixture();
  for (const directory of [false, true]) {
    const path = Path.join(root, directory ? "tree" : "file");
    if (directory) await FS.mkdir(path);
    else await FS.writeFile(path, "keep");
    let cancelled = false;
    const input = { path, allowedRoot: root, isCancelled: () => cancelled };
    const removal = directory ? removeTreeIfSafe(input) : removeFileIfSafe(input);
    queueMicrotask(() => {
      cancelled = true;
    });
    expect((await removal).kind).toBe("refused");
    expect(await FS.lstat(path)).toBeDefined();
  }
});
test("missing paths succeed as absent; roots and symlinks are refused", async () => {
  const root = await fixture(),
    path = Path.join(root, "link");
  expect((await removeFileIfSafe({ path, allowedRoot: root })).kind).toBe("absent");
  await FS.symlink(root, path);
  expect((await removeFileIfSafe({ path, allowedRoot: root })).kind).toBe("refused");
  expect((await removeTreeIfSafe({ path: root, allowedRoot: root })).kind).toBe("refused");
});
test("replaced files and files that appeared after review are retained", async () => {
  const root = await fixture(),
    path = Path.join(root, "file");
  await FS.writeFile(path, "first");
  const identity = fileIdentity(await storageLstat(path));
  await FS.rename(path, Path.join(root, "old"));
  await FS.writeFile(path, "second");
  expect(
    (await removeFileIfSafe({ path, allowedRoot: root, expectedIdentity: identity })).kind,
  ).toBe("refused");
  expect((await removeFileIfSafe({ path, allowedRoot: root, expectedIdentity: null })).kind).toBe(
    "refused",
  );
  expect(
    (
      await removeFileIfSafe({
        path,
        allowedRoot: root,
        expectedIdentity: fileIdentity(await storageLstat(path)),
      })
    ).kind,
  ).toBe("removed");
  expect(
    (await removeFileIfSafe({ path, allowedRoot: root, expectedIdentity: identity })).kind,
  ).toBe("absent");
});
