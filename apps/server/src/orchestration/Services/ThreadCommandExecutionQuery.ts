import type {
  OrchestrationGetThreadCommandExecutionInput,
  OrchestrationGetThreadCommandExecutionResult,
  OrchestrationGetThreadCommandExecutionsInput,
  OrchestrationGetThreadCommandExecutionsResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ThreadCommandExecutionQueryShape {
  readonly getThreadCommandExecutions: (
    input: OrchestrationGetThreadCommandExecutionsInput,
  ) => Effect.Effect<OrchestrationGetThreadCommandExecutionsResult, ProjectionRepositoryError>;
  readonly getThreadCommandExecution: (
    input: OrchestrationGetThreadCommandExecutionInput,
  ) => Effect.Effect<OrchestrationGetThreadCommandExecutionResult, ProjectionRepositoryError>;
}

export class ThreadCommandExecutionQuery extends ServiceMap.Service<
  ThreadCommandExecutionQuery,
  ThreadCommandExecutionQueryShape
>()("t3/orchestration/Services/ThreadCommandExecutionQuery") {}
