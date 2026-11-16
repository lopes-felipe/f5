import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { PreparationError } from "../../persistence/Services/WorktreePreparations.ts";

export interface PrepareThreadWorktree {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly branch: string;
  /** Explicit retry acknowledges that an interrupted script may have external effects. */
  readonly retry?: boolean;
}
export interface WorktreePreparationShape {
  readonly needsPreparation: (path: string) => Effect.Effect<boolean, PreparationError>;
  readonly prepare: (input: PrepareThreadWorktree) => Effect.Effect<void, PreparationError>;
  readonly startBackground: (
    input: PrepareThreadWorktree,
    notify: () => Effect.Effect<void>,
  ) => Effect.Effect<void, PreparationError>;
  readonly startup: Effect.Effect<void, PreparationError>;
}
export class WorktreePreparation extends ServiceMap.Service<
  WorktreePreparation,
  WorktreePreparationShape
>()("t3/project/Services/WorktreePreparation") {}
