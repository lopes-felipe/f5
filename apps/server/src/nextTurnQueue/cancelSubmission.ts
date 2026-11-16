import type { CommandId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import type { NextTurnQueueStoreShape } from "./Services/NextTurnQueueStore.ts";

/** Cancellation never interrupts work already admitted by orchestration. */
export function cancelQueuedSubmission<E>(
  store: NextTurnQueueStoreShape,
  notify: (threadId: ThreadId) => Effect.Effect<void, E>,
  submissionId: CommandId,
) {
  return Effect.gen(function* () {
    const record = yield* store.getBySubmissionId(submissionId);
    if (!record) return "none" as const;
    const data = yield* store.listByThread(record.threadId);
    const item = data.items.find((entry) => entry.submissionId === submissionId);
    if (!item) return record.disposition === "started" ? ("started" as const) : ("none" as const);
    const removed = yield* store.softDelete({ itemId: item.itemId }).pipe(
      Effect.catchTags({
        NextTurnQueueItemDispatchingError: () => Effect.succeed(null),
        NextTurnQueueItemAlreadyRanError: () => Effect.succeed(null),
      }),
    );
    if (!removed) return "started" as const;
    yield* notify(removed.threadId);
    return "canceled" as const;
  });
}
