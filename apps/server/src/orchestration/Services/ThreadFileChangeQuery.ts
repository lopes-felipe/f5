import type {
  OrchestrationGetThreadFileChangeInput,
  OrchestrationGetThreadFileChangeResult,
  OrchestrationGetThreadFileChangesInput,
  OrchestrationGetThreadFileChangesResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ThreadFileChangeQueryShape {
  readonly getThreadFileChanges: (
    input: OrchestrationGetThreadFileChangesInput,
  ) => Effect.Effect<OrchestrationGetThreadFileChangesResult, ProjectionRepositoryError>;
  readonly getThreadFileChange: (
    input: OrchestrationGetThreadFileChangeInput,
  ) => Effect.Effect<OrchestrationGetThreadFileChangeResult, ProjectionRepositoryError>;
}

export class ThreadFileChangeQuery extends ServiceMap.Service<
  ThreadFileChangeQuery,
  ThreadFileChangeQueryShape
>()("t3/orchestration/Services/ThreadFileChangeQuery") {}
