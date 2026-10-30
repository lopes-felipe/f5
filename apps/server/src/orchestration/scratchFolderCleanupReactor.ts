import type { ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Stream, type Scope } from "effect";

import { makeBackgroundWorker } from "../backgroundWorker.ts";
import { removeScratchThreadFolder } from "../project/scratchFolderCleanup.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/** Subscribe before replaying persisted deletions, with one scoped, deduplicated removal worker. */
export function startScratchFolderCleanupReactor(
  orchestrationEngine: OrchestrationEngineShape,
  remove?: (folder: string) => Promise<void>,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const pending = new Set<ThreadId>();
    const worker = yield* makeBackgroundWorker(
      (threadId: ThreadId) =>
        Effect.gen(function* () {
          const delays = [1_000, 5_000, 30_000];
          for (let attempt = 0; ; attempt++) {
            const readModel = yield* orchestrationEngine.getReadModel();
            const result = yield* Effect.tryPromise(() =>
              removeScratchThreadFolder({ readModel, threadId, ...(remove ? { remove } : {}) }),
            ).pipe(Effect.result);
            if (result._tag === "Success") {
              if (result.success.kind === "refused") {
                yield* Effect.logWarning("scratch folder cleanup refused", {
                  threadId,
                  reason: result.success.reason,
                });
              }
              return;
            }
            const delay = delays[attempt];
            if (delay === undefined) {
              yield* Effect.logWarning(
                "could not remove a deleted thread's scratch folder; metadata retained for retry",
                {
                  threadId,
                  error: result.failure,
                },
              );
              return;
            }
            yield* Effect.sleep(delay);
          }
        }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(threadId)))),
      { name: "ScratchFolderCleanup", key: (threadId) => threadId },
    );
    const enqueue = (threadId: ThreadId) =>
      Effect.suspend(() => {
        if (pending.has(threadId)) return Effect.void;
        pending.add(threadId);
        return worker.enqueue(threadId);
      });
    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      event.type === "thread.deleted" ? enqueue(event.payload.threadId) : Effect.void,
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.gen(function* () {
      const model = yield* orchestrationEngine.getReadModel();
      for (const thread of model.threads) {
        if (thread.deletedAt !== null && thread.scratchPath) yield* enqueue(thread.id);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not replay scratch folder cleanup", { cause }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  });
}
