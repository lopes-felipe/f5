import { Effect, Layer, Option } from "effect";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";

import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  ProjectionWorkspaceQuery,
  type ProjectionWorkspaceQueryShape,
} from "../Services/ProjectionWorkspaceQuery.ts";

const makeProjectionWorkspaceQuery = Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;

  const getProjectWorkspace: ProjectionWorkspaceQueryShape["getProjectWorkspace"] = (projectId) =>
    projects.getById({ projectId }).pipe(
      Effect.map(
        Option.flatMap((project) =>
          project.deletedAt === null
            ? Option.some({
                projectId: project.projectId,
                kind: project.kind ?? "standard",
                workspaceRoot: project.workspaceRoot,
              })
            : Option.none(),
        ),
      ),
    );

  const getThreadProjectId: ProjectionWorkspaceQueryShape["getThreadProjectId"] = (threadId) =>
    threads
      .getById({ threadId })
      .pipe(
        Effect.map(
          Option.flatMap((thread) =>
            thread.deletedAt === null ? Option.some(thread.projectId) : Option.none(),
          ),
        ),
      );

  const getThreadWorkspace: ProjectionWorkspaceQueryShape["getThreadWorkspace"] = (threadId) =>
    Effect.gen(function* () {
      const threadOption = yield* threads.getById({ threadId });
      if (Option.isNone(threadOption) || threadOption.value.deletedAt !== null) {
        return Option.none();
      }

      const thread = threadOption.value;
      const projectOption = yield* getProjectWorkspace(thread.projectId);
      return Option.flatMap(projectOption, (project) =>
        Option.map(Option.fromNullishOr(threadWorkspaceCwd(thread, project)), (workspaceRoot) => ({
          threadId: thread.threadId,
          projectId: thread.projectId,
          workspaceRoot,
          scratch: isScratchProject(project),
        })),
      );
    });

  return {
    getProjectWorkspace,
    getThreadProjectId,
    getThreadWorkspace,
  } satisfies ProjectionWorkspaceQueryShape;
});

export const ProjectionWorkspaceQueryLive = Layer.effect(
  ProjectionWorkspaceQuery,
  makeProjectionWorkspaceQuery,
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
);
