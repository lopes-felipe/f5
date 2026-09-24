import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect, Semaphore } from "effect";
import { acquireInstanceLock, ProfileBusyError } from "../../profiles/InstanceLock.ts";

class RepositoryLifecycleError extends Data.TaggedError("RepositoryLifecycleError")<{
  message: string;
}> {}

const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Shared path exclusion, including paths whose worktree has not been recreated yet. */
export function withWorktreeLifecycleLock<A, E, R>(target: string, action: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const key = yield* Effect.tryPromise(() => canonicalWorktreePath(target));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        entry.users++;
        locks.set(key, entry);
        return entry;
      }),
      (entry) => entry.semaphore.withPermits(1)(action),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) locks.delete(key);
        }),
    );
  });
}

/** Git-common-dir mutations are shared by every F5 profile opening this repository. */
export function withRepositoryLifecycleLock<A, E, R>(
  baseDir: string,
  commonDir: string,
  action: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const canonical = yield* Effect.tryPromise(() => fs.realpath(commonDir));
    const lockPath = path.join(
      baseDir,
      "locks",
      createHash("sha256").update(canonical).digest("hex") + ".sqlite",
    );
    return yield* withWorktreeLifecycleLock(
      canonical,
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            for (let attempt = 0; ; attempt++) {
              try {
                return await acquireInstanceLock(lockPath);
              } catch (error) {
                if (!(error instanceof ProfileBusyError) || attempt === 4) throw error;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          },
          catch: (error) =>
            new RepositoryLifecycleError({
              message:
                error instanceof ProfileBusyError
                  ? "Another F5 profile is updating this repository. Retry shortly."
                  : `Cannot acquire repository lock: ${String(error)}`,
            }),
        }),
        () => action,
        (lock) => Effect.sync(() => lock.release()),
      ),
    );
  });
}
