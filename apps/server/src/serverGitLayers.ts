import { WorktreePreparationsLive } from "./persistence/Layers/WorktreePreparations.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { Layer } from "effect";

import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLiveWithGitService } from "./checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitServiceLive } from "./git/Layers/GitService.ts";
import { ProjectionCheckpointRepositoryLive } from "./persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads.ts";

// Both consumers must receive the configured service. Layer memoization otherwise
// lets checkpointing create GitServiceLive without secrets before GitCore needs it.
export const ServerGitLive = Layer.mergeAll(
  CheckpointStoreLiveWithGitService,
  GitCoreLive.pipe(Layer.provide(WorktreePreparationsLive), Layer.provide(ServerSettingsLive)),
).pipe(Layer.provideMerge(GitServiceLive.pipe(Layer.provideMerge(ServerSecretStoreLive))));

/** Compose the Git and checkpoint-query dependencies shared by both server runtimes. */
export function makeServerGitLayers() {
  const gitLayer = ServerGitLive;
  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(ProjectionCheckpointRepositoryLive),
    Layer.provideMerge(gitLayer),
  );
  return { gitLayer, checkpointDiffQueryLayer };
}
