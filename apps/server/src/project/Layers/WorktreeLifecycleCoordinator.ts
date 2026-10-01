import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect, Semaphore, ServiceMap } from "effect";
import { acquireInstanceLock, ProfileBusyError } from "../../profiles/InstanceLock.ts";

/**
 * Worktree lifecycle coordination.
 *
 * Every operation that can create, recreate, remove or start work inside a
 * managed worktree takes an exclusive in-process lock keyed by the canonical
 * worktree path: worktree setup, recreation (`ensureWorktree`), automatic
 * cleanup, queued turn start (gate check through acceptance), terminal open,
 * multi-model fan-out and rewind with files. Managed worktrees belong to one
 * profile, so the in-process lock is sufficient for them.
 *
 * Operations that mutate a repository's shared Git state (`worktree add`,
 * `worktree remove`, `worktree prune`, automatic pulls of the project root
 * checkout) additionally take a cross-profile SQLite lock keyed by the
 * repository's git-common-dir, because two profile servers can open the same
 * repository at once.
 *
 * Locks are re-entrant within a fiber (and the fibers it forks while holding
 * the lock), so a queued turn start can call `ensureWorktree` for the path it
 * already holds.
 */

export class RepositoryLifecycleError extends Data.TaggedError("RepositoryLifecycleError")<{
  message: string;
}> {}

/** A cross-profile repository lock was held by another F5 profile. */
export class RepositoryBusyError extends Data.TaggedError("RepositoryBusyError")<{
  message: string;
}> {}

export const REPOSITORY_BUSY_MESSAGE = "Another F5 profile is updating this repository.";

const HeldLifecycleLocks = ServiceMap.Reference<ReadonlySet<string>>(
  "f5/project/HeldLifecycleLocks",
  { defaultValue: () => new Set<string>() },
);

const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

function withKeyedLock<A, E, R>(key: string, action: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const held = yield* HeldLifecycleLocks;
    if (held.has(key)) return yield* action;
    const next = new Set(held);
    next.add(key);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        locks.set(key, entry);
        return entry;
      }),
      (entry) =>
        entry.semaphore.withPermits(1)(
          action.pipe(Effect.provideService(HeldLifecycleLocks, next as ReadonlySet<string>)),
        ),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) locks.delete(key);
        }),
    );
  });
}

/** Canonical key for a worktree path, tolerant of a missing worktree directory. */
export const worktreeLockKey = (target: string) =>
  Effect.tryPromise({
    try: () => canonicalWorktreePath(target),
    catch: (cause) =>
      new RepositoryLifecycleError({
        message: `Cannot resolve worktree path ${target}: ${String(cause)}`,
      }),
  });

/** Shared path exclusion, including paths whose worktree has not been recreated yet. */
export function withWorktreeLifecycleLock<A, E, R>(target: string, action: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const key = yield* worktreeLockKey(target);
    return yield* withKeyedLock(`worktree:${key}`, action);
  });
}

/** Whether the current fiber already holds the lifecycle lock for this path. */
export const holdsWorktreeLifecycleLock = (target: string) =>
  Effect.gen(function* () {
    const key = yield* worktreeLockKey(target);
    return (yield* HeldLifecycleLocks).has(`worktree:${key}`);
  });

export interface RepositoryLockOptions {
  /**
   * Background jobs fail fast with `RepositoryBusyError` and skip the cycle.
   * User actions retry briefly before reporting the busy repository.
   */
  readonly mode?: "user" | "background";
}

export const repositoryLockPath = (baseDir: string, canonicalCommonDir: string) =>
  path.join(
    baseDir,
    "locks",
    createHash("sha256").update(canonicalCommonDir).digest("hex") + ".sqlite",
  );

/** Git-common-dir mutations are shared by every F5 profile opening this repository. */
export function withRepositoryLifecycleLock<A, E, R>(
  baseDir: string,
  commonDir: string,
  action: Effect.Effect<A, E, R>,
  options: RepositoryLockOptions = {},
) {
  const attempts = options.mode === "background" ? 1 : 5;
  return Effect.gen(function* () {
    const canonical = yield* Effect.tryPromise({
      try: () => fs.realpath(commonDir),
      catch: (cause) =>
        new RepositoryLifecycleError({
          message: `Cannot resolve repository ${commonDir}: ${String(cause)}`,
        }),
    });
    const key = `repository:${canonical}`;
    const held = yield* HeldLifecycleLocks;
    if (held.has(key)) return yield* action;
    const lockPath = repositoryLockPath(baseDir, canonical);
    return yield* withKeyedLock(
      key,
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            for (let attempt = 1; ; attempt++) {
              try {
                return await acquireInstanceLock(lockPath);
              } catch (error) {
                if (!(error instanceof ProfileBusyError) || attempt >= attempts) throw error;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          },
          catch: (error) =>
            error instanceof ProfileBusyError
              ? new RepositoryBusyError({
                  message:
                    options.mode === "background"
                      ? REPOSITORY_BUSY_MESSAGE
                      : `${REPOSITORY_BUSY_MESSAGE} Retry shortly.`,
                })
              : new RepositoryLifecycleError({
                  message: `Cannot acquire repository lock: ${String(error)}`,
                }),
        }),
        () => action,
        (lock) => Effect.sync(() => lock.release()),
      ),
    );
  });
}

/** True when `child` is `parent` or lies inside it. Both must be canonical. */
export function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
