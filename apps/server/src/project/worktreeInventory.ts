import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import path from "node:path";

import type {
  WorktreeListEntry,
  WorktreesListInput,
  WorktreesListResult,
} from "@t3tools/contracts";
import { Data, Effect, FileSystem, Semaphore } from "effect";
import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { readOtherProfileManagedRoots } from "../profiles/RepositorySharing.ts";
import { pathContains } from "./Layers/WorktreeLifecycleCoordinator.ts";

class WorktreeInventoryError extends Data.TaggedError("WorktreeInventoryError")<{
  message: string;
  cause: unknown;
}> {}

type ReadModel = Effect.Success<ReturnType<OrchestrationEngineShape["getReadModel"]>>;

/** Local inventory only: no fetch, diff statistics, preparation, or mutation locks. */
export const listWorktreeInventory = (
  input: WorktreesListInput,
  model: Pick<ReadModel, "projects" | "threads">,
  git: GitCoreShape,
  config: ServerConfigShape,
  fs: FileSystem.FileSystem,
): Effect.Effect<WorktreesListResult, Error> =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(4);
    const asError = (error: unknown) =>
      new WorktreeInventoryError({
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    const canonical = (path: string) =>
      Effect.tryPromise({ try: () => canonicalWorktreePath(path), catch: asError });
    const managedRoot = yield* canonical(config.worktreesDir);
    const otherRoots = yield* Effect.tryPromise({
      try: () => readOtherProfileManagedRoots(config),
      catch: asError,
    });
    // Worktrees belong to Git checkouts; the scratch project and its folders are not one.
    const projects = model.projects.filter((p) => p.deletedAt === null && !isScratchProject(p));
    if (input.projectId && !projects.some((p) => p.id === input.projectId))
      return yield* Effect.fail(new Error("Unknown project"));
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const threads = model.threads.filter(
      (t) => t.deletedAt === null && projectsById.has(t.projectId),
    );
    const workspaceOf = (thread: (typeof threads)[number]) =>
      threadWorkspaceCwd(thread, projectsById.get(thread.projectId))!;
    const distinctPaths = [...new Set(threads.map(workspaceOf))];
    const paths = new Map(
      yield* Effect.forEach(
        distinctPaths,
        (path) =>
          permits.withPermits(1)(
            canonical(path).pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.map((resolved) => [path, resolved] as const),
            ),
          ),
        { concurrency: 4 },
      ),
    );
    const linkedByPath = new Map<string, WorktreeListEntry["linkedThreads"][number][]>();
    for (const thread of threads) {
      const path = paths.get(workspaceOf(thread));
      if (!path) continue;
      const linked = linkedByPath.get(path) ?? [];
      linked.push({
        threadId: thread.id,
        title: thread.title,
        archived: thread.archivedAt !== null,
      });
      linkedByPath.set(path, linked);
    }
    const results = yield* Effect.forEach(
      projects.filter((p) => !input.projectId || p.id === input.projectId),
      (project) => {
        const base = {
          projectId: project.id,
          name: project.title,
          workspaceRoot: project.workspaceRoot,
        };
        return Effect.gen(function* () {
          // Git diagnoses non-repositories, including projects nested inside a checkout.
          // Identity/status failures stay visible instead of looking like empty inventories.
          const registrations = yield* git
            .listWorktrees(project.workspaceRoot)
            .pipe(
              Effect.catch((error) =>
                /not a git repository/i.test(error.detail)
                  ? Effect.succeed(null)
                  : Effect.fail(error),
              ),
            );
          if (registrations === null) return null;
          const root = yield* canonical(project.workspaceRoot);
          if (!registrations.some((entry) => entry.canonicalPath === root)) {
            const checkout = registrations.find((entry) => pathContains(entry.canonicalPath, root));
            if (checkout)
              return yield* Effect.fail(
                new Error(
                  `Project folder is inside a Git checkout. Manage worktrees from its checkout root: ${path.normalize(checkout.path)}`,
                ),
              );
          }
          const entries = new Map<
            string,
            { path: string; registration: WorktreeListEntry["registration"]; branch: string | null }
          >(
            registrations.map((entry) => [
              entry.canonicalPath,
              {
                path: entry.path,
                registration: entry,
                branch: entry.branch,
              },
            ]),
          );
          for (const thread of threads) {
            const recordedPath = workspaceOf(thread);
            const resolved = paths.get(recordedPath);
            if (thread.projectId === project.id && !resolved)
              return yield* Effect.fail(
                new Error(`Cannot resolve recorded workspace: ${recordedPath}`),
              );
            if (resolved && thread.projectId === project.id && !entries.has(resolved))
              entries.set(resolved, {
                path: recordedPath,
                registration: null,
                branch: thread.branch,
              });
          }
          const rows = yield* Effect.forEach(
            [...entries],
            ([canonicalPath, entry]) =>
              permits.withPermits(1)(
                Effect.gen(function* () {
                  const missing = !(yield* fs.exists(entry.path));
                  const classification = otherRoots.some((r) => pathContains(r, canonicalPath))
                    ? "otherProfile"
                    : canonicalPath === root
                      ? "projectCheckout"
                      : canonicalPath !== managedRoot && pathContains(managedRoot, canonicalPath)
                        ? "managed"
                        : "external";
                  const displayPath = path.normalize(entry.path);
                  return {
                    ...entry,
                    path: displayPath,
                    registration: entry.registration
                      ? { ...entry.registration, path: displayPath }
                      : null,
                    canonicalPath,
                    classification,
                    missing,
                    locked:
                      entry.registration?.locked !== null &&
                      entry.registration?.locked !== undefined,
                    detached: entry.registration?.detached ?? entry.branch === null,
                    hasChanges: missing ? null : yield* git.isDirty(entry.path),
                    linkedThreads: linkedByPath.get(canonicalPath) ?? [],
                  } satisfies WorktreeListEntry;
                }),
              ),
            { concurrency: 4 },
          );
          const rank = (row: WorktreeListEntry) =>
            row.classification === "projectCheckout" ? 0 : row.linkedThreads.length ? 1 : 2;
          rows.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
          return { ...base, entries: rows, error: null };
        }).pipe(
          Effect.catch((error) => Effect.succeed({ ...base, entries: [], error: String(error) })),
        );
      },
      { concurrency: 4 },
    );
    return { projects: results.filter((p) => p !== null) };
  });
