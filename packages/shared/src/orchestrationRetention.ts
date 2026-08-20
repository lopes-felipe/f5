/**
 * Shared in-memory retention budgets for orchestration thread projections.
 *
 * The server and web client must apply the same limits so a live thread does
 * not retain more history than the same thread after a reload.
 */
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 100;
export const MAX_THREAD_CHECKPOINTS = 500;
