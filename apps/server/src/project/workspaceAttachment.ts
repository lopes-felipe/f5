import { assertNotOtherProfileManagedCheckout } from "../profiles/RepositorySharing.ts";
import { readManagedWorktreesDirectories } from "../worktreesDirectory.ts";
import { Effect } from "effect";
import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import { pathContains } from "./Layers/WorktreeLifecycleCoordinator.ts";

export const canonicalWorkspace = (path: string) =>
  Effect.tryPromise(() => canonicalWorktreePath(path));
/** Shared by transition targets and initial conversation attachment. */
export const inspectAttachableWorkspace = (
  git: GitCoreShape,
  config: ServerConfigShape,
  projectCwd: string,
  path: string,
  branch?: string | null,
) =>
  Effect.gen(function* () {
    const [target, root, managed, repository] = yield* Effect.all([
      canonicalWorkspace(path),
      canonicalWorkspace(projectCwd),
      readManagedWorktreesDirectories(config.worktreesDir),
      git.resolveCommonDir(projectCwd).pipe(Effect.flatMap(canonicalWorkspace)),
    ]);
    if (
      target !== root &&
      !managed.some((directory) => target !== directory && pathContains(directory, target))
    )
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

/** Whether `canonicalRoot` is the workspace root of a live project (not a managed worktree). */
export const isProjectCheckout = (
  model: {
    readonly projects: ReadonlyArray<{
      readonly workspaceRoot: string;
      readonly deletedAt: string | null;
    }>;
  },
  canonicalRoot: string,
) =>
  Effect.gen(function* () {
    for (const project of model.projects) {
      if (project.deletedAt !== null) continue;
      const root = yield* canonicalWorkspace(project.workspaceRoot).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (root === canonicalRoot) return true;
    }
    return false;
  });
