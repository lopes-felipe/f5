import { Effect } from "effect";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { WorkspaceWriteContext } from "../../project/workspaceTransitionContext.ts";

/** Reactor fixtures inject committed workspace changes without running a UI transition. */
export const withFixtureWorkspaceWrites = (
  engine: OrchestrationEngineShape,
): OrchestrationEngineShape => ({
  ...engine,
  dispatch: (command) =>
    Effect.gen(function* () {
      if (
        command.type !== "thread.meta.update" ||
        (command.branch === undefined && command.worktreePath === undefined)
      )
        return yield* engine.dispatch(command);
      const thread = (yield* engine.getReadModel()).threads.find(
        (entry) => entry.id === command.threadId,
      );
      if (!thread) return yield* engine.dispatch(command);
      return yield* engine.dispatch(command).pipe(
        Effect.provideService(WorkspaceWriteContext, {
          expected: {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            sessionUpdatedAt: thread.session?.updatedAt ?? null,
          },
        }),
      );
    }),
});
