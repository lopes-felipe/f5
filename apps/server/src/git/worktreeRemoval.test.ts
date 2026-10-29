import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { GitCommandError } from "./Errors.ts";
import {
  gitDeletesWorktreeFiles,
  removeLeftoverLinks,
  removeWorktreeWithoutFollowingLinks,
} from "./worktreeRemoval.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "f5-worktree-removal-"));
  roots.push(root);
  return root;
};

const runGit = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

const refuse = (detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "test.removeWorktree",
    command: "git worktree remove",
    cwd: "",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** A repository whose linked worktree links `node_modules` to a folder outside it. */
function repositoryWithLinkedWorktree() {
  const root = makeRoot();
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const shared = join(root, "shared");
  mkdirSync(repo);
  mkdirSync(shared);
  writeFileSync(join(shared, "keep.txt"), "shared\n");
  runGit(repo, ["init", "--initial-branch=main"]);
  runGit(repo, ["config", "user.email", "test@test.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  runGit(repo, ["add", ".gitignore"]);
  runGit(repo, ["commit", "-m", "initial"]);
  runGit(repo, ["worktree", "add", "-b", "feature", worktree]);
  symlinkSync(shared, join(worktree, "node_modules"), "dir");
  return { repo, worktree, shared };
}

const remove = (repo: string, worktree: string) =>
  Effect.runPromise(
    removeWorktreeWithoutFollowingLinks({
      cwd: repo,
      worktreePath: worktree,
      git: (cwd, args, env) =>
        Effect.try({
          try: () => ({ stdout: runGit(cwd, args, env) }),
          catch: (cause) => refuse(`git ${args.join(" ")} failed`, cause),
        }),
      refuse,
      changedDetail: "changed since review",
    }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null })),
  );

describe("removeWorktreeWithoutFollowingLinks", () => {
  it("is used only where Git can delete what a link points to", () => {
    expect(gitDeletesWorktreeFiles("win32")).toBe(false);
    expect(gitDeletesWorktreeFiles("darwin")).toBe(true);
    expect(gitDeletesWorktreeFiles("linux")).toBe(true);
  });

  it("deletes the worktree and unregisters it, keeping what its links point to", async () => {
    const { repo, worktree, shared } = repositoryWithLinkedWorktree();
    expect(await remove(repo, worktree)).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(join(shared, "keep.txt"))).toBe(true);
    expect(runGit(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
  });

  it("refuses a worktree that changed since the caller's inspection", async () => {
    const { repo, worktree } = repositoryWithLinkedWorktree();
    writeFileSync(join(worktree, "late.txt"), "late\n");
    expect((await remove(repo, worktree))?.detail).toBe("changed since review");
    expect(existsSync(join(worktree, "late.txt"))).toBe(true);
    expect(runGit(repo, ["worktree", "list", "--porcelain"])).toContain("feature");
  });

  it("refuses a locked worktree", async () => {
    const { repo, worktree } = repositoryWithLinkedWorktree();
    runGit(repo, ["worktree", "lock", worktree]);
    expect((await remove(repo, worktree))?.detail).toContain("locked");
    expect(existsSync(join(worktree, ".git"))).toBe(true);
  });
});

describe("removeLeftoverLinks", () => {
  it("unlinks links without following them and removes the folders left empty", async () => {
    const root = makeRoot();
    const leftover = join(root, "leftover");
    const target = join(root, "target");
    mkdirSync(join(leftover, "packages", "app"), { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "target\n");
    symlinkSync(target, join(leftover, "packages", "app", "node_modules"), "dir");
    symlinkSync(target, join(leftover, "node_modules"), "dir");

    expect(await removeLeftoverLinks(leftover)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });

  it("keeps ordinary files and the folders holding them", async () => {
    const root = makeRoot();
    const leftover = join(root, "leftover");
    const target = join(root, "target");
    mkdirSync(join(leftover, "empty"), { recursive: true });
    mkdirSync(target);
    writeFileSync(join(leftover, "written-later.txt"), "new\n");
    symlinkSync(target, join(leftover, "node_modules"), "dir");

    expect(await removeLeftoverLinks(leftover)).toBe(false);
    expect(existsSync(join(leftover, "written-later.txt"))).toBe(true);
    expect(existsSync(join(leftover, "node_modules"))).toBe(false);
    expect(existsSync(join(leftover, "empty"))).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
