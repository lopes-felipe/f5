/**
 * Narrow workspace-root lookups backed by orchestration projection tables.
 *
 * Callers that only need a filesystem root must not hydrate the complete
 * orchestration read model: that snapshot includes retained history for every
 * thread and is intentionally heavyweight.
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionProjectWorkspace {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

export interface ProjectionThreadWorkspace {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

export interface ProjectionWorkspaceQueryShape {
  readonly getProjectWorkspace: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ProjectionProjectWorkspace>, ProjectionRepositoryError>;

  readonly getThreadWorkspace: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadWorkspace>, ProjectionRepositoryError>;

  /**
   * Resolve a live thread's owning project without requiring that project to
   * be live. Authorization callers use this identity lookup before selecting
   * any caller-supplied project root.
   */
  readonly getThreadProjectId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectId>, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceQuery extends ServiceMap.Service<
  ProjectionWorkspaceQuery,
  ProjectionWorkspaceQueryShape
>()("t3/orchestration/Services/ProjectionWorkspaceQuery") {}
