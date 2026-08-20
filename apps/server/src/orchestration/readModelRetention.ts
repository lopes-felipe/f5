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
