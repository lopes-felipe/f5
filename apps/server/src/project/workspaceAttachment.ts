import { assertNotOtherProfileManagedCheckout } from "../profiles/RepositorySharing.ts";
import { readManagedWorktreesDirectories } from "../worktreesDirectory.ts";
import { Effect } from "effect";
import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { pathContains } from "./Layers/WorktreeLifecycleCoordinator.ts";

export const canonicalWorkspace = (path: string) =>
  Effect.tryPromise(() => canonicalWorktreePath(path));
/** Whether canonical `target` is the project root or inside this profile's managed worktrees. */
export const isProjectOrManagedPath = (
  config: ServerConfigShape,
  canonicalRoot: string,
  target: string,
) =>
  readManagedWorktreesDirectories(config.worktreesDir).pipe(
    Effect.map(
      (managed) =>
        target === canonicalRoot ||
        managed.some((directory) => target !== directory && pathContains(directory, target)),
    ),
  );

/** Shared by transition targets and initial conversation attachment. */
export const inspectAttachableWorkspace = (
  git: GitCoreShape,
  config: ServerConfigShape,
  projectCwd: string,
  path: string,
  branch?: string | null,
) =>
  Effect.gen(function* () {
    const [target, root, repository] = yield* Effect.all([
      canonicalWorkspace(path),
      canonicalWorkspace(projectCwd),
      git.resolveCommonDir(projectCwd).pipe(Effect.flatMap(canonicalWorkspace)),
    ]);
    if (!(yield* isProjectOrManagedPath(config, root, target)))
      return yield* Effect.fail(
        new Error(
          "Only the project checkout and this profile's managed worktrees can be attached.",
        ),
      );
    yield* Effect.tryPromise(() => assertNotOtherProfileManagedCheckout(config, target)).pipe(
      Effect.mapError((error) => (error.cause instanceof Error ? error.cause : error)),
    );
    const inspected = yield* git.inspectCheckout(path);
    if (
      inspected.canonicalRoot !== target ||
      inspected.commonDir !== repository ||
      !inspected.registration ||
      inspected.registration.canonicalPath !== target ||
      !inspected.branch ||
      inspected.registration.detached ||
      inspected.registration.locked !== null ||
      inspected.operation
    )
      return yield* Effect.fail(
        new Error("The target is not an eligible registered checkout of this project."),
      );
    if (branch !== undefined && branch !== inspected.branch)
      return yield* Effect.fail(new Error("The target branch changed. Inspect it again."));
    return inspected;
  });

/**
 * Whether `canonicalRoot` is the workspace root of `projectId`, or of any live
 * project when the caller has none (a draft's Git request). Every in-place
 * switch guard uses this, so they agree on what "the project folder" is.
 */
export const isProjectCheckout = (
  model: {
    readonly projects: ReadonlyArray<{
      readonly id: string;
      readonly workspaceRoot: string;
      readonly deletedAt: string | null;
    }>;
  },
  canonicalRoot: string,
  projectId?: string | null,
) =>
  Effect.gen(function* () {
    for (const project of model.projects) {
      if (project.deletedAt !== null) continue;
      if (projectId != null && project.id !== projectId) continue;
      const root = yield* canonicalWorkspace(project.workspaceRoot).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (root === canonicalRoot) return true;
    }
    return false;
  });
