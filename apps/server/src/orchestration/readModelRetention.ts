/**
 * Retention limits for the in-memory orchestration read model.
 *
 * Warm-start snapshots should mirror these bounds so startup hydration does
 * not load more history than the live projector keeps after new events arrive.
 */
export {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "@t3tools/shared/orchestrationRetention";

/**
 * Hard ceiling for activities materialized by a database-backed read-model
 * snapshot. The per-thread rank is used as the primary global sort key so the
 * budget is distributed fairly across threads instead of starving older
 * threads entirely.
 */
export const MAX_READ_MODEL_ACTIVITIES = 200_000;

import { READ_MODEL_MESSAGE_WARNING_THRESHOLD } from "@t3tools/shared/orchestrationRetention";
import { Effect } from "effect";

export const observeReadModelRetention = (
  model: {
    readonly threads: ReadonlyArray<{
      readonly messages: ReadonlyArray<{
        readonly text: string;
        readonly reasoningText?: string | undefined;
      }>;
    }>;
  },
  /** `heapUsed` sampled before hydrate; the log reports the change across it. */
  heapUsedBeforeBytes?: number,
) => {
  let messages = 0;
  let characters = 0;
  for (const thread of model.threads)
    for (const message of thread.messages) {
      messages++;
      characters += message.text.length + (message.reasoningText?.length ?? 0);
    }
  const fields = {
    threads: model.threads.length,
    messages,
    characters,
    ...(heapUsedBeforeBytes === undefined
      ? {}
      : { heapUsedDeltaBytes: process.memoryUsage().heapUsed - heapUsedBeforeBytes }),
  };
  return messages > READ_MODEL_MESSAGE_WARNING_THRESHOLD
    ? Effect.logWarning("orchestration read model exceeds message warning threshold", fields)
    : Effect.logInfo("orchestration read model hydrated", fields);
};
