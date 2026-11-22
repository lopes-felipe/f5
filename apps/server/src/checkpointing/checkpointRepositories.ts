import type { CheckpointRef, ProjectRepository } from "@t3tools/contracts";
import { Effect } from "effect";
import type { CheckpointStoreShape } from "./Services/CheckpointStore.ts";
import { pruneCheckpointRefs } from "./pruneCheckpointRefs.ts";

export function nestedCheckpointPaths(
  repository: ProjectRepository,
  repositories: ReadonlyArray<ProjectRepository>,
) {
  const prefix = repository.relativePath === "." ? "" : repository.relativePath + "/";
  return repositories
    .filter((entry) => entry.path !== repository.path && entry.relativePath.startsWith(prefix))
    .map((entry) => entry.relativePath.slice(prefix.length));
}

export function checkpointRepositoriesWithRef(
  store: CheckpointStoreShape,
  repositories: ReadonlyArray<ProjectRepository>,
  checkpointRef: CheckpointRef,
) {
  return Effect.filter(
    repositories,
    ({ path }) => store.hasCheckpointRef({ cwd: path, checkpointRef }),
    { concurrency: 4 },
  );
}

export function restoreCheckpointRepositories(
  store: CheckpointStoreShape,
  repositories: ReadonlyArray<ProjectRepository>,
  checkpointRef: CheckpointRef,
  fallbackToHead = false,
) {
  return Effect.gen(function* () {
    if (repositories.length === 1) {
      const restored = yield* store.restoreCheckpoint({
        cwd: repositories[0]!.path,
        checkpointRef,
        fallbackToHead,
      });
      return { restored, skipped: [] };
    }
    const available = yield* checkpointRepositoriesWithRef(store, repositories, checkpointRef);
    const restored = yield* Effect.forEach(available, (repository) =>
      store.restoreCheckpoint({
        cwd: repository.path,
        checkpointRef,
        excludePaths: nestedCheckpointPaths(repository, repositories),
      }),
    );
    return {
      restored: restored.length > 0 && restored.every(Boolean),
      skipped: repositories.filter((repository) => !available.includes(repository)),
    };
  });
}

export function pruneRepositoryCheckpointRefs(
  store: CheckpointStoreShape,
  repositories: ReadonlyArray<ProjectRepository>,
  checkpointRefs: ReadonlyArray<CheckpointRef>,
) {
  return Effect.forEach(
    repositories,
    ({ path }) => pruneCheckpointRefs(store, { cwd: path, checkpointRefs }),
    { concurrency: 4, discard: true },
  );
}
