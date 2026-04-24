import type {
  OrchestrationGetThreadFileChangeResult,
  OrchestrationGetThreadFileChangesResult,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProjectionThreadFileChangeRepository } from "../../persistence/Services/ProjectionThreadFileChanges.ts";
import {
  ThreadFileChangeQuery,
  type ThreadFileChangeQueryShape,
} from "../Services/ThreadFileChangeQuery.ts";

const makeThreadFileChangeQuery = Effect.gen(function* () {
  const projectionThreadFileChangeRepository = yield* ProjectionThreadFileChangeRepository;

  const getThreadFileChanges: ThreadFileChangeQueryShape["getThreadFileChanges"] = (input) =>
    Effect.gen(function* () {
      const latestSequence =
        yield* projectionThreadFileChangeRepository.getLatestSequenceByThreadId({
          threadId: input.threadId,
        });
      const fileChanges =
        input.afterSequenceExclusive === undefined
          ? yield* projectionThreadFileChangeRepository.listByThreadId({
              threadId: input.threadId,
            })
          : yield* projectionThreadFileChangeRepository.listByThreadIdAfterSequence({
              threadId: input.threadId,
              afterSequenceExclusive: input.afterSequenceExclusive,
            });

      return {
        threadId: input.threadId,
        fileChanges,
        latestSequence,
        isFullSync: input.afterSequenceExclusive === undefined,
      } satisfies OrchestrationGetThreadFileChangesResult;
    });

  const getThreadFileChange: ThreadFileChangeQueryShape["getThreadFileChange"] = (input) =>
    Effect.gen(function* () {
      const fileChange = yield* projectionThreadFileChangeRepository.getById({
        threadId: input.threadId,
        fileChangeId: input.fileChangeId,
      });
      return {
        fileChange,
      } satisfies OrchestrationGetThreadFileChangeResult;
    });

  return {
    getThreadFileChanges,
    getThreadFileChange,
  } satisfies ThreadFileChangeQueryShape;
});

export const ThreadFileChangeQueryLive = Layer.effect(
  ThreadFileChangeQuery,
  makeThreadFileChangeQuery,
);
