import {
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { ProjectRepository } from "@t3tools/contracts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { isInsideProjectWorkspace } from "./projectSettings.ts";
import type { WorktreeGroupPlan } from "../persistence/Services/WorktreePreparations.ts";
import { startOwnedSetupScript } from "./ownedSetupScript.ts";

export function runApprovedWorktreeLayout(
  group: WorktreeGroupPlan,
  command: string,
  baseBranch: string,
) {
  return Effect.suspend(() => {
    const tail: string[] = [];
    return Effect.acquireUseRelease(
      startOwnedSetupScript({
        command,
        cwd: group.projectRoot,
        env: {
          T3_PROJECT_ROOT: group.projectRoot,
          T3_WORKTREE_ROOT: group.path,
          T3_WORKTREE_PROJECT_PATH: group.path,
          T3_WORKTREE_BRANCH: group.branch,
          T3_WORKTREE_BASE: baseBranch,
          T3_WORKTREE_REPOSITORIES: group.members.map((member) => member.source).join("\n"),
          T3CODE_PROJECT_ROOT: group.projectRoot,
          T3CODE_WORKTREE_PATH: group.path,
        },
        onLine: (line) => {
          tail.push(line.slice(0, 300));
          if (tail.length > 5) tail.shift();
        },
      }),
      (process) =>
        process.exit.pipe(
          Effect.timeout("10 minutes"),
          Effect.flatMap((code) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new Error(
                    "Approved worktree layout command exited with " +
                      (code ?? "no status") +
                      "." +
                      (tail.length ? "\n" + tail.join("\n") : ""),
                  ),
                ),
          ),
        ),
      (process) => process.kill,
    );
  });
}

export function externalRepositoryPath(source: string) {
  const name = path
    .basename(source)
    .replace(/[^a-z0-9_-]/giu, "-")
    .slice(0, 24);
  return (
    ".f5-repositories/" +
    name +
    "-" +
    createHash("sha256").update(source).digest("hex").slice(0, 12)
  );
}

/** Recreate only the directory corridors needed by repositories. */
export async function linkPlainWorktreeFiles(
  plan: WorktreeGroupPlan,
  repositoryPaths: ReadonlyArray<string>,
) {
  const copyDirectory = async (source: string, target: string): Promise<void> => {
    await mkdir(target, { recursive: true });
    if ((await canonicalWorktreePath(target)) !== target)
      throw new Error("The workspace directory was replaced by a link.");
    for (const name of await readdir(source)) {
      if (name === ".git") continue;
      const from = path.join(source, name);
      const to = path.join(target, name);
      if (repositoryPaths.includes(from)) continue;
      if (repositoryPaths.some((repository) => isInsideProjectWorkspace(from, repository))) {
        await copyDirectory(from, to);
        continue;
      }
      const entry = await lstat(from);
      // Repository paths are canonical. An alias must never expose the original checkout
      // inside an isolated workspace, even when it points at a corridor holding a repo.
      if (entry.isSymbolicLink()) {
        const canonical = await realpath(from).catch(() => null);
        if (
          canonical &&
          repositoryPaths.some(
            (repository) =>
              isInsideProjectWorkspace(canonical, repository) ||
              isInsideProjectWorkspace(repository, canonical),
          )
        )
          continue;
      }
      const linkType =
        process.platform === "win32" ? (entry.isDirectory() ? "junction" : "file") : undefined;
      try {
        await symlink(from, to, linkType);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A retry keeps workspace-local files and links in place.
        if ((await lstat(to)).isSymbolicLink() && (await readlink(to)) === from) continue;
      }
    }
  };
  await copyDirectory(plan.projectRoot, plan.path);
}

/** Walk only layout directories and remove only the links the layout produces. */
export async function cleanPlainWorktreeLayout(plan: WorktreeGroupPlan, remove: boolean) {
  const clean = async (directory: string): Promise<void> => {
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (entries === null) return;
    if ((await canonicalWorktreePath(directory)) !== directory)
      throw new Error("The workspace directory was replaced by a link.");
    for (const name of entries) {
      const entry = path.join(directory, name);
      if (!remove && plan.members.some((member) => member.path === entry)) continue;
      const info = await lstat(entry);
      if (info.isSymbolicLink()) {
        const source = path.join(plan.projectRoot, path.relative(plan.path, entry));
        if (path.resolve(directory, await readlink(entry)) !== source)
          throw new Error("The workspace contains an unrecognized link: " + entry);
        if (remove) await unlink(entry);
      } else if (
        info.isDirectory() &&
        (plan.members.some(
          (member) => member.path !== entry && isInsideProjectWorkspace(entry, member.path),
        ) ||
          plan.repositories.some((repository) => {
            const mapped = path.join(plan.path, path.relative(plan.projectRoot, repository));
            return isInsideProjectWorkspace(entry, mapped) && entry !== mapped;
          }))
      ) {
        await clean(entry);
      } else {
        throw new Error("The workspace contains files that exist only in this folder: " + entry);
      }
    }
    if (remove) await rmdir(directory);
  };
  await clean(plan.path);
}

/**
 * Git worktree add must never follow a hook-created link into the original checkout.
 * A real empty directory can be reused. Any populated destination belongs to the checkout hook.
 */
export const inspectNestedWorktreeDestination = Effect.fn("inspectNestedWorktreeDestination")(
  function* (worktreeRoot: string, repositoryPath: string) {
    const canonicalRoot = yield* Effect.tryPromise(() => canonicalWorktreePath(worktreeRoot));
    const canonicalTarget = path.resolve(canonicalRoot, repositoryPath);
    if (
      canonicalTarget === canonicalRoot ||
      !isInsideProjectWorkspace(canonicalRoot, canonicalTarget)
    ) {
      return yield* Effect.fail(new Error("Repository path is outside the worktree."));
    }
    const target = path.resolve(worktreeRoot, repositoryPath);
    const realTarget = yield* Effect.tryPromise(() => canonicalWorktreePath(target)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (realTarget !== canonicalTarget) return { target, kind: "occupied" } as const;
    const entry = yield* Effect.tryPromise(() => lstat(target)).pipe(
      Effect.catch((error) =>
        (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    );
    if (entry === null) return { target, kind: "missing" } as const;
    if (!entry.isDirectory()) return { target, kind: "occupied" } as const;
    const contents = yield* Effect.tryPromise(() => readdir(target));
    return { target, kind: contents.length === 0 ? "empty" : "occupied" } as const;
  },
);

export const nestedWorktreeOwner = (root: string) => "project-worktree:" + root;

export function selectNestedWorktreeRepositories(
  repositories: ReadonlyArray<ProjectRepository>,
  paths: ReadonlyArray<string> | undefined,
  rootUsesSlot = true,
) {
  if (paths === undefined)
    return repositories.length <= (rootUsesSlot ? 7 : 8)
      ? Effect.succeed(repositories)
      : rootUsesSlot
        ? Effect.succeed([])
        : Effect.fail(
            new Error("Select the repositories to include before creating this worktree."),
          );
  const selected = new Set(paths);
  if (paths.some((entry) => !repositories.some(({ relativePath }) => relativePath === entry)))
    return Effect.fail(new Error("A selected repository is no longer in this project."));
  return Effect.succeed(repositories.filter(({ relativePath }) => selected.has(relativePath)));
}

export const resolveNestedWorktreeBase = (
  git: Pick<GitCoreShape, "resolveCommit">,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    return (
      (yield* git.resolveCommit(cwd, "refs/heads/" + branch)) ??
      (yield* git.resolveCommit(cwd, "refs/remotes/" + branch)) ??
      (yield* git.resolveCommit(cwd, "refs/remotes/origin/" + branch))
    );
  });
