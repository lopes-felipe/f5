/**
 * Retention limits for the in-memory orchestration read model.
 *
 * Warm-start snapshots should mirror these bounds so startup hydration does
 * not load more history than the live projector keeps after new events arrive.
 */
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;
export const MAX_THREAD_CHECKPOINTS = 500;
