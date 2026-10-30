import { lstat, readdir, readFile, readlink, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";

import type { GitCommandError } from "./Errors.ts";

/**
 * Git for Windows before 2.54 follows NTFS junctions while it deletes a
 * worktree, and deletes what they point to, such as a node_modules shared
 * with the main checkout. Later versions skip junctions but leave them, and
 * the folders holding them, behind. On Windows, Git therefore never deletes a
 * worktree's files. Git elsewhere only unlinks links.
 */
export const gitDeletesWorktreeFiles = (platform: NodeJS.Platform = process.platform) =>
  platform !== "win32";

const pathExists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * Removes the linked worktree at `worktreePath` without Git deleting files.
 * Makes the checks a plain `git worktree remove` makes just before deleting
 * (builtin/worktree.c), deletes the folder with Node's `rm`, which unlinks
 * junctions and symlinks without following them, and then has Git drop the
 * now-missing worktree's metadata. Callers have already verified identity and
 * ignored files under the lifecycle locks; submodules, the lock and local
 * changes are checked again here because terminal Git ignores those locks.
 */
export const removeWorktreeWithoutFollowingLinks = (input: {
  readonly cwd: string;
  readonly worktreePath: string;
  /** Runs Git and fails on a non-zero exit. */
  readonly git: (
    cwd: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<{ readonly stdout: string }, GitCommandError>;
  readonly refuse: (detail: string, cause?: unknown) => GitCommandError;
  /** The refusal when files changed since the caller's inspection. */
  readonly changedDetail: string;
}): Effect.Effect<void, GitCommandError> =>
  Effect.gen(function* () {
    const { worktreePath, refuse } = input;
    const gitFile = join(worktreePath, ".git");
    const fs = <A>(detail: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => refuse(detail, cause) });
    const adminDir = resolve(
      worktreePath,
      (yield* input.git(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim(),
    );
    // Git counts the lock file's existence. An unreadable path counts as present.
    const present = (path: string) =>
      fs(`Cannot inspect ${path}.`, () => pathExists(path)).pipe(Effect.orElseSucceed(() => true));
    if (yield* present(join(adminDir, "locked")))
      return yield* refuse(`The target ${worktreePath} is a locked worktree.`);
    // Bound like Git's own checks, so `core.worktree` cannot point them elsewhere.
    const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
    const submodules = refuse(
      "Initialized submodules prevent safe removal. Deinitialize them after preserving their local work, then retry.",
    );
    if (yield* present(join(adminDir, "modules"))) return yield* submodules;
    // A submodule initialized in place keeps its repository in `<path>/.git`,
    // which `rm` would delete with any unpushed commits.
    const index = yield* input.git(worktreePath, ["ls-files", "--stage", "-z"], boundEnv);
    for (const entry of index.stdout.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      if (yield* present(join(worktreePath, submodule, ".git"))) return yield* submodules;
    }
    const status = yield* input.git(
      worktreePath,
      ["-c", "status.showUntrackedFiles=all", "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status.stdout !== "") return yield* refuse(input.changedDetail);

    // A file held open can stop the delete partway. Putting `.git` back, when
    // that works, leaves a worktree that a retry can remove.
    const gitFileContents = yield* fs(`Cannot read ${gitFile}.`, () => readFile(gitFile, "utf8"));
    yield* fs(`Failed to delete ${worktreePath}.`, async () => {
      try {
        await rm(worktreePath, { recursive: true });
      } catch (error) {
        await writeFile(gitFile, gitFileContents).catch(() => undefined);
        throw error;
      }
    });
    // The folder is gone, so Git only drops the worktree's metadata.
    yield* input.git(input.cwd, ["worktree", "remove", "--force", "--force", "--", worktreePath]);
  });

/**
 * Unlinks links left under `path` without following them and removes the
 * folders left empty. Returns false when anything else remains, such as a file
 * written after Git removed the worktree; that file is kept.
 */
export async function removeLeftoverLinks(path: string): Promise<boolean> {
  const isLink = await readlink(path).then(
    () => true,
    () => false,
  );
  if (isLink) {
    await unlink(path);
    return true;
  }
  if (!(await lstat(path)).isDirectory()) return false;
  let empty = true;
  for (const name of await readdir(path)) {
    if (!(await removeLeftoverLinks(join(path, name)))) empty = false;
  }
  if (!empty) return false;
  // Only an empty directory goes, so files written since the listing stay.
  return rmdir(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
      throw error;
    },
  );
}
