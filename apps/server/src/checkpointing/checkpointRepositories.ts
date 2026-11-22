import { createHash } from "node:crypto";
import { CheckpointRef, type ProjectRepository } from "@t3tools/contracts";
import { Effect } from "effect";
import type { CheckpointStoreShape } from "./Services/CheckpointStore.ts";
import { pruneCheckpointRefs } from "./pruneCheckpointRefs.ts";

export function nestedCheckpointPaths(
  repository: ProjectRepository,
  repositories: ReadonlyArray<ProjectRepository>,
  operation: "capture" | "restore",
) {
  const prefix = repository.relativePath === "." ? "" : repository.relativePath + "/";
  return repositories
    .filter(
      (entry) =>
        entry.path !== repository.path &&
        entry.relativePath.startsWith(prefix) &&
        (operation === "restore" || !entry.submodule),
    )
    .map((entry) => entry.relativePath.slice(prefix.length));
}

export function scopedCheckpointRef(checkpointRef: CheckpointRef, repository: ProjectRepository) {
  if (repository.relativePath === ".") return checkpointRef;
  const scope = createHash("sha256").update(repository.relativePath).digest("hex");
  return CheckpointRef.makeUnsafe(checkpointRef + "-repo-" + scope);
}

export function checkpointWorkspaceRepositories(repositories: ReadonlyArray<ProjectRepository>) {
  return repositories.filter((repository) => repository.externalSource !== repository.path);
}

export function checkpointRepositoriesWithRef(
  store: CheckpointStoreShape,
  repositories: ReadonlyArray<ProjectRepository>,
  checkpointRef: CheckpointRef,
) {
  return Effect.filter(
    repositories,
    (repository) =>
      store.hasCheckpointRef({
        cwd: repository.path,
        checkpointRef: scopedCheckpointRef(checkpointRef, repository),
      }),
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
    if (repositories.length === 1 && repositories[0]?.relativePath === ".") {
      const repository = repositories[0];
      const restored = yield* store.restoreCheckpoint({
        cwd: repository.path,
        checkpointRef,
        fallbackToHead,
      });
      return { restored, skipped: restored ? [] : [repository] };
    }
    const available = yield* checkpointRepositoriesWithRef(store, repositories, checkpointRef);
    const restored = yield* Effect.forEach(
      repositories.filter(
        (repository) =>
          available.includes(repository) || (fallbackToHead && repository.relativePath === "."),
      ),
      (repository) =>
        store
          .restoreCheckpoint({
            cwd: repository.path,
            checkpointRef: scopedCheckpointRef(checkpointRef, repository),
            fallbackToHead: fallbackToHead && repository.relativePath === ".",
            excludePaths: nestedCheckpointPaths(repository, repositories, "restore"),
          })
          .pipe(Effect.map((ok) => (ok ? repository : null))),
    );
    return {
      restored: restored.length > 0 && restored.every((repository) => repository !== null),
      skipped: repositories.filter((repository) => !restored.includes(repository)),
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
    (repository) =>
      pruneCheckpointRefs(store, {
        cwd: repository.path,
        checkpointRefs: checkpointRefs.map((ref) => scopedCheckpointRef(ref, repository)),
      }),
    { concurrency: 4, discard: true },
  );
}
