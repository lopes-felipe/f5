import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { OrchestrationCommand, WorkspaceExpectedContext } from "@t3tools/contracts";
import { Effect, ServiceMap } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/** Server-only capability, captured in the engine envelope; never accepted from the wire. */
export interface WorkspaceWrite {
  readonly expected: typeof WorkspaceExpectedContext.Type;
  readonly operationId?: string;
  readonly version?: number;
  readonly observation?: boolean;
}
export const WorkspaceWriteContext = ServiceMap.Reference<WorkspaceWrite | null>(
  "f5/WorkspaceWriteContext",
  { defaultValue: () => null },
);

/** Trusted branch observers and creation handoffs must prove the checkout and CAS its old reference. */
export const dispatchVerifiedWorkspace = (
  engine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">,
  git: Pick<GitCoreShape, "inspectCheckoutIdentity">,
  command: Extract<OrchestrationCommand, { type: "thread.meta.update" }>,
  options: { allowMissing?: boolean; observation?: boolean } = {},
) =>
  Effect.gen(function* () {
    const model = yield* engine.getReadModel();
    const thread = model.threads.find((entry) => entry.id === command.threadId);
    const project = model.projects.find((entry) => entry.id === thread?.projectId);
    if (!thread || (!project && !options.allowMissing))
      return yield* Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Unknown workspace owner.",
        }),
      );
    const path = command.worktreePath === undefined ? thread.worktreePath : command.worktreePath;
    const branch = command.branch === undefined ? thread.branch : command.branch;
    if (options.observation && path !== thread.worktreePath)
      return yield* Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A branch observer cannot change the workspace path.",
        }),
      );
    if (!options.allowMissing) {
      const identity = yield* git.inspectCheckoutIdentity(path ?? project!.workspaceRoot);
      if (identity.branch !== branch)
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The observed checkout branch changed.",
          }),
        );
    }
    return yield* engine.dispatch(command).pipe(
      Effect.provideService(WorkspaceWriteContext, {
        expected: {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          sessionUpdatedAt: thread.session?.updatedAt ?? null,
        },
        observation: options.observation ?? false,
      }),
    );
  });
