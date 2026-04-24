import type {
  OrchestrationGetThreadCommandExecutionResult,
  OrchestrationGetThreadCommandExecutionsResult,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProjectionThreadCommandExecutionRepository } from "../../persistence/Services/ProjectionThreadCommandExecutions.ts";
import {
  ThreadCommandExecutionQuery,
  type ThreadCommandExecutionQueryShape,
} from "../Services/ThreadCommandExecutionQuery.ts";

const makeThreadCommandExecutionQuery = Effect.gen(function* () {
  const projectionThreadCommandExecutionRepository =
    yield* ProjectionThreadCommandExecutionRepository;

  const getThreadCommandExecutions: ThreadCommandExecutionQueryShape["getThreadCommandExecutions"] =
    (input) =>
      Effect.gen(function* () {
        const latestSequence =
          yield* projectionThreadCommandExecutionRepository.getLatestSequenceByThreadId({
            threadId: input.threadId,
          });
        const executions =
          input.afterSequenceExclusive === undefined
            ? yield* projectionThreadCommandExecutionRepository.listByThreadId({
                threadId: input.threadId,
              })
            : yield* projectionThreadCommandExecutionRepository.listByThreadIdAfterSequence({
                threadId: input.threadId,
                afterSequenceExclusive: input.afterSequenceExclusive,
              });

        return {
          threadId: input.threadId,
          executions,
          latestSequence,
          isFullSync: input.afterSequenceExclusive === undefined,
        } satisfies OrchestrationGetThreadCommandExecutionsResult;
      });

  const getThreadCommandExecution: ThreadCommandExecutionQueryShape["getThreadCommandExecution"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const commandExecution = yield* projectionThreadCommandExecutionRepository.getById({
        commandExecutionId: input.commandExecutionId,
      });

      return {
        commandExecution: commandExecution?.threadId === input.threadId ? commandExecution : null,
      } satisfies OrchestrationGetThreadCommandExecutionResult;
    });

  return {
    getThreadCommandExecutions,
    getThreadCommandExecution,
  } satisfies ThreadCommandExecutionQueryShape;
});

export const ThreadCommandExecutionQueryLive = Layer.effect(
  ThreadCommandExecutionQuery,
  makeThreadCommandExecutionQuery,
);
