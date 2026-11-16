import { Effect, Layer } from "effect";
import { WorktreePreparations } from "../persistence/Services/WorktreePreparations.ts";
import { makeMemoryWorktreePreparations } from "../persistence/worktreePreparations.testUtils.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";

export const WorktreePreparationsTestLive = Layer.effect(
  WorktreePreparations,
  Effect.sync(makeMemoryWorktreePreparations),
);
export const GitCoreTestLive = GitCoreLive.pipe(Layer.provide(WorktreePreparationsTestLive));
