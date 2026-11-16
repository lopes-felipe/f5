import { expect, it } from "vitest";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { discoverRepositories, normalizeRepositorySearchRoots } from "./storageDiscovery.ts";

it("discovers real repository markers without traversing dependencies, repository internals or symlinks", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-storage-discovery-"));
  try {
    await FS.mkdir(Path.join(root, "project", ".git"), { recursive: true });
    await FS.mkdir(Path.join(root, "node_modules", "dependency", ".git"), { recursive: true });
    await FS.mkdir(Path.join(root, "project", "nested", ".git"), { recursive: true });
    await FS.mkdir(Path.join(root, "linked"));
    await FS.writeFile(Path.join(root, "linked", ".git"), "gitdir: /repo/.git/worktrees/linked\n");
    const result = await discoverRepositories([root, root]);
    expect(result.repositories.toSorted()).toEqual(
      [
        await FS.realpath(Path.join(root, "linked")),
        await FS.realpath(Path.join(root, "project")),
      ].toSorted(),
    );
    expect(result.warnings).toEqual([]);
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});

it("rejects relative search roots rather than resolving them against the server cwd", async () => {
  const result = await discoverRepositories(["relative/project"]);
  expect(result.repositories).toEqual([]);
  expect(result.warnings[0]?.reason).toContain("must be absolute");
});
it("normalizes home paths and rejects relative settings before discovery", () => {
  expect(normalizeRepositorySearchRoots(["~/code", "~/code"], OS.homedir())).toEqual([
    Path.join(OS.homedir(), "code"),
  ]);
  expect(() => normalizeRepositorySearchRoots(["relative"])).toThrow("absolute");
});

it("returns partial coverage when a filesystem call stalls", async () => {
  const result = await discoverRepositories([Path.resolve(OS.tmpdir())], {
    rootBudgetMs: 10,
    fs: { ...FS, lstat: () => new Promise(() => {}) },
  });
  expect(result.repositories).toEqual([]);
  expect(result.warnings[0]?.reason).toContain("results are partial");
});
